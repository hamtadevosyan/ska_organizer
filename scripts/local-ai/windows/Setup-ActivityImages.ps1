#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$TestGeneration,
    [switch]$CompareSDXL,
    [switch]$SimplePrompts,
    [switch]$GuidedLayout,
    [ValidateSet(1, 4)][int]$Count = 1,
    [string]$ArchivePath,
    [string]$RefreshReview
)

$ErrorActionPreference = 'Stop'

function Get-SkaoImageContext {
    if ($env:OS -ne 'Windows_NT' -or ![Environment]::Is64BitOperatingSystem) {
        throw 'IMG_PLATFORM: This setup requires 64-bit Windows.'
    }
    if (!$env:LOCALAPPDATA) { throw 'IMG_ACCOUNT: LOCALAPPDATA is unavailable for this account.' }
    return [pscustomobject]@{
        Root = (Join-Path $env:LOCALAPPDATA 'SKAO-ActivityImages')
        Manifest = (Join-Path $PSScriptRoot '..\image-downloads.json')
        Runner = (Join-Path $PSScriptRoot 'run-activity-images.py')
        Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    }
}

function Assert-SkaoImageOrdinaryPath {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Directory)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($Directory -and !$item.PSIsContainer) -or (!$Directory -and $item.PSIsContainer)) {
        throw 'IMG_PATH: An installation path is not an ordinary file or directory.'
    }
    return $item
}

function Read-SkaoImageJson {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Assert-SkaoImageOrdinaryPath -Path $Path
    if ($item.Length -gt 65536) { throw 'IMG_STATE: Installation metadata is too large.' }
    try { return ([IO.File]::ReadAllText($item.FullName) | ConvertFrom-Json) }
    catch { throw 'IMG_STATE: Installation metadata is not valid JSON.' }
}

function Assert-SkaoImageManifest {
    param([Parameter(Mandatory = $true)]$Manifest)
    if (($Manifest.schemaVersion -isnot [int] -and $Manifest.schemaVersion -isnot [long]) -or $Manifest.schemaVersion -cne 1 -or
        [string]$Manifest.comfy.version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$' -or
        [string]$Manifest.comfy.assetName -cne 'ComfyUI_windows_portable_nvidia_cu126.7z') {
        throw 'IMG_MANIFEST: Expected the pinned legacy CUDA 12.6 portable package.'
    }
    $archiveUrl = 'https://github.com/Comfy-Org/ComfyUI/releases/download/' +
        [string]$Manifest.comfy.version + '/ComfyUI_windows_portable_nvidia_cu126.7z'
    if ([string]$Manifest.comfy.url -cne $archiveUrl -or
        [string]$Manifest.model.fileName -cne 'v1-5-pruned-emaonly.safetensors' -or
        [string]$Manifest.model.revision -notmatch '^[a-f0-9]{40}$') {
        throw 'IMG_MANIFEST: A download location or model filename is not the expected official pinned asset.'
    }
    $modelUrl = 'https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/' +
        [string]$Manifest.model.revision + '/v1-5-pruned-emaonly.safetensors'
    if ([string]$Manifest.model.url -cne $modelUrl) {
        throw 'IMG_MANIFEST: The SD1.5 checkpoint must use its pinned official revision.'
    }
    if ([string]$Manifest.extractor.version -notmatch '^[0-9]{2}\.[0-9]{2}$' -or
        [string]$Manifest.extractor.assetName -cne '7zr.exe' -or
        [string]$Manifest.extractor.url -cne ('https://github.com/ip7z/7zip/releases/download/' + [string]$Manifest.extractor.version + '/7zr.exe')) {
        throw 'IMG_MANIFEST: The fallback extractor must use a pinned official 7-Zip release.'
    }
    foreach ($entry in @($Manifest.comfy, $Manifest.model, $Manifest.extractor)) {
        if ([string]$entry.sha256 -notmatch '^[a-f0-9]{64}$' -or
            ($entry.sizeBytes -isnot [int] -and $entry.sizeBytes -isnot [long]) -or
            [double]$entry.sizeBytes -lt 1 -or [double]$entry.sizeBytes -gt 21474836480) {
            throw 'IMG_MANIFEST: Each asset needs a verified SHA-256 and bounded exact byte count.'
        }
    }
}

