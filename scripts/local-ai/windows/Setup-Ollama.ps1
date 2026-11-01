#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$TestGeneration,
    [string]$ArchivePath
)

# Regenerated setup source. Existing matching manual installations are adopted.
$ErrorActionPreference = 'Stop'
$script:SkaoOllamaVersion = '0.40.13'
$script:SkaoOllamaArchiveHash = '7afa38624fa62ee5d8293422d0ab084c1bb4603134c7f4dafce11a033b57cc19'
$script:SkaoOllamaModel = 'qwen3:4b-instruct-2507-q4_K_M'
$script:SkaoOllamaDigest = '0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0'
$script:SkaoOllamaTask = 'SKAO Local AI'

function Get-SkaoOllamaLauncher {
    return @'
@echo off
setlocal
set "OLLAMA_NO_CLOUD=1"
set "OLLAMA_HOST=127.0.0.1:11434"
set "OLLAMA_MODELS=%~dp0models"
set "OLLAMA_NUM_PARALLEL=1"
set "OLLAMA_MAX_LOADED_MODELS=1"
set "OLLAMA_CONTEXT_LENGTH=4096"
set "OLLAMA_KEEP_ALIVE=0"
set "OLLAMA_DEBUG=0"
"%~dp0ollama-v0.40.13\ollama.exe" serve > "%~dp0ollama-background.log" 2>&1
exit /b %errorlevel%
'@
}

function ConvertTo-SkaoNormalizedCommand {
    param([Parameter(Mandatory = $true)][string]$Text)
    return ($Text.Replace("`r`n", "`n").TrimEnd("`r", "`n"))
}

function Assert-SkaoNormalPath {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Directory)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($Directory -and !$item.PSIsContainer) -or (!$Directory -and $item.PSIsContainer)) {
        throw 'AI_PATH_CONFLICT: An AI setup path is not the expected ordinary file or directory.'
    }
    return $item
}

