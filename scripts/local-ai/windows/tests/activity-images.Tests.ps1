#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Setup-ActivityImages.ps1')
$script:Checks = 0
function Assert-ImageTrue {
    param($Value, [string]$Label)
    if (!$Value) { throw ('FAIL: ' + $Label) }
    $script:Checks++
}
function Assert-ImageThrows {
    param([scriptblock]$Action, [string]$Pattern, [string]$Label)
    $message = $null
    try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
    Assert-ImageTrue ($null -ne $message -and $message -like $Pattern) $Label
}
function Get-ImageTree {
    param([string]$Path)
    if (!(Test-Path -LiteralPath $Path)) { return '{}' }
    $entries = [ordered]@{}
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -Recurse | Sort-Object FullName)) {
        $relative = $item.FullName.Substring($Path.Length)
        $entries[$relative] = if ($item.PSIsContainer) { '<directory>' } else { (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
    }
    return (ConvertTo-Json -InputObject $entries -Compress)
}

$script:Fixture = Join-Path ([IO.Path]::GetTempPath()) ('skao-image-setup-' + [Guid]::NewGuid().ToString('N'))
try {
    [void](New-Item -ItemType Directory -Path $script:Fixture)
    $script:ArchiveFixture = Join-Path $script:Fixture 'fixture.7z'
    $script:ModelFixture = Join-Path $script:Fixture 'fixture.safetensors'
    $script:ExtractorFixture = Join-Path $script:Fixture 'fixture-extractor.exe'
    $script:ComparisonFixture = Join-Path $script:Fixture 'fixture-sdxl.safetensors'
    $script:GuidanceFixture = Join-Path $script:Fixture 'fixture-guidance.safetensors'
    [IO.File]::WriteAllText($script:ArchiveFixture, 'synthetic archive fixture')
    [IO.File]::WriteAllText($script:ModelFixture, 'synthetic checkpoint fixture')
    [IO.File]::WriteAllText($script:ExtractorFixture, 'synthetic portable extractor fixture')
    [IO.File]::WriteAllText($script:ComparisonFixture, 'synthetic SDXL comparison checkpoint fixture')
    [IO.File]::WriteAllText($script:GuidanceFixture, 'synthetic Control-LoRA checkpoint fixture')
    $archiveHash = (Get-FileHash -LiteralPath $script:ArchiveFixture -Algorithm SHA256).Hash.ToLowerInvariant()
    $modelHash = (Get-FileHash -LiteralPath $script:ModelFixture -Algorithm SHA256).Hash.ToLowerInvariant()
    $extractorHash = (Get-FileHash -LiteralPath $script:ExtractorFixture -Algorithm SHA256).Hash.ToLowerInvariant()
    $revision = 'a' * 40
    $manifest = [pscustomobject]@{
        schemaVersion = 1
        comfy = [pscustomobject]@{
            version = 'v0.43.0'; assetName = 'ComfyUI_windows_portable_nvidia_cu126.7z'
            url = 'https://github.com/Comfy-Org/ComfyUI/releases/download/v0.43.0/ComfyUI_windows_portable_nvidia_cu126.7z'
            sha256 = $archiveHash; sizeBytes = (Get-Item -LiteralPath $script:ArchiveFixture).Length
        }
        model = [pscustomobject]@{
            fileName = 'v1-5-pruned-emaonly.safetensors'; revision = $revision
            url = ('https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/' + $revision + '/v1-5-pruned-emaonly.safetensors')
            sha256 = $modelHash; sizeBytes = (Get-Item -LiteralPath $script:ModelFixture).Length
        }
        extractor = [pscustomobject]@{
            version = '26.05'; assetName = '7zr.exe'
            url = 'https://github.com/ip7z/7zip/releases/download/26.05/7zr.exe'
            sha256 = $extractorHash; sizeBytes = (Get-Item -LiteralPath $script:ExtractorFixture).Length
        }
    }
    Assert-SkaoImageManifest -Manifest $manifest
    $script:Checks++
    foreach ($value in @('1', $true, 2)) {
        $changed = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $changed.schemaVersion = $value
        Assert-ImageThrows { Assert-SkaoImageManifest -Manifest $changed } 'IMG_MANIFEST:*' 'invalid manifest schema refused'
    }
    foreach ($value in @('1', $true, 1.5, 0, 21474836481)) {
        $changed = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $changed.model.sizeBytes = $value
        Assert-ImageThrows { Assert-SkaoImageManifest -Manifest $changed } 'IMG_MANIFEST:*' 'invalid or unbounded download byte count refused'
    }
    foreach ($value in @('http://github.com/Comfy-Org/ComfyUI/releases/download/v0.43.0/ComfyUI_windows_portable_nvidia_cu126.7z',
        'https://untrusted.invalid/package.7z', 'https://github.com/Comfy-Org/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia_cu126.7z')) {
        $changed = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $changed.comfy.url = $value
        Assert-ImageThrows { Assert-SkaoImageManifest -Manifest $changed } 'IMG_MANIFEST:*' 'untrusted or moving archive URL refused'
    }
    $changed = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $changed.model.fileName = '../model.safetensors'
    Assert-ImageThrows { Assert-SkaoImageManifest -Manifest $changed } 'IMG_MANIFEST:*' 'checkpoint path traversal refused'
    $changed = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $changed.model.sha256 = 'unknown'
    Assert-ImageThrows { Assert-SkaoImageManifest -Manifest $changed } 'IMG_MANIFEST:*' 'unverified checkpoint refused'
    $changed = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $changed.extractor.url = 'https://untrusted.invalid/7zr.exe'
    Assert-ImageThrows { Assert-SkaoImageManifest -Manifest $changed } 'IMG_MANIFEST:*' 'untrusted fallback extractor refused'
    Assert-SkaoImageFile -Path $script:ModelFixture -Sha256 $modelHash -SizeBytes $manifest.model.sizeBytes
    $script:Checks++
    Assert-ImageThrows { Assert-SkaoImageFile -Path $script:ModelFixture -Sha256 ('f' * 64) -SizeBytes $manifest.model.sizeBytes } 'IMG_HASH:*' 'wrong checkpoint hash refused'
    Assert-ImageThrows { Assert-SkaoImageFile -Path $script:ModelFixture -Sha256 $modelHash -SizeBytes 1 } 'IMG_HASH:*' 'wrong checkpoint size refused'

    $comparisonManifest = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $comparisonManifest | Add-Member NoteProperty comparison ([pscustomobject]@{
        fileName = 'sd_xl_base_1.0.safetensors'
        revision = '462165984030d82259a11f4367a4eed129e94a7b'
        url = 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/462165984030d82259a11f4367a4eed129e94a7b/sd_xl_base_1.0.safetensors'
        sha256 = '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b'
        sizeBytes = [long]6938078334
    })
    $comparison = Get-SkaoImageComparisonAsset -Manifest $comparisonManifest
    Assert-ImageTrue ($comparison.fileName -ceq 'sd_xl_base_1.0.safetensors') 'verified official SDXL comparison metadata accepted'
    Assert-ImageTrue ((Get-SkaoImagePins -Manifest $manifest | ConvertTo-Json -Compress) -ceq
        (Get-SkaoImagePins -Manifest $comparisonManifest | ConvertTo-Json -Compress)) 'optional comparison leaves baseline adoption pins byte-equivalent'
    Assert-ImageThrows { Get-SkaoImageComparisonAsset -Manifest $manifest } 'IMG_COMPARISON_MANIFEST:*' 'comparison requires complete optional metadata'
    foreach ($property in @('fileName', 'revision', 'url', 'sha256', 'sizeBytes')) {
        $changed = $comparisonManifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $changed.comparison.$property = if ($property -ceq 'sizeBytes') { [long]6938078335 } else { 'unexpected' }
        Assert-ImageThrows { Get-SkaoImageComparisonAsset -Manifest $changed } 'IMG_COMPARISON_MANIFEST:*' 'changed SDXL pin refused'
    }
    $changed = $comparisonManifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $changed.comparison.sizeBytes = '6938078334'
    Assert-ImageThrows { Get-SkaoImageComparisonAsset -Manifest $changed } 'IMG_COMPARISON_MANIFEST:*' 'SDXL byte count must be an integer'
    $script:RealComparisonAssetResolver = (Get-Command Get-SkaoImageComparisonAsset).ScriptBlock

    $guidanceManifest = $comparisonManifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $guidanceManifest | Add-Member NoteProperty guidance ([pscustomobject]@{
        fileName = 'control-lora-canny-rank128.safetensors'
        revision = '75590eb0e7868d3d0f1581b5126d487b33c7fdb4'
        url = 'https://huggingface.co/stabilityai/control-lora/resolve/75590eb0e7868d3d0f1581b5126d487b33c7fdb4/control-LoRAs-rank128/control-lora-canny-rank128.safetensors'
        sha256 = '56389dbb245ca44de91d662529bd4298abc55ce2318f60bc19454fb72ff68247'
        sizeBytes = [long]395733680
    })
    $guidance = Get-SkaoImageGuidanceAsset -Manifest $guidanceManifest
    Assert-ImageTrue ($guidance.fileName -ceq 'control-lora-canny-rank128.safetensors') 'verified official guidance metadata accepted'
    Assert-ImageTrue ((Get-SkaoImagePins -Manifest $manifest | ConvertTo-Json -Compress) -ceq
        (Get-SkaoImagePins -Manifest $guidanceManifest | ConvertTo-Json -Compress)) 'optional guidance leaves baseline adoption pins byte-equivalent'
    Assert-ImageThrows { Get-SkaoImageGuidanceAsset -Manifest $comparisonManifest } 'IMG_GUIDANCE_MANIFEST:*' 'guidance requires complete optional metadata'
    foreach ($property in @('fileName', 'revision', 'url', 'sha256', 'sizeBytes')) {
        $changed = $guidanceManifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $changed.guidance.$property = if ($property -ceq 'sizeBytes') { [long]395733681 } else { 'unexpected' }
        Assert-ImageThrows { Get-SkaoImageGuidanceAsset -Manifest $changed } 'IMG_GUIDANCE_MANIFEST:*' 'changed guidance pin refused'
    }
    $changed = $guidanceManifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $changed.guidance.sizeBytes = '395733680'
    Assert-ImageThrows { Get-SkaoImageGuidanceAsset -Manifest $changed } 'IMG_GUIDANCE_MANIFEST:*' 'guidance byte count must be an integer'
    $script:RealGuidanceAssetResolver = (Get-Command Get-SkaoImageGuidanceAsset).ScriptBlock

    # Actual bounded downloader with a synthetic HTTPS response: no network or model execution.
    $script:DownloadBytes = [IO.File]::ReadAllBytes($script:ModelFixture)
    $script:ResponseDisposed = $false
    $script:DownloadRequests = 0
    $script:MockResponse = [pscustomobject]@{ StatusCode = 200; ResponseUri = [Uri]'https://release-assets.githubusercontent.com/synthetic'; ContentLength = [long]-1 }
    $script:MockResponse | Add-Member ScriptMethod GetResponseStream { return (New-Object IO.MemoryStream -ArgumentList (,$script:DownloadBytes)) }
    $script:MockResponse | Add-Member ScriptMethod Dispose { $script:ResponseDisposed = $true }
    function New-SkaoImageDownloadRequest {
        param($Url)
        $script:DownloadRequests++
        $request = [pscustomobject]@{}
        $request | Add-Member ScriptMethod GetResponse { return $script:MockResponse }
        return $request
    }
    $downloaded = Join-Path $script:Fixture 'downloaded.safetensors'
    $protocolBefore = [Net.ServicePointManager]::SecurityProtocol
    Save-SkaoImageDownload -Asset $manifest.model -Destination $downloaded | Out-Null
    Assert-ImageTrue ((Test-Path -LiteralPath $downloaded) -and !(Test-Path -LiteralPath ($downloaded + '.partial'))) 'verified download publishes atomically'
    Assert-ImageTrue $script:ResponseDisposed 'download disposes response'
    Assert-ImageTrue ([Net.ServicePointManager]::SecurityProtocol -eq $protocolBefore) 'download restores caller TLS protocol setting'
    Save-SkaoImageDownload -Asset $manifest.model -Destination $downloaded | Out-Null
    Assert-ImageTrue ($script:DownloadRequests -eq 1) 'retry reuses a completed verified download without a network request'
    $changed = $manifest.model | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $changed.sha256 = '0' * 64
    $badDownload = Join-Path $script:Fixture 'bad-download.safetensors'
    Assert-ImageThrows { Save-SkaoImageDownload -Asset $changed -Destination $badDownload } 'IMG_HASH:*' 'unverified response never publishes'
    Assert-ImageTrue (!(Test-Path -LiteralPath $badDownload)) 'bad hash leaves destination absent'
    $script:DownloadBytes = [byte[]]($script:DownloadBytes + [byte]0)
    Assert-ImageThrows { Save-SkaoImageDownload -Asset $manifest.model -Destination $badDownload } 'IMG_DOWNLOAD:*' 'stream larger than pinned size rejected'
    Assert-ImageTrue (!(Test-Path -LiteralPath $badDownload)) 'oversized response never publishes'
    $script:DownloadBytes = [byte[]]@(1, 2)
    Assert-ImageThrows { Save-SkaoImageDownload -Asset $manifest.model -Destination $badDownload } 'IMG_HASH:*' 'truncated response rejected'
    Assert-ImageTrue (!(Test-Path -LiteralPath $badDownload)) 'truncated response never publishes'
    $script:DownloadBytes = [IO.File]::ReadAllBytes($script:ModelFixture)
    $script:MockResponse.ResponseUri = [Uri]'http://untrusted.invalid/download'
    Assert-ImageThrows { Save-SkaoImageDownload -Asset $manifest.model -Destination $badDownload } 'IMG_DOWNLOAD:*' 'insecure download redirect refused'
    Assert-ImageTrue (!(Test-Path -LiteralPath $badDownload)) 'insecure response never publishes'

    Assert-SkaoImageArchiveListing -Lines @('Path = ComfyUI_windows_portable', 'Path = ComfyUI_windows_portable/ComfyUI/main.py')
    $script:Checks++
    # Real 7-Zip technical listings contain empty separator lines between entries.
    Assert-SkaoImageArchiveListing -Lines @('', 'Path = ComfyUI_windows_portable',
        'Folder = +', '', 'Path = ComfyUI_windows_portable/ComfyUI/main.py',
        'Size = 123', '', '   ')
    $script:Checks++
    Assert-ImageThrows { Assert-SkaoImageArchiveListing -Lines @() } 'IMG_ARCHIVE:*' 'empty listing fails semantic validation'
    Assert-ImageThrows { Assert-SkaoImageArchiveListing -Lines @('', '', '   ') } 'IMG_ARCHIVE:*' 'separator-only listing is not an archive'
    Assert-ImageThrows { Assert-SkaoImageArchiveListing -Lines @('', 'Path = ComfyUI_windows_portable/../escape.exe', '') } 'IMG_ARCHIVE:*' 'separator lines do not hide unsafe paths'
    Assert-ImageThrows { Assert-SkaoImageArchiveListing -Lines @('', 'Path = ComfyUI_windows_portable/linked', '', 'Symbolic Link = ../../escape', '') } 'IMG_ARCHIVE:*' 'separator lines do not hide linked entries'
    $script:FixtureExtractorCalls = @()
    function Invoke-SkaoFixtureListingExtractor {
        $script:FixtureExtractorCalls += [string]$args[0]
        if ($args[0] -ceq 'l') {
            'Path = ComfyUI_windows_portable'
            ''
            'Path = ComfyUI_windows_portable/ComfyUI/main.py'
            'Size = 123'
            ''
        }
        $global:LASTEXITCODE = 0
    }
    Expand-SkaoImageArchive -Extractor 'Invoke-SkaoFixtureListingExtractor' -Archive $script:ArchiveFixture -Destination (Join-Path $script:Fixture 'listing-extraction')
    Assert-ImageTrue (($script:FixtureExtractorCalls -join ',') -ceq 'l,x') 'production extraction accepts captured separator lines before extracting'
    foreach ($path in @('../escape.exe', 'ComfyUI_windows_portable/../escape.exe',
            'C:/escape.exe', 'ComfyUI_windows_portable/file:stream', '/absolute',
            'ComfyUI_windows_portable//escape', 'other/root.py')) {
        Assert-ImageThrows { Assert-SkaoImageArchiveListing -Lines @('Path = ' + $path) } 'IMG_ARCHIVE:*' 'unsafe extracted path refused'
    }
    Assert-ImageThrows { Assert-SkaoImageArchiveListing -Lines @('Path = ComfyUI_windows_portable/linked', 'Symbolic Link = ../../escape') } 'IMG_ARCHIVE:*' 'linked archive entry refused'

    $script:Context = [pscustomobject]@{
        Root = (Join-Path $script:Fixture 'image-install')
        Manifest = (Join-Path $script:Fixture 'manifest.json')
        Runner = (Join-Path $script:Fixture 'runner.py')
        Sid = 'S-1-5-21-111'
    }
    [IO.File]::WriteAllText($script:Context.Manifest, (ConvertTo-Json -InputObject $manifest -Depth 8))
    [IO.File]::WriteAllText($script:Context.Runner, '# synthetic runner')
    $script:Downloads = 0; $script:Extractions = 0; $script:AclWrites = 0
    $script:BenchmarkRuns = 0; $script:BenchmarkCount = 0; $script:BenchmarkModel = $null
    $script:BenchmarkSimplePrompts = $false; $script:BenchmarkGuidedLayout = $false
    $script:ContextReads = 0; $script:ExtractorAvailable = $false
    $script:ReviewProcesses = 0; $script:ReviewShouldFail = $false
    $script:ReviewExecutable = $null; $script:ReviewArguments = @()
    $script:DownloadedNames = @(); $script:CorruptNextComparisonDownload = $false; $script:CorruptNextGuidanceDownload = $false
    function Get-SkaoImageContext { $script:ContextReads++; return $script:Context }
    function Get-SkaoImageExtractor {
        if (!$script:ExtractorAvailable) { return $null }
        return 'synthetic-7z.exe'
    }
    function Assert-SkaoImageDiskSpace { param($Root, $Manifest) }
    function Assert-SkaoImageComparisonDiskSpace { param($Root, $Asset, $CachePath) }
    function Assert-SkaoImageGuidanceDiskSpace { param($Root, $Asset, $CachePath) }
    function Set-SkaoImageDirectoryAcl { param($Path, $Sid) $script:AclWrites++ }
    function Save-SkaoImageDownload {
        param($Asset, $Destination)
        if (Test-Path -LiteralPath $Destination) {
            Assert-SkaoImageFile -Path $Destination -Sha256 $Asset.sha256 -SizeBytes $Asset.sizeBytes
            return
        }
        $script:Downloads++
        $script:DownloadedNames += if ($Asset.fileName) { $Asset.fileName } else { $Asset.assetName }
        $fixture = if ($Asset.fileName -ceq 'control-lora-canny-rank128.safetensors') { $script:GuidanceFixture } elseif ($Asset.fileName -ceq 'sd_xl_base_1.0.safetensors') { $script:ComparisonFixture } elseif ($Asset.fileName) { $script:ModelFixture } elseif ($Asset.assetName -ceq '7zr.exe') { $script:ExtractorFixture } else { $script:ArchiveFixture }
        [IO.File]::Copy($fixture, $Destination)
        Assert-SkaoImageFile -Path $Destination -Sha256 $Asset.sha256 -SizeBytes $Asset.sizeBytes
        if ($Asset.fileName -ceq 'sd_xl_base_1.0.safetensors' -and $script:CorruptNextComparisonDownload) {
            $script:CorruptNextComparisonDownload = $false
            [IO.File]::AppendAllText($Destination, 'synthetic changed source after verification')
        }
        if ($Asset.fileName -ceq 'control-lora-canny-rank128.safetensors' -and $script:CorruptNextGuidanceDownload) {
            $script:CorruptNextGuidanceDownload = $false
            [IO.File]::AppendAllText($Destination, 'synthetic changed guidance after verification')
        }
    }
    function Expand-SkaoImageArchive {
        param($Extractor, $Archive, $Destination)
        $script:Extractions++
        $portable = Join-Path $Destination 'ComfyUI_windows_portable'
        foreach ($relative in (Get-SkaoImageRuntimeFiles)) {
            $file = Join-Path $portable $relative
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
            [IO.File]::WriteAllText($file, ('synthetic runtime: ' + $relative))
        }
        [void][IO.Directory]::CreateDirectory((Join-Path $portable 'ComfyUI/models/checkpoints'))
    }
    function Invoke-SkaoImageBenchmark {
        param($Context, $Pins, $Count, $ModelFile = 'v1-5-pruned-emaonly.safetensors', [switch]$SimplePrompts, [switch]$GuidedLayout)
        $script:BenchmarkRuns++; $script:BenchmarkCount = $Count; $script:BenchmarkModel = $ModelFile
        $script:BenchmarkSimplePrompts = [bool]$SimplePrompts
        $script:BenchmarkGuidedLayout = [bool]$GuidedLayout
    }
    function Invoke-SkaoImageReviewPython {
        param($Executable, [string[]]$ReviewArguments)
        $script:ReviewProcesses++
        $script:ReviewExecutable = $Executable; $script:ReviewArguments = @($ReviewArguments)
        if ($script:ReviewShouldFail) { throw 'IMG_REVIEW_REFRESH: synthetic refresh failure' }
    }
    # These fixture flows exercise actual installer state/receipts without network or GPU access.
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -Check } 'IMG_NOT_CONFIGURED:*' 'check does not install missing runtime'
    Assert-ImageTrue (!(Test-Path -LiteralPath $script:Context.Root)) 'check creates no installation folder'
    Assert-ImageTrue ($script:Downloads -eq 0 -and $script:AclWrites -eq 0 -and $script:BenchmarkRuns -eq 0) 'check has no downloads ACL writes or inference'
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -Check -TestGeneration } 'IMG_ARGUMENTS:*' 'check rejects generation'
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -Check -ArchivePath 'unknown.7z' } 'IMG_ARGUMENTS:*' 'check rejects installation archive'
    $contextReadsBefore = $script:ContextReads
    foreach ($options in @(
        @{ RefreshReview = '' },
        @{ RefreshReview = '   ' },
        @{ RefreshReview = 'existing-review'; Check = $true },
        @{ RefreshReview = 'existing-review'; TestGeneration = $true },
        @{ RefreshReview = 'existing-review'; CompareSDXL = $true },
        @{ RefreshReview = 'existing-review'; SimplePrompts = $true },
        @{ RefreshReview = 'existing-review'; GuidedLayout = $true },
        @{ RefreshReview = 'existing-review'; ArchivePath = 'unknown.7z' },
        @{ RefreshReview = 'existing-review'; ArchivePath = '' },
        @{ RefreshReview = 'existing-review'; Count = 1 },
        @{ RefreshReview = 'existing-review'; Count = 4 }
    )) {
        Assert-ImageThrows { Invoke-SkaoActivityImageSetup @options } 'IMG_ARGUMENTS:*' 'review refresh rejects empty paths and every setup or generation option'
    }
    Assert-ImageTrue ($script:ContextReads -eq $contextReadsBefore -and !(Test-Path -LiteralPath $script:Context.Root) -and
        $script:Downloads -eq 0 -and $script:AclWrites -eq 0 -and $script:BenchmarkRuns -eq 0 -and $script:ReviewProcesses -eq 0) 'invalid review refresh reads no context creates no files and starts no processes'
    $contextReadsBefore = $script:ContextReads
    foreach ($options in @(
        @{ SimplePrompts = $true },
        @{ SimplePrompts = $true; Check = $true },
        @{ SimplePrompts = $true; Check = $true; TestGeneration = $true },
        @{ SimplePrompts = $true; CompareSDXL = $true }
    )) {
        Assert-ImageThrows { Invoke-SkaoActivityImageSetup @options } 'IMG_ARGUMENTS:*' 'simple prompts require explicit generation and reject checks'
    }
    Assert-ImageTrue ($script:ContextReads -eq $contextReadsBefore) 'invalid simple-prompt options are rejected before accessing installation context'
    Assert-ImageTrue (!(Test-Path -LiteralPath $script:Context.Root) -and $script:Downloads -eq 0 -and $script:AclWrites -eq 0 -and $script:BenchmarkRuns -eq 0) 'invalid simple-prompt options cause no writes downloads or inference'
    $contextReadsBefore = $script:ContextReads
    foreach ($options in @(
        @{ GuidedLayout = $true },
        @{ GuidedLayout = $true; Check = $true },
        @{ GuidedLayout = $true; TestGeneration = $true },
        @{ GuidedLayout = $true; TestGeneration = $true; SimplePrompts = $true },
        @{ GuidedLayout = $true; CompareSDXL = $true; SimplePrompts = $true }
    )) {
        Assert-ImageThrows { Invoke-SkaoActivityImageSetup @options } 'IMG_ARGUMENTS:*' 'guided layout requires comparison and explicit simple prompts still require generation'
    }
    Assert-ImageTrue ($script:ContextReads -eq $contextReadsBefore -and !(Test-Path -LiteralPath $script:Context.Root) -and
        $script:Downloads -eq 0 -and $script:AclWrites -eq 0 -and $script:BenchmarkRuns -eq 0) 'invalid guided options access no context and change no files or state'
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -ArchivePath 'unknown.7z' } 'IMG_ARGUMENTS:*' 'comparison cannot install a baseline runtime archive'
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL } 'IMG_COMPARISON_REQUIRES_SD15:*' 'comparison never installs an absent baseline'
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -Check } 'IMG_COMPARISON_REQUIRES_SD15:*' 'comparison check never installs an absent baseline'
    Assert-ImageTrue (!(Test-Path -LiteralPath $script:Context.Root)) 'comparison leaves an absent baseline directory absent'
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -ArchivePath $script:ModelFixture } 'IMG_HASH:*' 'incorrect offline archive refused'
    Assert-ImageTrue (!(Test-Path -LiteralPath $script:Context.Root)) 'wrong offline archive creates no installation folder'

    Invoke-SkaoActivityImageSetup | Out-Null
    Assert-ImageTrue ($script:Downloads -eq 3 -and $script:Extractions -eq 1) 'fresh setup installs verified extractor runtime and checkpoint'
    Assert-ImageTrue (Test-Path -LiteralPath (Join-Path $script:Context.Root 'downloads/7zr.exe')) 'missing system extractor uses private pinned executable'
    Assert-ImageTrue ($script:BenchmarkRuns -eq 0) 'normal installation performs no inference'
    $before = Get-ImageTree -Path $script:Context.Root
    $aclBefore = $script:AclWrites
    Invoke-SkaoActivityImageSetup -Check | Out-Null
    Invoke-SkaoActivityImageSetup | Out-Null
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $before) 'check and repeated setup preserve every installed file'
    Assert-ImageTrue ($script:Downloads -eq 3 -and $script:Extractions -eq 1 -and $script:AclWrites -eq $aclBefore) 'adoption causes no downloads extraction or ACL rewrite'
    Invoke-SkaoActivityImageSetup -TestGeneration -Count 4 | Out-Null
    Assert-ImageTrue ($script:BenchmarkRuns -eq 1 -and $script:BenchmarkCount -eq 4) 'explicit benchmark forwards four-image count'
    Assert-ImageTrue ($script:BenchmarkModel -ceq 'v1-5-pruned-emaonly.safetensors') 'default benchmark continues using SD1.5'
    Assert-ImageTrue (!$script:BenchmarkSimplePrompts) 'default benchmark keeps the original prompt profile'
    Assert-ImageTrue (!$script:BenchmarkGuidedLayout) 'default benchmark leaves guided layout disabled'
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $before) 'benchmark orchestration preserves installed assets'
    Invoke-SkaoActivityImageSetup -TestGeneration -SimplePrompts -Count 1 | Out-Null
    Assert-ImageTrue ($script:BenchmarkModel -ceq 'v1-5-pruned-emaonly.safetensors' -and $script:BenchmarkSimplePrompts -and $script:BenchmarkCount -eq 1) 'simple-prompt trial forwards SD1.5 model and requested image count'
    Assert-ImageTrue ($script:Downloads -eq 3 -and (Get-ImageTree -Path $script:Context.Root) -ceq $before) 'SD1.5 simple-prompt trial reuses all installed assets without changes'
    $baselineBenchmarksBeforeCorruption = $script:BenchmarkRuns

    $portable = Join-Path $script:Context.Root 'runtime/ComfyUI_windows_portable'
    $modelPath = Join-Path $portable 'ComfyUI/models/checkpoints/v1-5-pruned-emaonly.safetensors'
    [IO.File]::AppendAllText($modelPath, 'changed')
    $changedTree = Get-ImageTree -Path $script:Context.Root
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -Check } 'IMG_HASH:*' 'check detects modified checkpoint'
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -TestGeneration } 'IMG_HASH:*' 'modified checkpoint cannot execute benchmark'
    Assert-ImageTrue ($script:BenchmarkRuns -eq $baselineBenchmarksBeforeCorruption) 'corrupted checkpoint was not used for inference'
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $changedTree) 'corrupted checkpoint preserved for inspection'
    [IO.File]::WriteAllBytes($modelPath, [IO.File]::ReadAllBytes($script:ModelFixture))
    $mainPath = Join-Path $portable 'ComfyUI/main.py'
    [IO.File]::AppendAllText($mainPath, 'changed')
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -Check } 'IMG_HASH:*' 'modified runtime main script detected'
    [IO.File]::WriteAllText($mainPath, 'synthetic runtime: ComfyUI/main.py')
    [IO.File]::WriteAllText((Join-Path $script:Context.Root 'unexpected.txt'), 'preserve me')
    $foreignTree = Get-ImageTree -Path $script:Context.Root
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup } 'IMG_CONFLICT:*' 'unexpected root entry preserved and refused'
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $foreignTree) 'foreign installation entry was not altered'

    $script:Context.Root = Join-Path $script:Fixture 'foreign-install'
    [void](New-Item -ItemType Directory -Path $script:Context.Root)
    [IO.File]::WriteAllText((Join-Path $script:Context.Root 'do-not-touch'), 'synthetic unrelated work')
    $foreignTree = Get-ImageTree -Path $script:Context.Root
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup } 'IMG_CONFLICT:*' 'nonempty unrecognized folder never overwritten'
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $foreignTree) 'unrecognized folder byte tree preserved'

    $script:Context.Root = Join-Path $script:Fixture 'resume-install'
    $script:ExtractorAvailable = $true
    [void](New-Item -ItemType Directory -Path $script:Context.Root)
    $pins = Get-SkaoImagePins -Manifest $manifest
    Write-SkaoImageJson -Path (Join-Path $script:Context.Root 'setup-state.json') -Value $pins
    [void](New-Item -ItemType Directory -Path (Join-Path $script:Context.Root 'staging'))
    [IO.File]::WriteAllText((Join-Path $script:Context.Root 'staging/interrupted'), 'synthetic interrupted extraction')
    Invoke-SkaoActivityImageSetup | Out-Null
    Invoke-SkaoActivityImageSetup -Check | Out-Null
    Assert-ImageTrue ($script:Extractions -eq 2) 'recognized interrupted staging resumes safely'
    Assert-ImageTrue (!(Test-Path -LiteralPath (Join-Path $script:Context.Root 'staging'))) 'successful publication removes only owned staging'

    # Add SDXL to an already working installation; use a small fixture instead of 6.94 GB.
    # The real resolver still validates the complete official comparison metadata first.
    function Get-SkaoImageComparisonAsset {
        param($Manifest)
        & $script:RealComparisonAssetResolver -Manifest $Manifest | Out-Null
        return [pscustomobject]@{
            fileName = 'sd_xl_base_1.0.safetensors'
            revision = '462165984030d82259a11f4367a4eed129e94a7b'
            url = $Manifest.comparison.url
            sha256 = (Get-FileHash -LiteralPath $script:ComparisonFixture -Algorithm SHA256).Hash.ToLowerInvariant()
            sizeBytes = (Get-Item -LiteralPath $script:ComparisonFixture).Length
        }
    }
    $downloadsBefore = $script:Downloads; $extractionsBefore = $script:Extractions
    $aclBefore = $script:AclWrites; $benchmarkBefore = $script:BenchmarkRuns
    $results = Join-Path $script:Context.Root 'results'
    [void](New-Item -ItemType Directory -Path $results)
    [IO.File]::WriteAllText((Join-Path $results 'previous-review.txt'), 'synthetic previous SD1.5 result')
    $baselineTree = Get-ImageTree -Path $script:Context.Root
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -Check } 'IMG_COMPARISON_MANIFEST:*' 'old baseline manifest needs comparison metadata only for explicit comparison'
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $baselineTree) 'missing comparison metadata changes no installed files'
    [IO.File]::WriteAllText($script:Context.Manifest, (ConvertTo-Json -InputObject $comparisonManifest -Depth 8))
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -Check } 'IMG_COMPARISON_MISSING:*' 'comparison check reports missing SDXL checkpoint'
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $baselineTree) 'missing comparison check is entirely read-only'
    Assert-ImageTrue ($script:Downloads -eq $downloadsBefore -and $script:AclWrites -eq $aclBefore -and $script:BenchmarkRuns -eq $benchmarkBefore) 'comparison checks do not download change ACLs or infer'
    $comparisonCache = Join-Path $script:Context.Root 'downloads/sd_xl_base_1.0.safetensors'
    $comparisonDestination = Join-Path $script:Context.Root 'runtime/ComfyUI_windows_portable/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors'
    $script:CorruptNextComparisonDownload = $true
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL } 'IMG_HASH:*' 'changed comparison source never publishes a checkpoint'
    Assert-ImageTrue (!(Test-Path -LiteralPath $comparisonDestination)) 'failed comparison copy leaves destination absent'
    Assert-ImageTrue (@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($comparisonDestination)) -Filter '*.skao-new-*').Count -eq 0) 'failed comparison copy removes only its temporary publication'
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL } 'IMG_HASH:*' 'invalid existing comparison cache is preserved and refused'
    Assert-ImageTrue (!(Test-Path -LiteralPath $comparisonDestination)) 'invalid cache never becomes installed comparison'
    Remove-Item -LiteralPath $comparisonCache -Force
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $baselineTree) 'failed comparison leaves baseline receipts runtime models and results untouched'
    $script:DownloadedNames = @()
    $downloadsBefore = $script:Downloads
    Invoke-SkaoActivityImageSetup -CompareSDXL | Out-Null
    Assert-ImageTrue ($script:Downloads -eq $downloadsBefore + 1 -and ($script:DownloadedNames -join ',') -ceq 'sd_xl_base_1.0.safetensors') 'comparison downloads only the new SDXL asset'
    Assert-ImageTrue ($script:Extractions -eq $extractionsBefore -and $script:AclWrites -eq $aclBefore) 'comparison never reextracts ComfyUI or changes existing ACLs'
    $afterComparison = Get-ImageTree -Path $script:Context.Root
    $beforeProperties = ($baselineTree | ConvertFrom-Json).PSObject.Properties
    $afterProperties = ($afterComparison | ConvertFrom-Json).PSObject.Properties
    foreach ($property in $beforeProperties) {
        $actual = @($afterProperties | Where-Object { $_.Name -ceq $property.Name })
        Assert-ImageTrue ($actual.Count -eq 1 -and $actual[0].Value -ceq $property.Value) 'comparison preserves every existing installation and result entry'
    }
    Assert-ImageTrue (@($afterProperties).Count -eq @($beforeProperties).Count + 2) 'comparison adds only cached and installed checkpoint files'
    Invoke-SkaoActivityImageSetup -CompareSDXL -Check | Out-Null
    Invoke-SkaoActivityImageSetup -CompareSDXL | Out-Null
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $afterComparison) 'repeated comparison checks and adoption rewrite no files'
    Assert-ImageTrue ($script:Downloads -eq $downloadsBefore + 1) 'installed comparison repeats require no downloads'
    Invoke-SkaoActivityImageSetup -CompareSDXL -TestGeneration -Count 4 | Out-Null
    Assert-ImageTrue ($script:BenchmarkModel -ceq 'sd_xl_base_1.0.safetensors' -and $script:BenchmarkCount -eq 4) 'comparison benchmark forwards SDXL filename and four-image count'
    Assert-ImageTrue (!$script:BenchmarkSimplePrompts) 'SDXL comparison defaults to the original prompt profile'
    Invoke-SkaoActivityImageSetup -CompareSDXL -TestGeneration -SimplePrompts -Count 4 | Out-Null
    Assert-ImageTrue ($script:BenchmarkModel -ceq 'sd_xl_base_1.0.safetensors' -and $script:BenchmarkSimplePrompts -and $script:BenchmarkCount -eq 4) 'SDXL simple-prompt trial forwards the model flag and requested image count'
    Assert-ImageTrue ($script:Downloads -eq $downloadsBefore + 1 -and (Get-ImageTree -Path $script:Context.Root) -ceq $afterComparison) 'installed SDXL simple-prompt trial performs no download or installation change'
    $contextReadsBefore = $script:ContextReads
    $benchmarkBefore = $script:BenchmarkRuns
    foreach ($options in @(
        @{ SimplePrompts = $true; CompareSDXL = $true },
        @{ SimplePrompts = $true; CompareSDXL = $true; Check = $true },
        @{ SimplePrompts = $true; CompareSDXL = $true; Check = $true; TestGeneration = $true }
    )) {
        Assert-ImageThrows { Invoke-SkaoActivityImageSetup @options } 'IMG_ARGUMENTS:*' 'installed comparison still rejects invalid simple-prompt combinations'
    }
    Assert-ImageTrue ($script:ContextReads -eq $contextReadsBefore -and $script:BenchmarkRuns -eq $benchmarkBefore -and
        $script:Downloads -eq $downloadsBefore + 1 -and (Get-ImageTree -Path $script:Context.Root) -ceq $afterComparison) 'invalid installed comparison options access no context and change no files or state'
    Invoke-SkaoActivityImageSetup -TestGeneration -Count 1 | Out-Null
    Assert-ImageTrue ($script:BenchmarkModel -ceq 'v1-5-pruned-emaonly.safetensors' -and $script:BenchmarkCount -eq 1) 'default benchmark remains SD1.5 after SDXL is installed'
    Assert-ImageTrue (!$script:BenchmarkSimplePrompts) 'ordinary generation returns to the original prompt profile after a simple-prompt trial'
    [IO.File]::AppendAllText($comparisonDestination, 'unexpected modification')
    $invalidTree = Get-ImageTree -Path $script:Context.Root
    $benchmarkBefore = $script:BenchmarkRuns
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -TestGeneration } 'IMG_HASH:*' 'modified installed SDXL checkpoint cannot be used'
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $invalidTree -and $script:BenchmarkRuns -eq $benchmarkBefore) 'invalid installed comparison is preserved without generation'

    # Add optional guidance to the existing working SDXL setup, preserving all prior assets/results.
    [IO.File]::WriteAllBytes($comparisonDestination, [IO.File]::ReadAllBytes($script:ComparisonFixture))
    function Get-SkaoImageGuidanceAsset {
        param($Manifest)
        & $script:RealGuidanceAssetResolver -Manifest $Manifest | Out-Null
        return [pscustomobject]@{
            fileName = 'control-lora-canny-rank128.safetensors'
            revision = '75590eb0e7868d3d0f1581b5126d487b33c7fdb4'
            url = $Manifest.guidance.url
            sha256 = (Get-FileHash -LiteralPath $script:GuidanceFixture -Algorithm SHA256).Hash.ToLowerInvariant()
            sizeBytes = (Get-Item -LiteralPath $script:GuidanceFixture).Length
        }
    }
    $beforeGuidance = Get-ImageTree -Path $script:Context.Root
    $downloadsBeforeGuidance = $script:Downloads; $extractionsBeforeGuidance = $script:Extractions
    $aclBeforeGuidance = $script:AclWrites; $benchmarksBeforeGuidance = $script:BenchmarkRuns
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout -Check } 'IMG_GUIDANCE_MANIFEST:*' 'guided metadata is optional until explicitly requested'
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $beforeGuidance) 'missing guided metadata changes no installed files'
    [IO.File]::WriteAllText($script:Context.Manifest, (ConvertTo-Json -InputObject $guidanceManifest -Depth 8))
    $controlnet = Join-Path $script:Context.Root 'runtime/ComfyUI_windows_portable/ComfyUI/models/controlnet'
    $guidanceDestination = Join-Path $controlnet 'control-lora-canny-rank128.safetensors'
    $guidanceCache = Join-Path $script:Context.Root 'downloads/control-lora-canny-rank128.safetensors'
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout -Check } 'IMG_GUIDANCE_MISSING:*' 'guided check reports missing model without requiring generation'
    Assert-ImageTrue (!(Test-Path -LiteralPath $controlnet) -and (Get-ImageTree -Path $script:Context.Root) -ceq $beforeGuidance) 'missing guidance check creates no controlnet directory or files'
    Assert-ImageTrue ($script:Downloads -eq $downloadsBeforeGuidance -and $script:BenchmarkRuns -eq $benchmarksBeforeGuidance -and $script:AclWrites -eq $aclBeforeGuidance) 'guided checks perform no downloads inference or ACL updates'
    $heldLock = New-Object IO.FileStream((Join-Path $script:Context.Root 'setup.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout } 'IMG_BUSY:*' 'guided installation respects the existing setup lock'
        Assert-ImageTrue ($script:Downloads -eq $downloadsBeforeGuidance) 'busy guided installation starts no download'
    }
    finally { $heldLock.Dispose() }
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $beforeGuidance) 'busy guided installation changes no files'
    $script:CorruptNextGuidanceDownload = $true
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout } 'IMG_HASH:*' 'changed guidance source never publishes a model'
    Assert-ImageTrue (!(Test-Path -LiteralPath $guidanceDestination) -and !(Test-Path -LiteralPath $controlnet)) 'failed guidance copy removes its new empty directory and never publishes'
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout } 'IMG_HASH:*' 'invalid existing guidance cache is preserved and refused'
    Assert-ImageTrue (!(Test-Path -LiteralPath $guidanceDestination)) 'invalid guidance cache never becomes installed'
    Remove-Item -LiteralPath $guidanceCache -Force
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $beforeGuidance) 'failed guidance leaves baseline comparison receipts models and results untouched'
    $script:DownloadedNames = @()
    $downloadsBeforeGuidance = $script:Downloads
    Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout | Out-Null
    Assert-ImageTrue ($script:Downloads -eq $downloadsBeforeGuidance + 1 -and
        ($script:DownloadedNames -join ',') -ceq 'control-lora-canny-rank128.safetensors') 'guided install-only downloads only its new Control-LoRA asset'
    Assert-ImageTrue ($script:Extractions -eq $extractionsBeforeGuidance -and $script:AclWrites -eq $aclBeforeGuidance -and
        $script:BenchmarkRuns -eq $benchmarksBeforeGuidance) 'guided install-only does not reextract change ACLs or generate'
    $afterGuidance = Get-ImageTree -Path $script:Context.Root
    $beforeProperties = ($beforeGuidance | ConvertFrom-Json).PSObject.Properties
    $afterProperties = ($afterGuidance | ConvertFrom-Json).PSObject.Properties
    foreach ($property in $beforeProperties) {
        $actual = @($afterProperties | Where-Object { $_.Name -ceq $property.Name })
        Assert-ImageTrue ($actual.Count -eq 1 -and $actual[0].Value -ceq $property.Value) 'guidance preserves every previous installation and result entry'
    }
    Assert-ImageTrue (@($afterProperties).Count -eq @($beforeProperties).Count + 3) 'guidance adds only its controlnet directory cached file and installed file'
    Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout -Check | Out-Null
    Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout | Out-Null
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $afterGuidance -and
        $script:Downloads -eq $downloadsBeforeGuidance + 1) 'guided check and repeated installation preserve all files and reuse the model'
    Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout -TestGeneration -Count 1 | Out-Null
    Assert-ImageTrue ($script:BenchmarkGuidedLayout -and !$script:BenchmarkSimplePrompts -and
        $script:BenchmarkModel -ceq 'sd_xl_base_1.0.safetensors' -and $script:BenchmarkCount -eq 1) 'guided generation forwards SDXL and count without altering the explicit simple-prompts switch'
    Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout -SimplePrompts -TestGeneration -Count 4 | Out-Null
    Assert-ImageTrue ($script:BenchmarkGuidedLayout -and $script:BenchmarkSimplePrompts -and
        $script:BenchmarkCount -eq 4) 'guided generation accepts redundant explicit simple prompts and four images'
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $afterGuidance -and $script:Downloads -eq $downloadsBeforeGuidance + 1) 'guided generation reuses installed models without changes'
    Invoke-SkaoActivityImageSetup -TestGeneration -Count 1 | Out-Null
    Assert-ImageTrue (!$script:BenchmarkGuidedLayout -and !$script:BenchmarkSimplePrompts -and
        $script:BenchmarkModel -ceq 'v1-5-pruned-emaonly.safetensors') 'ordinary generation remains the original SD1.5 profile after guidance installation'
    [IO.File]::AppendAllText($guidanceDestination, 'unexpected guidance modification')
    $invalidGuidanceTree = Get-ImageTree -Path $script:Context.Root
    $benchmarksBeforeGuidance = $script:BenchmarkRuns
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -CompareSDXL -GuidedLayout -TestGeneration } 'IMG_HASH:*' 'modified installed guidance model is never used'
    Invoke-SkaoActivityImageSetup -Check | Out-Null
    Invoke-SkaoActivityImageSetup -CompareSDXL -Check | Out-Null
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $invalidGuidanceTree -and
        $script:BenchmarkRuns -eq $benchmarksBeforeGuidance) 'invalid optional guidance is preserved while ordinary baseline and SDXL checks still work'

    # Gallery refresh uses only the already installed Python and current runner.
    # A missing manifest and changed model prove this branch bypasses model checks/setup.
    $savedManifestPath = $script:Context.Manifest
    $script:Context.Manifest = Join-Path $script:Fixture 'deliberately-missing-manifest.json'
    $refreshFolder = Join-Path $script:Fixture 'copied review with spaces'
    [void](New-Item -ItemType Directory -Path $refreshFolder)
    [IO.File]::WriteAllText((Join-Path $refreshFolder 'review.html'), 'synthetic saved gallery')
    [IO.File]::WriteAllText((Join-Path $refreshFolder 'report.json'), '{"status":"completed"}')
    [IO.File]::WriteAllText((Join-Path $refreshFolder 'step1.png'), 'synthetic saved image')
    $refreshFolderBefore = Get-ImageTree -Path $refreshFolder
    $baselineCheckpoint = Join-Path $script:Context.Root 'runtime/ComfyUI_windows_portable/ComfyUI/models/checkpoints/v1-5-pruned-emaonly.safetensors'
    [IO.File]::AppendAllText($baselineCheckpoint, 'synthetic unrelated model modification')
    $refreshInstallBefore = Get-ImageTree -Path $script:Context.Root
    $downloadsBeforeRefresh = $script:Downloads; $benchmarksBeforeRefresh = $script:BenchmarkRuns
    $extractionsBeforeRefresh = $script:Extractions; $aclBeforeRefresh = $script:AclWrites
    Invoke-SkaoActivityImageSetup -RefreshReview $refreshFolder | Out-Null
    $expectedPython = Join-Path $script:Context.Root 'runtime/ComfyUI_windows_portable/python_embeded/python.exe'
    Assert-ImageTrue ($script:ReviewProcesses -eq 1 -and $script:ReviewExecutable -ceq $expectedPython) 'refresh invokes only the existing portable Python executable'
    Assert-ImageTrue ($script:ReviewArguments.Count -eq 4 -and $script:ReviewArguments[0] -ceq '-s' -and
        $script:ReviewArguments[1] -ceq $script:Context.Runner -and $script:ReviewArguments[2] -ceq '--refresh-review' -and
        $script:ReviewArguments[3] -ceq $refreshFolder) 'refresh forwards exactly the runner and literal folder without runtime model or generation arguments'
    Assert-ImageTrue ($script:Downloads -eq $downloadsBeforeRefresh -and $script:BenchmarkRuns -eq $benchmarksBeforeRefresh -and
        $script:Extractions -eq $extractionsBeforeRefresh -and $script:AclWrites -eq $aclBeforeRefresh) 'refresh performs no model setup download extraction inference or ACL update'
    Assert-ImageTrue ((Get-ImageTree -Path $script:Context.Root) -ceq $refreshInstallBefore -and
        (Get-ImageTree -Path $refreshFolder) -ceq $refreshFolderBefore) 'refresh orchestration preserves every asset setting and saved result'
    $script:ReviewShouldFail = $true
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -RefreshReview $refreshFolder } 'IMG_REVIEW_REFRESH:*' 'failed review refresh reports failure without falling back to setup'
    Assert-ImageTrue ($script:Downloads -eq $downloadsBeforeRefresh -and $script:BenchmarkRuns -eq $benchmarksBeforeRefresh -and
        (Get-ImageTree -Path $script:Context.Root) -ceq $refreshInstallBefore) 'failed refresh still preserves assets and starts no generation'
    $script:ReviewShouldFail = $false
    $reviewProcessesBefore = $script:ReviewProcesses
    $savedPython = $expectedPython + '.saved'
    [IO.File]::Move($expectedPython, $savedPython)
    [void](New-Item -ItemType Directory -Path $expectedPython)
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -RefreshReview $refreshFolder } 'IMG_PATH:*' 'refresh requires an ordinary existing Python file'
    Assert-ImageTrue ($script:ReviewProcesses -eq $reviewProcessesBefore) 'invalid Python path starts no refresh process'
    Remove-Item -LiteralPath $expectedPython -Force
    [IO.File]::Move($savedPython, $expectedPython)
    $savedRunner = $script:Context.Runner + '.saved'
    [IO.File]::Move($script:Context.Runner, $savedRunner)
    [void](New-Item -ItemType Directory -Path $script:Context.Runner)
    Assert-ImageThrows { Invoke-SkaoActivityImageSetup -RefreshReview $refreshFolder } 'IMG_PATH:*' 'refresh requires an ordinary existing runner file'
    Assert-ImageTrue ($script:ReviewProcesses -eq $reviewProcessesBefore) 'invalid runner path starts no refresh process'
    Remove-Item -LiteralPath $script:Context.Runner -Force
    [IO.File]::Move($savedRunner, $script:Context.Runner)
    $script:Context.Manifest = $savedManifestPath
}
finally {
    if (Test-Path -LiteralPath $script:Fixture) { Remove-Item -LiteralPath $script:Fixture -Recurse -Force }
}
Write-Output ('PASS: ' + $script:Checks + ' image setup checks (synthetic fixtures; no native GPU or Windows deployment)')