function Get-SkaoImagePins {
    param([Parameter(Mandatory = $true)]$Manifest)
    return [pscustomobject][ordered]@{
        schemaVersion = 1
        version = [string]$Manifest.comfy.version
        archiveSha256 = [string]$Manifest.comfy.sha256
        archiveBytes = [long]$Manifest.comfy.sizeBytes
        modelFile = [string]$Manifest.model.fileName
        modelSha256 = [string]$Manifest.model.sha256
        modelBytes = [long]$Manifest.model.sizeBytes
        modelRevision = [string]$Manifest.model.revision
        extractorVersion = [string]$Manifest.extractor.version
        extractorSha256 = [string]$Manifest.extractor.sha256
        extractorBytes = [long]$Manifest.extractor.sizeBytes
    }
}

function Get-SkaoImageComparisonAsset {
    param([Parameter(Mandatory = $true)]$Manifest)
    $asset = $Manifest.comparison
    if ($null -eq $asset -or
        [string]$asset.fileName -cne 'sd_xl_base_1.0.safetensors' -or
        [string]$asset.revision -cne '462165984030d82259a11f4367a4eed129e94a7b' -or
        [string]$asset.url -cne 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/462165984030d82259a11f4367a4eed129e94a7b/sd_xl_base_1.0.safetensors' -or
        [string]$asset.sha256 -cne '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b' -or
        ($asset.sizeBytes -isnot [int] -and $asset.sizeBytes -isnot [long]) -or
        [long]$asset.sizeBytes -ne 6938078334) {
        throw 'IMG_COMPARISON_MANIFEST: Use the complete SDXL comparison package with its verified official checkpoint metadata.'
    }
    return $asset
}

function Get-SkaoImageGuidanceAsset {
    param([Parameter(Mandatory = $true)]$Manifest)
    $asset = $Manifest.guidance
    if ($null -eq $asset -or
        [string]$asset.fileName -cne 'control-lora-canny-rank128.safetensors' -or
        [string]$asset.revision -cne '75590eb0e7868d3d0f1581b5126d487b33c7fdb4' -or
        [string]$asset.url -cne 'https://huggingface.co/stabilityai/control-lora/resolve/75590eb0e7868d3d0f1581b5126d487b33c7fdb4/control-LoRAs-rank128/control-lora-canny-rank128.safetensors' -or
        [string]$asset.sha256 -cne '56389dbb245ca44de91d662529bd4298abc55ce2318f60bc19454fb72ff68247' -or
        ($asset.sizeBytes -isnot [int] -and $asset.sizeBytes -isnot [long]) -or
        [long]$asset.sizeBytes -ne 395733680) {
        throw 'IMG_GUIDANCE_MANIFEST: Use the complete guided image package with its verified official Control-LoRA metadata.'
    }
    return $asset
}

function Assert-SkaoImagePins {
    param([Parameter(Mandatory = $true)]$Actual, [Parameter(Mandatory = $true)]$Expected)
    foreach ($key in @('schemaVersion', 'version', 'archiveSha256', 'archiveBytes',
            'modelFile', 'modelSha256', 'modelBytes', 'modelRevision',
            'extractorVersion', 'extractorSha256', 'extractorBytes')) {
        if ([string]$Actual.$key -cne [string]$Expected.$key) {
            throw 'IMG_CONFLICT: Existing installation uses different assets; it was preserved.'
        }
    }
}

function Assert-SkaoImageFile {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][string]$Sha256,
          [Parameter(Mandatory = $true)][long]$SizeBytes)
    $item = Assert-SkaoImageOrdinaryPath -Path $Path
    if ($item.Length -ne $SizeBytes -or
        (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha256) {
        throw 'IMG_HASH: An asset differs from its pinned byte count or SHA-256; it was preserved.'
    }
}

function Write-SkaoImageJson {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    if (Test-Path -LiteralPath $Path) { throw 'IMG_CONFLICT: Refusing to replace existing installation metadata.' }
    $temporary = $Path + '.new-' + [Guid]::NewGuid().ToString('N')
    try {
        [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Value -Depth 8),
            (New-Object Text.UTF8Encoding($false)))
        [IO.File]::Move($temporary, $Path)
    }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Set-SkaoImageDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][string]$Sid)
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $owner = New-Object Security.Principal.SecurityIdentifier($Sid)
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($value in @($Sid, 'S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($value)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Get-SkaoImageExtractor {
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles '7-Zip\7z.exe' }
    $command = Get-Command '7z.exe' -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            [void](Assert-SkaoImageOrdinaryPath -Path $candidate)
            return $candidate
        }
    }
    return $null
}

function Assert-SkaoImageDiskSpace {
    param([Parameter(Mandatory = $true)][string]$Root,
          [Parameter(Mandatory = $true)]$Manifest)
    $volume = New-Object IO.DriveInfo([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Root)))
    # Keep both pinned downloads, an extracted staging tree and the published checkpoint.
    $required = [Math]::Max(21474836480, ([long]$Manifest.comfy.sizeBytes * 6 + [long]$Manifest.model.sizeBytes * 2))
    if (!$volume.IsReady -or $volume.AvailableFreeSpace -lt $required) {
        throw ('IMG_DISK: At least {0:N1} GiB free disk space is required for this isolated image test.' -f ($required / 1073741824))
    }
}