function Assert-SkaoOllamaAcl {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][string]$Sid, [switch]$Protected)
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $allowed = @($Sid, 'S-1-5-18', 'S-1-5-32-544')
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $allowed -or ($Protected -and !$acl.AreAccessRulesProtected)) {
        throw 'AI_ACL_CONFLICT: The existing AI path owner or inheritance is unexpected.'
    }
    $accountAllowed = $false
    foreach ($entry in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ([string]$entry.AccessControlType -eq 'Deny') {
            throw 'AI_ACL_CONFLICT: The existing AI path contains an unexpected deny rule.'
        }
        if ([string]$entry.AccessControlType -eq 'Allow') {
            if ($entry.IdentityReference.Value -notin $allowed) {
                throw 'AI_ACL_CONFLICT: The existing AI path allows another Windows identity.'
            }
            if ($entry.IdentityReference.Value -eq $Sid -and
                !($entry.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
                ($entry.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq
                    [Security.AccessControl.FileSystemRights]::ReadAndExecute) {
                $accountAllowed = $true
            }
        }
    }
    if (!$accountAllowed) { throw 'AI_ACL_CONFLICT: The AI account cannot read the existing AI path.' }
}

function Set-SkaoNewOllamaDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][string]$Sid)
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $identity = New-Object Security.Principal.SecurityIdentifier($Sid)
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($value in @($Sid, 'S-1-5-18', 'S-1-5-32-544')) {
        $account = New-Object Security.Principal.SecurityIdentifier($value)
        $entry = New-Object Security.AccessControl.FileSystemAccessRule($account,
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($entry)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Resolve-SkaoTaskSid {
    param([Parameter(Mandatory = $true)][string]$Identity)
    try {
        if ($Identity -match '^S-1-\d+(?:-\d+)+$') {
            return (New-Object Security.Principal.SecurityIdentifier($Identity)).Value
        }
        $account = New-Object Security.Principal.NTAccount($Identity)
        return $account.Translate([Security.Principal.SecurityIdentifier]).Value
    }
    catch { throw 'AI_TASK_CONFLICT: The startup task account could not be verified.' }
}

function Assert-SkaoOllamaTaskDefinition {
    param([Parameter(Mandatory = $true)]$Task,
          [Parameter(Mandatory = $true)][string]$Launcher,
          [Parameter(Mandatory = $true)][string]$Sid)
    if ([string]$Task.TaskPath -ne '\' -or
        (Resolve-SkaoTaskSid -Identity ([string]$Task.Principal.UserId)) -ne $Sid -or
        [string]$Task.Principal.LogonType -ne 'Password' -or
        [string]$Task.Principal.RunLevel -ne 'Limited') {
        throw 'AI_TASK_CONFLICT: The AI task must use this account with Password logon and Limited privileges.'
    }
    $actions = @($Task.Actions)
    $triggers = @($Task.Triggers)
    $expectedCmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $validAction = $false
    if ($actions.Count -eq 1) {
        $execute = [Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)
        $arguments = ([string]$actions[0].Arguments).Trim()
        $invocation = $arguments -ireplace '^(?:(?:/d|/s)\s+)*/c\s+', ''
        if ($invocation -cne $arguments) {
            $invocation = [Environment]::ExpandEnvironmentVariables($invocation).Trim().Trim('"')
            $validAction = [IO.Path]::GetFullPath($execute) -ieq [IO.Path]::GetFullPath($expectedCmd) -and
                $invocation -ieq $Launcher
        }
    }
    if (!$validAction -or $triggers.Count -ne 1 -or
        [string]$triggers[0].CimClass.CimClassName -ne 'MSFT_TaskBootTrigger' -or
        [string]$triggers[0].Delay -ne 'PT30S' -or [string]$triggers[0].Enabled -ne 'True') {
        throw 'AI_TASK_CONFLICT: The AI task action or startup trigger differs from the saved setup.'
    }
    $settings = $Task.Settings
    if ([int]$settings.Priority -ne 7 -or [string]$settings.MultipleInstances -ne 'IgnoreNew' -or
        [string]$settings.ExecutionTimeLimit -ne 'PT0S' -or [int]$settings.RestartCount -ne 3 -or
        [string]$settings.RestartInterval -ne 'PT1M' -or
        [string]$settings.DisallowStartIfOnBatteries -ne 'False' -or
        [string]$settings.StopIfGoingOnBatteries -ne 'False') {
        throw 'AI_TASK_CONFLICT: The AI task background or restart settings differ from the saved setup.'
    }
    if ([string]$Task.State -notin @('Running', 'Ready')) {
        throw 'AI_TASK_CONFLICT: The AI startup task is disabled or in an unexpected state.'
    }
}

function Invoke-SkaoOllamaJson {
    param([Parameter(Mandatory = $true)]
          [ValidateSet('/api/version', '/api/status', '/api/tags', '/api/show', '/api/ps', '/api/generate')][string]$Path,
          $Body, [ValidateRange(1, 180)][int]$TimeoutSeconds = 10)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:11434' + $Path)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutSeconds * 1000
    $request.ReadWriteTimeout = $TimeoutSeconds * 1000
    $request.KeepAlive = $false
    if ($null -ne $Body) {
        $request.Method = 'POST'
        $request.ContentType = 'application/json'
        $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Body -Compress -Depth 8))
        $request.ContentLength = $bytes.Length
        $out = $request.GetRequestStream()
        try { $out.Write($bytes, 0, $bytes.Length) } finally { $out.Dispose() }
    }
    $response = $null
    try {
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { throw 'AI_HTTP_STATUS' }
        $stream = $response.GetResponseStream()
        $memory = New-Object IO.MemoryStream
        try {
            $buffer = New-Object byte[] 8192
            while ($true) {
                $remaining = ($TimeoutSeconds * 1000) - $watch.Elapsed.TotalMilliseconds
                if ($remaining -le 0) { throw 'AI_HTTP_TIMEOUT' }
                $read = $stream.ReadAsync($buffer, 0, $buffer.Length)
                if (!$read.Wait([Math]::Max(1, [int]$remaining))) { throw 'AI_HTTP_TIMEOUT' }
                $count = $read.GetAwaiter().GetResult()
                if ($count -le 0) { break }
                if ($memory.Length + $count -gt 1048576) { throw 'AI_HTTP_SIZE' }
                $memory.Write($buffer, 0, $count)
            }
            $text = [Text.Encoding]::UTF8.GetString($memory.ToArray())
            if (!$text.Trim().StartsWith('{') -or !$text.Trim().EndsWith('}')) { throw 'AI_HTTP_JSON' }
            return (ConvertFrom-Json -InputObject $text -ErrorAction Stop)
        }
        finally { $stream.Dispose(); $memory.Dispose() }
    }
    catch { throw 'AI_LOCAL_HTTP: The direct localhost Ollama request did not return a valid bounded HTTP 200 JSON object.' }
    finally { if ($null -ne $response) { $response.Dispose() }; $request.Abort() }
}