function Assert-SkaoImageComparisonDiskSpace {
    param([Parameter(Mandatory = $true)][string]$Root,
          [Parameter(Mandatory = $true)]$Asset,
          [Parameter(Mandatory = $true)][string]$CachePath)
    $volume = New-Object IO.DriveInfo([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Root)))
    $required = [long]$Asset.sizeBytes + 1073741824
    if (!(Test-Path -LiteralPath $CachePath)) { $required += [long]$Asset.sizeBytes }
    if (!$volume.IsReady -or $volume.AvailableFreeSpace -lt $required) {
        throw ('IMG_DISK: At least {0:N1} GiB free disk space is required to add the SDXL comparison checkpoint.' -f ($required / 1073741824))
    }
}

function Assert-SkaoImageGuidanceDiskSpace {
    param([Parameter(Mandatory = $true)][string]$Root,
          [Parameter(Mandatory = $true)]$Asset,
          [Parameter(Mandatory = $true)][string]$CachePath)
    $volume = New-Object IO.DriveInfo([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Root)))
    $required = [long]$Asset.sizeBytes + 1073741824
    if (!(Test-Path -LiteralPath $CachePath)) { $required += [long]$Asset.sizeBytes }
    if (!$volume.IsReady -or $volume.AvailableFreeSpace -lt $required) {
        throw ('IMG_DISK: At least {0:N1} GiB free disk space is required to add the guided image model.' -f ($required / 1073741824))
    }
}

function New-SkaoImageDownloadRequest {
    param([Parameter(Mandatory = $true)][string]$Url)
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.Timeout = 60000
    $request.ReadWriteTimeout = 60000
    $request.AllowAutoRedirect = $true
    $request.MaximumAutomaticRedirections = 10
    $request.UserAgent = 'SKAO-ActivityImages-Setup/1'
    $request.KeepAlive = $false
    return $request
}

function Save-SkaoImageDownload {
    param([Parameter(Mandatory = $true)]$Asset,
          [Parameter(Mandatory = $true)][string]$Destination)
    if (Test-Path -LiteralPath $Destination) {
        Assert-SkaoImageFile -Path $Destination -Sha256 $Asset.sha256 -SizeBytes $Asset.sizeBytes
        return
    }
    $temporary = $Destination + '.partial'
    if (Test-Path -LiteralPath $temporary) {
        [void](Assert-SkaoImageOrdinaryPath -Path $temporary)
        Remove-Item -LiteralPath $temporary -Force
    }
    $request = New-SkaoImageDownloadRequest -Url ([string]$Asset.url)
    $response = $null; $inputStream = $null; $outputStream = $null
    $oldProtocol = [Net.ServicePointManager]::SecurityProtocol
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        # PowerShell 5.1 hosts can otherwise retain old .NET TLS defaults.
        [Net.ServicePointManager]::SecurityProtocol = $oldProtocol -bor [Net.SecurityProtocolType]::Tls12
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200 -or $response.ResponseUri.Scheme -cne 'https' -or
            ($response.ContentLength -ge 0 -and $response.ContentLength -ne [long]$Asset.sizeBytes)) {
            throw 'IMG_DOWNLOAD: The asset response does not match the pinned download.'
        }
        $inputStream = $response.GetResponseStream()
        $outputStream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] 1048576
        $total = [long]0; $nextProgress = [long]67108864
        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $read
            if ($total -gt [long]$Asset.sizeBytes -or $clock.Elapsed.TotalHours -gt 2) {
                throw 'IMG_DOWNLOAD: The asset exceeded its byte count or two-hour download limit.'
            }
            $outputStream.Write($buffer, 0, $read)
            if ($total -ge $nextProgress) {
                Write-Output ('Downloading: {0:N0} / {1:N0} MiB' -f ($total / 1048576), ([long]$Asset.sizeBytes / 1048576))
                $nextProgress = $total + 67108864
            }
        }
        $outputStream.Dispose(); $outputStream = $null
        Assert-SkaoImageFile -Path $temporary -Sha256 $Asset.sha256 -SizeBytes $Asset.sizeBytes
        [IO.File]::Move($temporary, $Destination)
    }
    finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
        [Net.ServicePointManager]::SecurityProtocol = $oldProtocol
    }
}