function Assert-SkaoOllamaMetadata {
    $version = Invoke-SkaoOllamaJson -Path '/api/version'
    if ([string]$version.version -cne $script:SkaoOllamaVersion) {
        throw 'AI_VERSION_CONFLICT: The localhost Ollama version differs from the saved setup.'
    }
    $status = Invoke-SkaoOllamaJson -Path '/api/status'
    if ($status.cloud.disabled -isnot [bool] -or !$status.cloud.disabled) {
        throw 'AI_CLOUD_ENABLED: Ollama must report cloud disabled.'
    }
}

function Get-SkaoOllamaInstalledModel {
    $tags = Invoke-SkaoOllamaJson -Path '/api/tags'
    $matches = @($tags.models | Where-Object { [string]$_.name -ceq $script:SkaoOllamaModel })
    if ($matches.Count -gt 1) { throw 'AI_MODEL_CONFLICT: Duplicate expected model metadata was returned.' }
    if ($matches.Count -eq 0) { return $false }
    if ([string]$matches[0].digest -cne $script:SkaoOllamaDigest -or
        $matches[0].remote_host -or $matches[0].remote_model) {
        throw 'AI_MODEL_CONFLICT: The expected model tag has an unexpected digest or remote source.'
    }
    $info = Invoke-SkaoOllamaJson -Path '/api/show' -Body @{ model = $script:SkaoOllamaModel }
    if ($info.remote_host -or $info.remote_model -or @($info.capabilities) -notcontains 'completion') {
        throw 'AI_MODEL_CONFLICT: The installed model is not the expected local completion model.'
    }
    return $true
}

function Wait-SkaoOllamaReady {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt 45) {
        try { Assert-SkaoOllamaMetadata; return } catch {
            if ([string]$_.Exception.Message -notlike 'AI_LOCAL_HTTP:*') { throw }
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'AI_LOCAL_HTTP: Ollama did not become ready within the startup deadline.'
}

function Install-SkaoOllamaRuntime {
    param([Parameter(Mandatory = $true)][string]$Root,
          [Parameter(Mandatory = $true)][string]$Runtime,
          [string]$ArchivePath)
    $stage = Join-Path $Root ('install-' + [Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $stage -ErrorAction Stop)
    try {
        $archive = Join-Path $stage 'ollama.zip'
        if ($ArchivePath) {
            [void](Assert-SkaoNormalPath -Path $ArchivePath)
            Copy-Item -LiteralPath $ArchivePath -Destination $archive -ErrorAction Stop
        }
        else {
            $oldProtocol = [Net.ServicePointManager]::SecurityProtocol
            $client = New-Object Net.WebClient
            try {
                [Net.ServicePointManager]::SecurityProtocol = $oldProtocol -bor [Net.SecurityProtocolType]::Tls12
                $client.DownloadFile('https://github.com/ollama/ollama/releases/download/v0.40.13/ollama-windows-amd64.zip', $archive)
            }
            finally { $client.Dispose(); [Net.ServicePointManager]::SecurityProtocol = $oldProtocol }
        }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:SkaoOllamaArchiveHash) {
            throw 'AI_DOWNLOAD_HASH: The Ollama archive does not match the pinned official release.'
        }
        $unpack = Join-Path $stage 'runtime'
        Expand-Archive -LiteralPath $archive -DestinationPath $unpack -ErrorAction Stop
        [void](Assert-SkaoNormalPath -Path (Join-Path $unpack 'ollama.exe'))
        if (Test-Path -LiteralPath $Runtime) { throw 'AI_PATH_CONFLICT: The runtime directory appeared during installation.' }
        Move-Item -LiteralPath $unpack -Destination $Runtime -ErrorAction Stop
    }
    finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue } }
}

function Register-SkaoOllamaTask {
    param([Parameter(Mandatory = $true)][string]$Launcher,
          [Parameter(Mandatory = $true)][string]$Account)
    $password = Read-Host 'Windows password for this protected AI account (not Hello PIN)' -AsSecureString
    $pointer = [IntPtr]::Zero
    $plain = $null
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\cmd.exe') -Argument ('/d /s /c ""' + $Launcher + '""')
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $trigger.Delay = 'PT30S'
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 7
        $principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Password -RunLevel Limited
        $task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
        Register-ScheduledTask -TaskName $script:SkaoOllamaTask -TaskPath '\' -InputObject $task -User $Account -Password $plain -ErrorAction Stop | Out-Null
    }
    finally {
        $plain = $null
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        if ($null -ne $password) { $password.Dispose() }
    }
}

function Invoke-SkaoOllamaPull {
    param([Parameter(Mandatory = $true)][string]$Executable)
    $previousHost = [Environment]::GetEnvironmentVariable('OLLAMA_HOST', 'Process')
    $previousPreference = $ErrorActionPreference
    try {
        $env:OLLAMA_HOST = '127.0.0.1:11434'
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        & $Executable pull $script:SkaoOllamaModel
        $nativeExit = $LASTEXITCODE
        if ($nativeExit -ne 0) { throw 'AI_MODEL_PULL: The pinned model could not be downloaded.' }
    }
    finally {
        [Environment]::SetEnvironmentVariable('OLLAMA_HOST', $previousHost, 'Process')
        $ErrorActionPreference = $previousPreference
    }
}

function Test-SkaoOllamaGeneration {
    try {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $result = Invoke-SkaoOllamaJson -Path '/api/generate' -TimeoutSeconds 180 -Body @{
            model = $script:SkaoOllamaModel; prompt = 'Reply with exactly: Local AI is ready.'
            think = $false; stream = $false; keep_alive = 30
            options = @{ num_ctx = 4096; num_predict = 32; num_thread = 2; temperature = 0 }
        }
        if ([string]$result.done_reason -cne 'stop' -or ([string]$result.response).Trim() -cne 'Local AI is ready.') {
            throw 'AI_GENERATION: The synthetic model test did not return the required complete answer.'
        }
        $running = Invoke-SkaoOllamaJson -Path '/api/ps'
        $model = @($running.models | Where-Object { [string]$_.name -ceq $script:SkaoOllamaModel })
        if ($model.Count -ne 1 -or [long]$model[0].size -le 0 -or [long]$model[0].size_vram -lt [long]$model[0].size) {
            throw 'AI_GPU: The test model was not entirely resident in GPU memory. Review GPU compatibility locally.'
        }
        [pscustomobject]@{ Answer = 'Local AI is ready.'; Finish = 'stop'; Seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2); ModelBytes = [long]$model[0].size; GPUBytes = [long]$model[0].size_vram }
    }
    finally {
        try { Invoke-SkaoOllamaJson -Path '/api/generate' -TimeoutSeconds 15 -Body @{ model = $script:SkaoOllamaModel; keep_alive = 0 } | Out-Null }
        catch { Write-Warning 'Immediate test-model unloading could not be confirmed.' }
    }
}