function Assert-SkaoImageArchiveListing {
    # 7-Zip separates technical listing records with empty lines. Let those
    # reach parsing; a missing/empty listing still fails the path-count check.
    param([Parameter(Mandatory = $true)][AllowEmptyString()][AllowEmptyCollection()][string[]]$Lines)
    $paths = @($Lines | Where-Object { $_ -cmatch '^Path = ' } | ForEach-Object { $_.Substring(7).Replace('\', '/') })
    if ($paths.Count -eq 0 -or $paths.Count -gt 250000) {
        throw 'IMG_ARCHIVE: The archive does not contain the expected portable directory.'
    }
    foreach ($path in $paths) {
        if ($path -cne 'ComfyUI_windows_portable' -and !$path.StartsWith('ComfyUI_windows_portable/', [StringComparison]::Ordinal)) {
            throw 'IMG_ARCHIVE: The archive contains a path outside the portable directory.'
        }
        if ($path -match '(^|/)\.\.?(/|$)' -or $path -match '[:\x00]' -or $path.Contains('//')) {
            throw 'IMG_ARCHIVE: The archive contains an unsafe path.'
        }
    }
    if (@($Lines | Where-Object { $_ -match '^(Symbolic Link|Hard Link) = .+' }).Count -gt 0) {
        throw 'IMG_ARCHIVE: Linked archive entries are not supported.'
    }
}

function Expand-SkaoImageArchive {
    param([Parameter(Mandatory = $true)][string]$Extractor,
          [Parameter(Mandatory = $true)][string]$Archive,
          [Parameter(Mandatory = $true)][string]$Destination)
    $listing = @(& $Extractor 'l' '-slt' '-ba' '--' $Archive 2>&1 | ForEach-Object { [string]$_ })
    if ($LASTEXITCODE -ne 0) { throw 'IMG_ARCHIVE: 7-Zip could not verify the archive listing.' }
    Assert-SkaoImageArchiveListing -Lines $listing
    & $Extractor 'x' '-y' '-bd' '-bso0' '-bsp0' ('-o' + $Destination) '--' $Archive
    if ($LASTEXITCODE -ne 0) { throw 'IMG_ARCHIVE: 7-Zip could not extract the verified archive.' }
}

function Get-SkaoImageRuntimeFiles {
    return @('python_embeded/python.exe', 'ComfyUI/main.py', 'ComfyUI/comfy/cli_args.py')
}

function Get-SkaoImageReceipt {
    param([Parameter(Mandatory = $true)][string]$Portable, [Parameter(Mandatory = $true)]$Pins)
    $files = @()
    foreach ($relative in (Get-SkaoImageRuntimeFiles)) {
        $item = Assert-SkaoImageOrdinaryPath -Path (Join-Path $Portable $relative)
        $files += [pscustomobject]@{ path = $relative; bytes = $item.Length;
            sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    return [pscustomobject]@{ schemaVersion = 1; pins = $Pins; files = $files }
}

function Assert-SkaoImageRuntime {
    param([Parameter(Mandatory = $true)][string]$Portable, [Parameter(Mandatory = $true)]$Pins)
    [void](Assert-SkaoImageOrdinaryPath -Path $Portable -Directory)
    $receipt = Read-SkaoImageJson -Path (Join-Path $Portable 'skao-installation.json')
    if ($receipt.schemaVersion -cne 1) { throw 'IMG_STATE: The installed runtime receipt is unsupported.' }
    Assert-SkaoImagePins -Actual $receipt.pins -Expected $Pins
    $expectedFiles = @(Get-SkaoImageRuntimeFiles)
    if (@($receipt.files).Count -ne $expectedFiles.Count) { throw 'IMG_STATE: The runtime receipt is incomplete.' }
    foreach ($relative in $expectedFiles) {
        $entries = @($receipt.files | Where-Object { [string]$_.path -ceq $relative })
        if ($entries.Count -ne 1 -or [string]$entries[0].sha256 -notmatch '^[a-f0-9]{64}$' -or
            [long]$entries[0].bytes -lt 1) { throw 'IMG_STATE: A runtime receipt entry is invalid.' }
        Assert-SkaoImageFile -Path (Join-Path $Portable $relative) -Sha256 $entries[0].sha256 -SizeBytes $entries[0].bytes
    }
    Assert-SkaoImageFile -Path (Join-Path $Portable ('ComfyUI/models/checkpoints/' + $Pins.modelFile)) `
        -Sha256 $Pins.modelSha256 -SizeBytes $Pins.modelBytes
}

function Assert-SkaoImageRoot {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)]$Pins)
    if (!(Test-Path -LiteralPath $Root)) { return }
    [void](Assert-SkaoImageOrdinaryPath -Path $Root -Directory)
    $children = @(Get-ChildItem -LiteralPath $Root -Force)
    if ($children.Count -eq 0) { return }
    $statePath = Join-Path $Root 'setup-state.json'
    if (!(Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw 'IMG_CONFLICT: The destination is not a recognized image installation; it was preserved.'
    }
    Assert-SkaoImagePins -Actual (Read-SkaoImageJson -Path $statePath) -Expected $Pins
    foreach ($child in $children) {
        if ($child.Name -cnotin @('setup-state.json', 'downloads', 'runtime', 'staging', 'results', 'setup.lock') -or
            ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'IMG_CONFLICT: The installation folder contains an unexpected entry; it was preserved.'
        }
    }
    $runtimeRoot = Join-Path $Root 'runtime'
    if (Test-Path -LiteralPath $runtimeRoot) {
        [void](Assert-SkaoImageOrdinaryPath -Path $runtimeRoot -Directory)
        foreach ($child in @(Get-ChildItem -LiteralPath $runtimeRoot -Force)) {
            if ($child.Name -cne 'ComfyUI_windows_portable' -or !$child.PSIsContainer -or
                ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'IMG_CONFLICT: The runtime directory contains an unexpected entry; it was preserved.'
            }
        }
    }
}

function Invoke-SkaoImageBenchmark {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)]$Pins,
          [ValidateSet(1, 4)][int]$Count = 1,
          [ValidateSet('v1-5-pruned-emaonly.safetensors', 'sd_xl_base_1.0.safetensors')][string]$ModelFile = 'v1-5-pruned-emaonly.safetensors',
          [switch]$SimplePrompts, [switch]$GuidedLayout)
    if ($GuidedLayout -and $ModelFile -cne 'sd_xl_base_1.0.safetensors') {
        throw 'IMG_ARGUMENTS: Guided layout generation requires the SDXL comparison model.'
    }
    [void](Assert-SkaoImageOrdinaryPath -Path $Context.Runner)
    if ($GuidedLayout) {
        [void](Assert-SkaoImageOrdinaryPath -Path (Join-Path (Split-Path -Parent $Context.Runner) 'activity_image_layouts.py'))
    }
    $portable = Join-Path $Context.Root 'runtime/ComfyUI_windows_portable'
    $benchmarkArguments = @('-s', $Context.Runner, '--runtime', $portable,
        '--model', $ModelFile, '--output', (Join-Path $Context.Root 'results'), '--count', ([string]$Count))
    if ($SimplePrompts) { $benchmarkArguments += '--simple-prompts' }
    if ($GuidedLayout) { $benchmarkArguments += '--guided-layout' }
    & (Join-Path $portable 'python_embeded/python.exe') @benchmarkArguments
    if ($LASTEXITCODE -ne 0) { throw 'IMG_BENCHMARK: The image test did not complete. Review its reported stage.' }
}

function Invoke-SkaoImageReviewPython {
    param([Parameter(Mandatory = $true)][string]$Executable,
          [Parameter(Mandatory = $true)][string[]]$ReviewArguments)
    & $Executable @ReviewArguments
    if ($LASTEXITCODE -ne 0) { throw 'IMG_REVIEW_REFRESH: The saved review page could not be refreshed. Review the reported stage.' }
}

function Invoke-SkaoImageReviewRefresh {
    param([Parameter(Mandatory = $true)]$Context,
          [Parameter(Mandatory = $true)][string]$Folder)
    $python = Join-Path $Context.Root 'runtime/ComfyUI_windows_portable/python_embeded/python.exe'
    [void](Assert-SkaoImageOrdinaryPath -Path $python)
    [void](Assert-SkaoImageOrdinaryPath -Path $Context.Runner)
    Invoke-SkaoImageReviewPython -Executable $python -ReviewArguments @('-s', $Context.Runner, '--refresh-review', $Folder)
}

function Install-SkaoImageComparison {
    param([Parameter(Mandatory = $true)]$Context,
          [Parameter(Mandatory = $true)]$Asset, [switch]$Check)
    $portable = Join-Path $Context.Root 'runtime/ComfyUI_windows_portable'
    $checkpoints = Join-Path $portable 'ComfyUI/models/checkpoints'
    [void](Assert-SkaoImageOrdinaryPath -Path $checkpoints -Directory)
    $destination = Join-Path $checkpoints $Asset.fileName
    if (Test-Path -LiteralPath $destination) {
        Assert-SkaoImageFile -Path $destination -Sha256 $Asset.sha256 -SizeBytes $Asset.sizeBytes
        Write-Output 'PASS: pinned SDXL Base comparison checkpoint'
        return
    }
    if ($Check) {
        throw 'IMG_COMPARISON_MISSING: The SDXL comparison checkpoint is not installed. No files were changed.'
    }
    $lock = $null; $temporary = $null
    try {
        try { $lock = New-Object IO.FileStream((Join-Path $Context.Root 'setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'IMG_BUSY: Another image setup is using this installation.' }
        # Recheck after the lock: another comparison installer may have finished.
        if (Test-Path -LiteralPath $destination) {
            Assert-SkaoImageFile -Path $destination -Sha256 $Asset.sha256 -SizeBytes $Asset.sizeBytes
        }
        else {
            $downloads = Join-Path $Context.Root 'downloads'
            if (Test-Path -LiteralPath $downloads) { [void](Assert-SkaoImageOrdinaryPath -Path $downloads -Directory) }
            $cache = Join-Path $downloads $Asset.fileName
            Assert-SkaoImageComparisonDiskSpace -Root $Context.Root -Asset $Asset -CachePath $cache
            if (!(Test-Path -LiteralPath $downloads)) { [void](New-Item -ItemType Directory -Path $downloads) }
            Write-Output 'Preparing the pinned SDXL Base comparison checkpoint...'
            Save-SkaoImageDownload -Asset $Asset -Destination $cache
            $temporary = $destination + '.skao-new-' + [Guid]::NewGuid().ToString('N')
            [IO.File]::Copy($cache, $temporary)
            Assert-SkaoImageFile -Path $temporary -Sha256 $Asset.sha256 -SizeBytes $Asset.sizeBytes
            [IO.File]::Move($temporary, $destination)
            $temporary = $null
        }
    }
    finally {
        if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
        if ($lock) { $lock.Dispose() }
    }
    Write-Output 'PASS: pinned SDXL Base comparison checkpoint'
}

function Install-SkaoImageGuidance {
    param([Parameter(Mandatory = $true)]$Context,
          [Parameter(Mandatory = $true)]$Asset, [switch]$Check)
    $portable = Join-Path $Context.Root 'runtime/ComfyUI_windows_portable'
    $models = Join-Path $portable 'ComfyUI/models'
    [void](Assert-SkaoImageOrdinaryPath -Path $models -Directory)
    $controlnet = Join-Path $models 'controlnet'
    if (Test-Path -LiteralPath $controlnet) { [void](Assert-SkaoImageOrdinaryPath -Path $controlnet -Directory) }
    $destination = Join-Path $controlnet $Asset.fileName
    if (Test-Path -LiteralPath $destination) {
        Assert-SkaoImageFile -Path $destination -Sha256 $Asset.sha256 -SizeBytes $Asset.sizeBytes
        Write-Output 'PASS: pinned guided image model'
        return
    }
    if ($Check) {
        throw 'IMG_GUIDANCE_MISSING: The guided image model is not installed. No files were changed.'
    }
    $lock = $null; $temporary = $null; $createdControlnet = $false
    try {
        try { $lock = New-Object IO.FileStream((Join-Path $Context.Root 'setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'IMG_BUSY: Another image setup is using this installation.' }
        if (Test-Path -LiteralPath $controlnet) { [void](Assert-SkaoImageOrdinaryPath -Path $controlnet -Directory) }
        if (Test-Path -LiteralPath $destination) {
            Assert-SkaoImageFile -Path $destination -Sha256 $Asset.sha256 -SizeBytes $Asset.sizeBytes
        }
        else {
            $downloads = Join-Path $Context.Root 'downloads'
            if (Test-Path -LiteralPath $downloads) { [void](Assert-SkaoImageOrdinaryPath -Path $downloads -Directory) }
            $cache = Join-Path $downloads $Asset.fileName
            Assert-SkaoImageGuidanceDiskSpace -Root $Context.Root -Asset $Asset -CachePath $cache
            if (!(Test-Path -LiteralPath $downloads)) { [void](New-Item -ItemType Directory -Path $downloads) }
            Write-Output 'Preparing the pinned guided image model...'
            Save-SkaoImageDownload -Asset $Asset -Destination $cache
            if (!(Test-Path -LiteralPath $controlnet)) {
                [void](New-Item -ItemType Directory -Path $controlnet)
                $createdControlnet = $true
            }
            $temporary = $destination + '.skao-new-' + [Guid]::NewGuid().ToString('N')
            [IO.File]::Copy($cache, $temporary)
            Assert-SkaoImageFile -Path $temporary -Sha256 $Asset.sha256 -SizeBytes $Asset.sizeBytes
            [IO.File]::Move($temporary, $destination)
            $temporary = $null
        }
    }
    finally {
        try {
            if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
            if ($createdControlnet -and !(Test-Path -LiteralPath $destination) -and
                @(Get-ChildItem -LiteralPath $controlnet -Force).Count -eq 0) {
                Remove-Item -LiteralPath $controlnet -Force
            }
        }
        finally { if ($lock) { $lock.Dispose() } }
    }
    Write-Output 'PASS: pinned guided image model'
}

function Invoke-SkaoActivityImageSetup {
    param([switch]$Check, [switch]$TestGeneration, [switch]$CompareSDXL, [switch]$SimplePrompts, [switch]$GuidedLayout,
          [ValidateSet(1, 4)][int]$Count = 1, [string]$ArchivePath, [string]$RefreshReview)
    $refreshRequested = $PSBoundParameters.ContainsKey('RefreshReview')
    if ($refreshRequested -and ([string]::IsNullOrWhiteSpace($RefreshReview) -or
        $Check -or $TestGeneration -or $CompareSDXL -or $SimplePrompts -or $GuidedLayout -or
        $PSBoundParameters.ContainsKey('ArchivePath') -or $PSBoundParameters.ContainsKey('Count'))) {
        throw 'IMG_ARGUMENTS: -RefreshReview needs a folder path and cannot be combined with other setup or generation options.'
    }
    if ($Check -and ($TestGeneration -or $ArchivePath)) {
        throw 'IMG_ARGUMENTS: -Check cannot install, download or generate.'
    }
    if ($SimplePrompts -and (!$TestGeneration -or $Check)) {
        throw 'IMG_ARGUMENTS: -SimplePrompts requires -TestGeneration and cannot be combined with -Check.'
    }
    if ($GuidedLayout -and !$CompareSDXL) {
        throw 'IMG_ARGUMENTS: -GuidedLayout requires -CompareSDXL.'
    }
    if ($CompareSDXL -and $ArchivePath) {
        throw 'IMG_ARGUMENTS: SDXL comparison uses the installed runtime and cannot accept an installation archive.'
    }
    $context = Get-SkaoImageContext
    if ($refreshRequested) {
        Invoke-SkaoImageReviewRefresh -Context $context -Folder $RefreshReview
        return
    }
    $manifest = Read-SkaoImageJson -Path $context.Manifest
    Assert-SkaoImageManifest -Manifest $manifest
    $pins = Get-SkaoImagePins -Manifest $manifest
    Assert-SkaoImageRoot -Root $context.Root -Pins $pins
    $portable = Join-Path $context.Root 'runtime/ComfyUI_windows_portable'
    if (Test-Path -LiteralPath $portable) {
        Assert-SkaoImageRuntime -Portable $portable -Pins $pins
        Write-Output 'PASS: pinned SD1.5 image runtime and checkpoint'
        if ($CompareSDXL) {
            $comparison = Get-SkaoImageComparisonAsset -Manifest $manifest
            $guidance = $null
            if ($GuidedLayout) { $guidance = Get-SkaoImageGuidanceAsset -Manifest $manifest }
            Install-SkaoImageComparison -Context $context -Asset $comparison -Check:$Check
            if ($GuidedLayout) { Install-SkaoImageGuidance -Context $context -Asset $guidance -Check:$Check }
            if ($TestGeneration) { Invoke-SkaoImageBenchmark -Context $context -Pins $pins -Count $Count -ModelFile $comparison.fileName -SimplePrompts:$SimplePrompts -GuidedLayout:$GuidedLayout }
        }
        elseif ($TestGeneration) { Invoke-SkaoImageBenchmark -Context $context -Pins $pins -Count $Count -SimplePrompts:$SimplePrompts }
        return
    }
    if ($CompareSDXL) {
        throw 'IMG_COMPARISON_REQUIRES_SD15: Complete the SD1.5 setup before adding the SDXL comparison. No files were changed.'
    }
    if ($Check) { throw 'IMG_NOT_CONFIGURED: The SD1.5 image test has not been installed. No files were changed.' }
    Assert-SkaoImageDiskSpace -Root $context.Root -Manifest $manifest
    if ($ArchivePath) {
        $ArchivePath = (Resolve-Path -LiteralPath $ArchivePath -ErrorAction Stop).ProviderPath
        Assert-SkaoImageFile -Path $ArchivePath -Sha256 $manifest.comfy.sha256 -SizeBytes $manifest.comfy.sizeBytes
    }
    if (!(Test-Path -LiteralPath $context.Root)) { [void](New-Item -ItemType Directory -Path $context.Root) }
    Set-SkaoImageDirectoryAcl -Path $context.Root -Sid $context.Sid
    $state = Join-Path $context.Root 'setup-state.json'
    if (!(Test-Path -LiteralPath $state)) { Write-SkaoImageJson -Path $state -Value $pins }
    $lock = $null
    try {
        try { $lock = New-Object IO.FileStream((Join-Path $context.Root 'setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'IMG_BUSY: Another image setup is using this installation.' }
        Assert-SkaoImageRoot -Root $context.Root -Pins $pins
        foreach ($name in @('downloads', 'runtime')) {
            $path = Join-Path $context.Root $name
            if (!(Test-Path -LiteralPath $path)) { [void](New-Item -ItemType Directory -Path $path) }
            [void](Assert-SkaoImageOrdinaryPath -Path $path -Directory)
        }
        if (Test-Path -LiteralPath $portable) {
            Assert-SkaoImageRuntime -Portable $portable -Pins $pins
        }
        else {
            $extractor = Get-SkaoImageExtractor
            if (!$extractor) {
                $extractor = Join-Path $context.Root 'downloads/7zr.exe'
                Write-Output 'Preparing the pinned portable 7-Zip extractor...'
                Save-SkaoImageDownload -Asset $manifest.extractor -Destination $extractor
            }
            $archive = Join-Path $context.Root ('downloads/' + $manifest.comfy.assetName)
            if ($ArchivePath) { $archive = $ArchivePath }
            else { Save-SkaoImageDownload -Asset $manifest.comfy -Destination $archive }
            $model = Join-Path $context.Root ('downloads/' + $manifest.model.fileName)
            Save-SkaoImageDownload -Asset $manifest.model -Destination $model
            $stage = Join-Path $context.Root 'staging'
            if (Test-Path -LiteralPath $stage) {
                [void](Assert-SkaoImageOrdinaryPath -Path $stage -Directory)
                if (@(Get-ChildItem -LiteralPath $stage -Force -Recurse | Where-Object {
                    $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -gt 0) {
                    throw 'IMG_PATH: A previous staging folder contains a linked entry; it was preserved.'
                }
                Remove-Item -LiteralPath $stage -Force -Recurse
            }
            [void](New-Item -ItemType Directory -Path $stage)
            Write-Output 'Extracting the verified legacy GPU runtime...'
            Expand-SkaoImageArchive -Extractor $extractor -Archive $archive -Destination $stage
            $stagedPortable = Join-Path $stage 'ComfyUI_windows_portable'
            $checkpointDirectory = Join-Path $stagedPortable 'ComfyUI/models/checkpoints'
            [void](Assert-SkaoImageOrdinaryPath -Path $checkpointDirectory -Directory)
            $checkpoint = Join-Path $checkpointDirectory $manifest.model.fileName
            if (Test-Path -LiteralPath $checkpoint) { throw 'IMG_ARCHIVE: The portable archive unexpectedly contains the SD1.5 checkpoint.' }
            [IO.File]::Copy($model, $checkpoint)
            $receipt = Get-SkaoImageReceipt -Portable $stagedPortable -Pins $pins
            Write-SkaoImageJson -Path (Join-Path $stagedPortable 'skao-installation.json') -Value $receipt
            Assert-SkaoImageRuntime -Portable $stagedPortable -Pins $pins
            [IO.Directory]::Move($stagedPortable, $portable)
            Remove-Item -LiteralPath $stage -Force -Recurse
        }
    }
    finally { if ($lock) { $lock.Dispose() } }
    Write-Output 'PASS: SD1.5 image test installed; Ollama, gateway and Pi settings were preserved'
    if ($TestGeneration) { Invoke-SkaoImageBenchmark -Context $context -Pins $pins -Count $Count -SimplePrompts:$SimplePrompts }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $setupOptions = @{ Check = $Check; TestGeneration = $TestGeneration; CompareSDXL = $CompareSDXL;
            SimplePrompts = $SimplePrompts; GuidedLayout = $GuidedLayout }
        if (!$PSBoundParameters.ContainsKey('RefreshReview') -or $PSBoundParameters.ContainsKey('Count')) { $setupOptions.Count = $Count }
        if ($PSBoundParameters.ContainsKey('ArchivePath')) { $setupOptions.ArchivePath = $ArchivePath }
        if ($PSBoundParameters.ContainsKey('RefreshReview')) { $setupOptions.RefreshReview = $RefreshReview }
        Invoke-SkaoActivityImageSetup @setupOptions
        $global:LASTEXITCODE = 0
    }
    catch {
        $message = [string]$_.Exception.Message
        if ($message -notmatch '^IMG_[A-Z_]+:') { $message = 'IMG_SETUP: Image setup stopped. Existing Ollama and gateway settings were preserved. ' + $message }
        Write-Error $message -ErrorAction Continue
        exit 1
    }
}