function Get-SkaoOllamaContext {
    if ($env:OS -ne 'Windows_NT' -or ![Environment]::Is64BitOperatingSystem -or
        [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') -notin @('AMD64', 'x86')) {
        throw 'AI_PLATFORM: This setup requires x64 Windows and Windows PowerShell 5.1 or newer.'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return [pscustomobject]@{
        Sid = $identity.User.Value
        Account = $identity.Name
        Root = (Join-Path $env:LOCALAPPDATA 'SKAO-AI')
    }
}

function Assert-SkaoOllamaTaskStillRunning {
    param([Parameter(Mandatory = $true)][string]$Launcher,
          [Parameter(Mandatory = $true)][string]$Sid)
    $tasks = @(Get-ScheduledTask -TaskName $script:SkaoOllamaTask -TaskPath '\' -ErrorAction Stop)
    if ($tasks.Count -ne 1 -or [string]$tasks[0].State -ne 'Running') {
        throw 'AI_NOT_RUNNING: The saved Ollama task did not remain running during the localhost checks.'
    }
    Assert-SkaoOllamaTaskDefinition -Task $tasks[0] -Launcher $Launcher -Sid $Sid
}

function Invoke-SkaoOllamaSetup {
    param([switch]$Check, [switch]$TestGeneration, [string]$ArchivePath)
    if ($Check -and ($TestGeneration -or $ArchivePath)) { throw 'AI_ARGUMENTS: -Check cannot be combined with installation or generation options.' }
    $context = Get-SkaoOllamaContext
    $sid = $context.Sid
    $root = $context.Root
    $runtime = Join-Path $root ('ollama-v' + $script:SkaoOllamaVersion)
    $exe = Join-Path $runtime 'ollama.exe'
    $models = Join-Path $root 'models'
    $launcher = Join-Path $root 'Run-Ollama.cmd'
    $tasks = @(Get-ScheduledTask -TaskName $script:SkaoOllamaTask -TaskPath '\' -ErrorAction SilentlyContinue)
    if ($tasks.Count -gt 1) { throw 'AI_TASK_CONFLICT: More than one AI startup task was found.' }
    if (Test-Path -LiteralPath $root) {
        [void](Assert-SkaoNormalPath -Path $root -Directory)
        # A secure inherited ACL from the existing private Windows profile can
        # be adopted without rewriting the profile or directory permissions.
        Assert-SkaoOllamaAcl -Path $root -Sid $sid
    }
    elseif ($Check) { throw 'AI_NOT_CONFIGURED: The protected AI directory is missing.' }
    foreach ($dir in @($runtime, $models)) {
        if (Test-Path -LiteralPath $dir) {
            [void](Assert-SkaoNormalPath -Path $dir -Directory)
            Assert-SkaoOllamaAcl -Path $dir -Sid $sid
        }
    }
    if (Test-Path -LiteralPath $launcher) {
        $file = Assert-SkaoNormalPath -Path $launcher
        if ($file.Length -gt 65536) { throw 'AI_LAUNCHER_CONFLICT: The existing launcher is too large.' }
        Assert-SkaoOllamaAcl -Path $launcher -Sid $sid
        if ((ConvertTo-SkaoNormalizedCommand ([IO.File]::ReadAllText($launcher))) -cne
            (ConvertTo-SkaoNormalizedCommand (Get-SkaoOllamaLauncher))) {
            throw 'AI_LAUNCHER_CONFLICT: The existing launcher differs. Preserve it and review its configuration.'
        }
    }
    if (Test-Path -LiteralPath $exe) {
        [void](Assert-SkaoNormalPath -Path $exe)
        Assert-SkaoOllamaAcl -Path $exe -Sid $sid
    }
    elseif (Test-Path -LiteralPath $runtime) { throw 'AI_PATH_CONFLICT: A partial runtime directory already exists. It was preserved.' }
    if ($tasks.Count -eq 1) {
        Assert-SkaoOllamaTaskDefinition -Task $tasks[0] -Launcher $launcher -Sid $sid
        if (!(Test-Path -LiteralPath $launcher) -or !(Test-Path -LiteralPath $exe) -or !(Test-Path -LiteralPath $models)) {
            throw 'AI_TASK_CONFLICT: The existing startup task has missing installation files. No task was changed.'
        }
    }
    elseif ($Check) { throw 'AI_NOT_CONFIGURED: The AI startup task is missing.' }
    if ($Check) {
        if ([string]$tasks[0].State -ne 'Running') { throw 'AI_NOT_RUNNING: The AI startup task is stopped. Check mode left it stopped.' }
        Assert-SkaoOllamaMetadata
        if (!(Get-SkaoOllamaInstalledModel)) { throw 'AI_MODEL_MISSING: The pinned local model is not installed.' }
        Assert-SkaoOllamaTaskStillRunning -Launcher $launcher -Sid $sid
        Write-Output 'PASS: protected Ollama setup, startup task, cloud isolation and pinned local model'
        return
    }
    if (!(Test-Path -LiteralPath $root)) {
        [void](New-Item -ItemType Directory -Path $root -ErrorAction Stop)
        Set-SkaoNewOllamaDirectoryAcl -Path $root -Sid $sid
    }
    if (!(Test-Path -LiteralPath $models)) { [void](New-Item -ItemType Directory -Path $models -ErrorAction Stop) }
    if (!(Test-Path -LiteralPath $exe)) { Install-SkaoOllamaRuntime -Root $root -Runtime $runtime -ArchivePath $ArchivePath }
    if (!(Test-Path -LiteralPath $launcher)) { [IO.File]::WriteAllText($launcher, (ConvertTo-SkaoNormalizedCommand (Get-SkaoOllamaLauncher)).Replace("`n", "`r`n") + "`r`n", [Text.Encoding]::ASCII) }
    if ($tasks.Count -eq 0) {
        Register-SkaoOllamaTask -Launcher $launcher -Account $context.Account
        $tasks = @(Get-ScheduledTask -TaskName $script:SkaoOllamaTask -TaskPath '\' -ErrorAction Stop)
        if ($tasks.Count -ne 1) { throw 'AI_TASK: The registered AI task could not be verified.' }
        Assert-SkaoOllamaTaskDefinition -Task $tasks[0] -Launcher $launcher -Sid $sid
    }
    if ([string]$tasks[0].State -ne 'Running') { Start-ScheduledTask -TaskName $script:SkaoOllamaTask -TaskPath '\' -ErrorAction Stop }
    Wait-SkaoOllamaReady
    if (!(Get-SkaoOllamaInstalledModel)) {
        Invoke-SkaoOllamaPull -Executable $exe
        if (!(Get-SkaoOllamaInstalledModel)) { throw 'AI_MODEL_MISSING: The model download did not install the pinned model.' }
    }
    if ($TestGeneration) { Test-SkaoOllamaGeneration }
    Assert-SkaoOllamaTaskStillRunning -Launcher $launcher -Sid $sid
    Write-Output 'PASS: protected Ollama setup and pinned local model; existing matching files and task reused'
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-SkaoOllamaSetup -Check:$Check -TestGeneration:$TestGeneration -ArchivePath $ArchivePath
        $global:LASTEXITCODE = 0
    }
    catch {
        $code = 'AI_SETUP'
        if ([string]$_.Exception.Message -match '^(AI_[A-Z_]+):') { $code = $Matches[1] }
        Write-Error ($code + ': Ollama setup stopped. Existing files were preserved; review the saved setup guide and protected local configuration.') -ErrorAction Continue
        exit 1
    }
}
