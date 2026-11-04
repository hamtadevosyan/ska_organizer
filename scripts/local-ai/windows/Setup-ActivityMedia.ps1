#Requires -Version 5.1
[CmdletBinding()]
param([switch]$Check)

$ErrorActionPreference = 'Stop'
$script:SkaoActivityMediaTask = 'SKAO Activity Images'

function Get-SkaoActivityMediaContext {
    if ($env:OS -ne 'Windows_NT' -or ![Environment]::Is64BitOperatingSystem -or !$env:LOCALAPPDATA) {
        throw 'AI_MEDIA_PLATFORM: Run this setup under the protected Windows AI account.'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return [pscustomobject]@{
        Root = (Join-Path $env:LOCALAPPDATA 'SKAO-ActivityMedia')
        ImageRoot = (Join-Path $env:LOCALAPPDATA 'SKAO-ActivityImages')
        GatewayRoot = (Join-Path $env:LOCALAPPDATA 'SKAO-AI/gateway')
        Source = $PSScriptRoot
        Account = $identity.Name
        Sid = $identity.User.Value
    }
}

function Assert-SkaoActivityMediaPath {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Directory,
          [long]$MaximumBytes = 1048576)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        [bool]$item.PSIsContainer -ne [bool]$Directory -or
        (!$Directory -and ($item.Length -lt 1 -or $item.Length -gt $MaximumBytes))) {
        throw 'AI_MEDIA_PATH: A managed worker path is not the expected ordinary file or directory.'
    }
    return $item
}

function Assert-SkaoActivityMediaAcl {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][string]$Sid, [switch]$Protected)
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $allowed = @($Sid, 'S-1-5-18', 'S-1-5-32-544')
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed -or
        ($Protected -and !$acl.AreAccessRulesProtected)) {
        throw 'AI_MEDIA_ACL: A managed worker path has an unexpected owner or inheritance.'
    }
    $accountCanRead = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ([string]$rule.AccessControlType -eq 'Deny' -or
            ([string]$rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed)) {
            throw 'AI_MEDIA_ACL: A managed worker path permits an unexpected Windows identity.'
        }
        if ($rule.IdentityReference.Value -eq $Sid -and
            !($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
            ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq
                [Security.AccessControl.FileSystemRights]::ReadAndExecute) { $accountCanRead = $true }
    }
    if (!$accountCanRead) { throw 'AI_MEDIA_ACL: This AI account cannot read the managed worker path.' }
}

function Set-SkaoActivityMediaRootAcl {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][string]$Sid)
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $owner = New-Object Security.Principal.SecurityIdentifier($Sid)
    $acl.SetOwner($owner); $acl.SetAccessRuleProtection($true, $false)
    foreach ($value in @($Sid, 'S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($value)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Invoke-SkaoActivityMediaChild {
    param([Parameter(Mandatory = $true)][string]$Script,
          [Parameter(Mandatory = $true)][hashtable]$Options)
    [void](Assert-SkaoActivityMediaPath -Path $Script)
    $global:LASTEXITCODE = 0
    & $Script @Options
    $succeeded = $?; $code = $LASTEXITCODE
    if (!$succeeded -or $code -ne 0) { throw 'AI_MEDIA_PREREQUISITE: A worker prerequisite check failed; later stages were not run.' }
}

function Get-SkaoActivityMediaToken {
    param([Parameter(Mandatory = $true)]$Context)
    foreach ($directory in @($Context.GatewayRoot, (Join-Path $Context.GatewayRoot 'pi-connection'))) {
        [void](Assert-SkaoActivityMediaPath -Path $directory -Directory)
        Assert-SkaoActivityMediaAcl -Path $directory -Sid $Context.Sid
    }
    $metadata = Join-Path $Context.GatewayRoot 'setup.json'
    [void](Assert-SkaoActivityMediaPath -Path $metadata -MaximumBytes 65536)
    Assert-SkaoActivityMediaAcl -Path $metadata -Sid $Context.Sid
    try { $settings = [IO.File]::ReadAllText($metadata) | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'AI_MEDIA_GATEWAY: The existing gateway metadata could not be read.' }
    if ($settings.OwnerSid -cne $Context.Sid -or $settings.Version -ne 1) {
        throw 'AI_MEDIA_GATEWAY: The existing gateway does not belong to this account and setup version.'
    }
    $environmentFile = Join-Path $Context.GatewayRoot 'pi-connection/ai.env'
    [void](Assert-SkaoActivityMediaPath -Path $environmentFile -MaximumBytes 65536)
    Assert-SkaoActivityMediaAcl -Path $environmentFile -Sid $Context.Sid
    $matches = @([regex]::Matches([IO.File]::ReadAllText($environmentFile), '(?m)^SKAO_AI_TOKEN=([A-Za-z0-9_-]{43})\r?$'))
    if ($matches.Count -ne 1) { throw 'AI_MEDIA_GATEWAY: The existing protected gateway token is missing or ambiguous.' }
    return $matches[0].Groups[1].Value
}

function Get-SkaoActivityMediaSources {
    param([Parameter(Mandatory = $true)]$Context)
    $files = @()
    foreach ($name in @('activity_image_worker.py', 'activity_image_engine.py', 'run-activity-images.py', 'activity_image_layouts.py')) {
        $item = Assert-SkaoActivityMediaPath -Path (Join-Path $Context.Source $name)
        $files += [pscustomobject][ordered]@{ name = $name; bytes = [long]$item.Length;
            sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $identity = ($files | ForEach-Object { $_.name + ':' + $_.sha256 + ':' + $_.bytes }) -join "`n"
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
    return [pscustomobject]@{ id = $digest; files = $files }
}

function Get-SkaoActivityMediaReceipt {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)]$Sources)
    return [pscustomobject][ordered]@{ version = 1; ownerSid = $Context.Sid;
        imageRoot = $Context.ImageRoot; packageId = $Sources.id; files = @($Sources.files) }
}

function Get-SkaoActivityMediaConfiguration {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][string]$Token)
    return [pscustomobject][ordered]@{ version = 1; token = $Token; imageRoot = $Context.ImageRoot; workerRoot = $Context.Root }
}

function Get-SkaoActivityMediaLauncher {
    param([Parameter(Mandatory = $true)]$Sources)
    return @"
@echo off
setlocal
"%LOCALAPPDATA%\SKAO-ActivityImages\runtime\ComfyUI_windows_portable\python_embeded\python.exe" -s "%~dp0code\$($Sources.id)\activity_image_worker.py" --config "%~dp0config.json" > "%~dp0logs\worker.log" 2>&1
exit /b %errorlevel%
"@
}

function Read-SkaoActivityMediaJson {
    param([Parameter(Mandatory = $true)][string]$Path)
    [void](Assert-SkaoActivityMediaPath -Path $Path -MaximumBytes 65536)
    try { return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw 'AI_MEDIA_STATE: Managed worker metadata is not valid JSON.' }
}

function Assert-SkaoActivityMediaObject {
    param([Parameter(Mandatory = $true)]$Actual, [Parameter(Mandatory = $true)]$Expected)
    $keys = @($Expected.PSObject.Properties.Name | Sort-Object)
    if ((@($Actual.PSObject.Properties.Name | Sort-Object) -join ',') -cne ($keys -join ',')) {
        throw 'AI_MEDIA_CONFLICT: Existing worker metadata differs from this managed package; it was preserved.'
    }
    foreach ($key in $keys) {
        if ($Expected.$key -is [Array]) {
            if (@($Actual.$key).Count -ne @($Expected.$key).Count) { throw 'AI_MEDIA_CONFLICT: Existing worker file metadata differs; it was preserved.' }
            for ($i = 0; $i -lt @($Expected.$key).Count; $i++) {
                Assert-SkaoActivityMediaObject -Actual @($Actual.$key)[$i] -Expected @($Expected.$key)[$i]
            }
        }
        elseif (($Expected.$key -is [int] -or $Expected.$key -is [long]) -and
            (($Actual.$key -isnot [int] -and $Actual.$key -isnot [long]) -or [long]$Actual.$key -ne [long]$Expected.$key)) {
            throw 'AI_MEDIA_CONFLICT: Existing worker metadata has an unexpected numeric value; it was preserved.'
        }
        elseif ([string]$Actual.$key -cne [string]$Expected.$key) {
            throw 'AI_MEDIA_CONFLICT: Existing worker metadata differs from this managed package; it was preserved.'
        }
    }
}

function Assert-SkaoActivityMediaText {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][string]$Expected)
    [void](Assert-SkaoActivityMediaPath -Path $Path)
    $actual = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n").TrimEnd("`r", "`n")
    if ($actual -cne $Expected.Replace("`r`n", "`n").TrimEnd("`r", "`n")) {
        throw 'AI_MEDIA_CONFLICT: An existing managed worker file differs; it was preserved.'
    }
}

function Write-SkaoActivityMediaText {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][string]$Text)
    if (Test-Path -LiteralPath $Path) { Assert-SkaoActivityMediaText -Path $Path -Expected $Text; return }
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text)
    $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
}

function Assert-SkaoActivityMediaInstallation {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)]$Sources,
          [Parameter(Mandatory = $true)][string]$Token, [switch]$Complete)
    $rootExists = Test-Path -LiteralPath $Context.Root
    if (!$rootExists) { if ($Complete) { throw 'AI_MEDIA_MISSING: The activity image worker is not installed.' }; return }
    [void](Assert-SkaoActivityMediaPath -Path $Context.Root -Directory)
    Assert-SkaoActivityMediaAcl -Path $Context.Root -Sid $Context.Sid -Protected
    $receiptPath = Join-Path $Context.Root 'setup.json'
    if (!(Test-Path -LiteralPath $receiptPath)) {
        if (@(Get-ChildItem -LiteralPath $Context.Root -Force).Count -gt 0) {
            throw 'AI_MEDIA_CONFLICT: The worker destination contains unrecognized state; it was preserved.'
        }
        if ($Complete) { throw 'AI_MEDIA_MISSING: The activity image worker is not installed.' }
        return
    }
    Assert-SkaoActivityMediaAcl -Path $receiptPath -Sid $Context.Sid
    Assert-SkaoActivityMediaObject -Actual (Read-SkaoActivityMediaJson $receiptPath) -Expected (Get-SkaoActivityMediaReceipt $Context $Sources)
    $codeRoot = Join-Path $Context.Root ('code/' + $Sources.id)
    foreach ($directory in @('code', ('code/' + $Sources.id), 'jobs', 'logs')) {
        $path = Join-Path $Context.Root $directory
        if (Test-Path -LiteralPath $path) {
            [void](Assert-SkaoActivityMediaPath -Path $path -Directory)
            Assert-SkaoActivityMediaAcl -Path $path -Sid $Context.Sid
        }
        elseif ($Complete) { throw 'AI_MEDIA_MISSING: A managed worker directory is missing.' }
    }
    foreach ($entry in $Sources.files) {
        $path = Join-Path $codeRoot $entry.name
        if (Test-Path -LiteralPath $path) {
            $item = Assert-SkaoActivityMediaPath -Path $path
            Assert-SkaoActivityMediaAcl -Path $path -Sid $Context.Sid
            if ($item.Length -ne $entry.bytes -or
                (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) {
                throw 'AI_MEDIA_CONFLICT: Existing worker code differs from the managed package; it was preserved.'
            }
        }
        elseif ($Complete) { throw 'AI_MEDIA_MISSING: A managed worker companion is missing.' }
    }
    $configPath = Join-Path $Context.Root 'config.json'
    if (Test-Path -LiteralPath $configPath) {
        Assert-SkaoActivityMediaAcl -Path $configPath -Sid $Context.Sid
        Assert-SkaoActivityMediaObject -Actual (Read-SkaoActivityMediaJson $configPath) -Expected (Get-SkaoActivityMediaConfiguration $Context $Token)
    }
    elseif ($Complete) { throw 'AI_MEDIA_MISSING: The private worker configuration is missing.' }
    $launcher = Join-Path $Context.Root 'Run-ActivityMedia.cmd'
    if (Test-Path -LiteralPath $launcher) {
        Assert-SkaoActivityMediaAcl -Path $launcher -Sid $Context.Sid
        Assert-SkaoActivityMediaText -Path $launcher -Expected (Get-SkaoActivityMediaLauncher $Sources)
    }
    elseif ($Complete) { throw 'AI_MEDIA_MISSING: The managed worker launcher is missing.' }
}

function Resolve-SkaoActivityMediaSid {
    param([string]$Identity)
    if ($Identity -match '^S-1-\d+(?:-\d+)+$') { return $Identity }
    try { return (New-Object Security.Principal.NTAccount($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'AI_MEDIA_TASK_CONFLICT: The worker task identity could not be verified.' }
}

function Assert-SkaoActivityMediaTask {
    param([Parameter(Mandatory = $true)]$Task, [Parameter(Mandatory = $true)]$Context)
    $launcher = Join-Path $Context.Root 'Run-ActivityMedia.cmd'
    $actions = @($Task.Actions); $triggers = @($Task.Triggers); $settings = $Task.Settings
    if ([string]$Task.TaskPath -ne '\' -or (Resolve-SkaoActivityMediaSid ([string]$Task.Principal.UserId)) -cne $Context.Sid -or
        [string]$Task.Principal.LogonType -ne 'Password' -or [string]$Task.Principal.RunLevel -ne 'Limited' -or
        $actions.Count -ne 1 -or [string]$actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32/cmd.exe') -or
        [string]$actions[0].Arguments -cne ('/d /c ""{0}""' -f $launcher) -or
        [string]$actions[0].WorkingDirectory -ine $Context.Root -or
        $triggers.Count -ne 1 -or [string]$triggers[0].CimClass.CimClassName -ne 'MSFT_TaskBootTrigger' -or
        [string]$triggers[0].Delay -notin @('PT60S', 'PT1M') -or [string]$triggers[0].Enabled -ne 'True' -or
        [int]$settings.Priority -ne 7 -or [string]$settings.MultipleInstances -ne 'IgnoreNew' -or
        [int]$settings.RestartCount -ne 3 -or [string]$settings.RestartInterval -ne 'PT1M' -or
        [string]$settings.ExecutionTimeLimit -ne 'PT0S' -or [string]$settings.Enabled -ne 'True' -or
        [string]$settings.DisallowStartIfOnBatteries -ne 'False' -or [string]$settings.StopIfGoingOnBatteries -ne 'False' -or
        [string]$Task.State -notin @('Running', 'Ready')) {
        throw 'AI_MEDIA_TASK_CONFLICT: An existing worker task differs from the managed definition; it was preserved.'
    }
}

function Test-SkaoActivityMediaUnrestrictedPackage {
    param($Application)
    if ($null -eq $Application) { return $false }
    $package = $Application.PSObject.Properties['Package']
    if ($null -eq $package) { return $false }
    # MS-FASP FW_RULE: a null package condition applies to all processes.
    # Require the property to exist; do not normalize missing or malformed data.
    return ($null -eq $package.Value -or ($package.Value -is [string] -and $package.Value -eq 'Any'))
}

function Assert-SkaoActivityMediaRawRule {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$Port)
    $rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Name $Name -ErrorAction Stop)
    if ($rules.Count -ne 1) { throw 'AI_MEDIA_FIREWALL: A required raw image port block is missing or ambiguous.' }
    $rule = $rules[0]
    $addresses = @($rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
    $ports = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop)
    $apps = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
    $services = @($rule | Get-NetFirewallServiceFilter -ErrorAction Stop)
    $interfaces = @($rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop)
    $types = @($rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop)
    $security = @($rule | Get-NetFirewallSecurityFilter -ErrorAction Stop)
    if ([string]$rule.Enabled -ne 'True' -or [string]$rule.Direction -ne 'Inbound' -or
        [string]$rule.Action -ne 'Block' -or [string]$rule.Profile -ne 'Any' -or
        $addresses.Count -ne 1 -or $ports.Count -ne 1 -or $apps.Count -ne 1 -or $services.Count -ne 1 -or
        $interfaces.Count -ne 1 -or $types.Count -ne 1 -or $security.Count -ne 1 -or
        [string]$addresses[0].LocalAddress -ne 'Any' -or [string]$addresses[0].RemoteAddress -ne 'Any' -or
        [string]$ports[0].Protocol -notin @('TCP', '6') -or [string]$ports[0].LocalPort -ne $Port -or
        [string]$ports[0].RemotePort -ne 'Any' -or [string]$apps[0].Program -ne 'Any' -or !(Test-SkaoActivityMediaUnrestrictedPackage -Application $apps[0]) -or
        [string]$services[0].Service -ne 'Any' -or [string]$interfaces[0].InterfaceAlias -ne 'Any' -or
        [string]$types[0].InterfaceType -ne 'Any' -or [string]$security[0].Authentication -ne 'NotRequired' -or
        [string]$security[0].Encryption -ne 'NotRequired' -or [string]$security[0].OverrideBlockRules -ne 'False' -or
        [string]$security[0].LocalUser -ne 'Any' -or [string]$security[0].RemoteUser -ne 'Any' -or
        [string]$security[0].RemoteMachine -ne 'Any') {
        throw 'AI_MEDIA_FIREWALL: A raw image port rule differs from the exact all-profile block; it was preserved.'
    }
}

function Get-SkaoActivityMediaRawRules {
    return @([pscustomobject]@{ Name = 'SKAO-ActivityImages-Block-Remote'; Port = '11435' },
        [pscustomobject]@{ Name = 'SKAO-ComfyUI-Block-Remote'; Port = '8188' })
}

function Ensure-SkaoActivityMediaRawRules {
    param([switch]$Check)
    foreach ($entry in (Get-SkaoActivityMediaRawRules)) {
        $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $entry.Name -ErrorAction SilentlyContinue)
        if ($rules.Count -gt 1) { throw 'AI_MEDIA_FIREWALL: Multiple raw image port rules were found.' }
        if ($rules.Count -eq 0) {
            if ($Check) { throw 'AI_MEDIA_FIREWALL: A raw image port block is missing. Check mode made no changes.' }
            New-NetFirewallRule -PolicyStore PersistentStore -Name $entry.Name -DisplayName ('SKAO block direct remote TCP ' + $entry.Port) `
                -Direction Inbound -Action Block -Enabled True -Profile Any -Protocol TCP -LocalPort $entry.Port `
                -RemotePort Any -LocalAddress Any -RemoteAddress Any -Program Any -Service Any -InterfaceType Any | Out-Null
        }
        Assert-SkaoActivityMediaRawRule -Name $entry.Name -Port $entry.Port
    }
}

function Assert-SkaoActivityMediaAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'AI_MEDIA_ADMIN: Creating the worker task or firewall rules needs an elevated session under this AI account.'
    }
}

function Register-SkaoActivityMediaTask {
    param([Parameter(Mandatory = $true)]$Context)
    $launcher = Join-Path $Context.Root 'Run-ActivityMedia.cmd'
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32/cmd.exe') `
        -Argument ('/d /c ""{0}""' -f $launcher) -WorkingDirectory $Context.Root
    $trigger = New-ScheduledTaskTrigger -AtStartup; $trigger.Delay = 'PT60S'
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 7 `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $Context.Account -LogonType Password -RunLevel Limited
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
    $password = Read-Host 'Windows password for this AI account (local prompt; not Hello PIN)' -AsSecureString
    try {
        $credential = New-Object Management.Automation.PSCredential($Context.Account, $password)
        Register-ScheduledTask -TaskName $script:SkaoActivityMediaTask -TaskPath '\' -InputObject $definition `
            -User $Context.Account -Password ($credential.GetNetworkCredential().Password) | Out-Null
    }
    finally { $credential = $null; if ($password) { $password.Dispose() } }
}

function Assert-SkaoActivityMediaStatus {
    param([Parameter(Mandatory = $true)]$Status)
    if (($Status.version -isnot [int] -and $Status.version -isnot [long]) -or $Status.version -ne 1 -or
        $Status.enabled -isnot [bool] -or !$Status.enabled -or
        $Status.available -isnot [bool] -or !$Status.available -or $Status.busy -isnot [bool] -or
        [string]$Status.model -cne 'sd_xl_base_1.0.safetensors') {
        throw 'AI_MEDIA_STATUS: The local worker did not confirm its expected ready capabilities.'
    }
}

function Invoke-SkaoActivityMediaStatus {
    param([Parameter(Mandatory = $true)][string]$Token,
          [ValidateRange(1, 5)][int]$TimeoutSeconds = 2)
    $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:11435/api/activity-images/status')
    $request.Proxy = $null; $request.AllowAutoRedirect = $false; $request.KeepAlive = $false
    $request.Timeout = $TimeoutSeconds * 1000; $request.ReadWriteTimeout = $TimeoutSeconds * 1000
    $request.Headers['Authorization'] = 'Bearer ' + $Token
    $response = $null; $inputStream = $null; $memory = $null
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200 -or [string]$response.ContentType -notmatch '^application/json(?:;|$)') {
            throw 'AI_MEDIA_STATUS'
        }
        $inputStream = $response.GetResponseStream(); $memory = New-Object IO.MemoryStream
        $buffer = New-Object byte[] 4096
        while ($true) {
            $remaining = ($TimeoutSeconds * 1000) - $clock.Elapsed.TotalMilliseconds
            if ($remaining -le 0) { throw 'AI_MEDIA_STATUS' }
            $pending = $inputStream.ReadAsync($buffer, 0, $buffer.Length)
            if (!$pending.Wait([Math]::Max(1, [int][Math]::Ceiling($remaining)))) { throw 'AI_MEDIA_STATUS' }
            $read = $pending.GetAwaiter().GetResult()
            if ($clock.Elapsed.TotalMilliseconds -gt $TimeoutSeconds * 1000) { throw 'AI_MEDIA_STATUS' }
            if ($read -le 0) { break }
            if ($memory.Length + $read -gt 16384) { throw 'AI_MEDIA_STATUS' }
            $memory.Write($buffer, 0, $read)
        }
        $status = [Text.Encoding]::UTF8.GetString($memory.ToArray()) | ConvertFrom-Json -ErrorAction Stop
        Assert-SkaoActivityMediaStatus -Status $status
        return $status
    }
    catch { throw 'AI_MEDIA_STATUS: The authenticated loopback worker status could not be verified.' }
    finally {
        $clock.Stop()
        if ($inputStream) { $inputStream.Dispose() }; if ($memory) { $memory.Dispose() }
        if ($response) { $response.Dispose() }; $request.Abort()
    }
}

function Wait-SkaoActivityMediaReady {
    param([Parameter(Mandatory = $true)][string]$Token, [switch]$Check)
    if ($Check) { $null = Invoke-SkaoActivityMediaStatus -Token $Token; return }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        try { $null = Invoke-SkaoActivityMediaStatus -Token $Token; return }
        catch { if ([string]$_.Exception.Message -notlike 'AI_MEDIA_STATUS:*') { throw } }
        if ($watch.Elapsed.TotalSeconds -ge 30) { break }
        Start-Sleep -Milliseconds 500
    } while ($watch.Elapsed.TotalSeconds -lt 30)
    throw 'AI_MEDIA_STATUS: The worker readiness deadline expired. Review its protected local log.'
}

function Invoke-SkaoActivityMediaSetup {
    param([switch]$Check)
    $context = Get-SkaoActivityMediaContext
    $gatewayScript = Join-Path $context.Source 'Setup-Gateway.ps1'
    Invoke-SkaoActivityMediaChild -Script $gatewayScript -Options @{ Check = $true }
    Invoke-SkaoActivityMediaChild -Script (Join-Path $context.Source 'Setup-ActivityImages.ps1') -Options @{ Check = $true; CompareSDXL = $true }
    $token = Get-SkaoActivityMediaToken -Context $context
    $sources = Get-SkaoActivityMediaSources -Context $context
    $python = Join-Path $context.ImageRoot 'runtime/ComfyUI_windows_portable/python_embeded/python.exe'
    [void](Assert-SkaoActivityMediaPath -Path $python -MaximumBytes 1073741824)
    Assert-SkaoActivityMediaInstallation -Context $context -Sources $sources -Token $token
    $tasks = @(Get-ScheduledTask -TaskName $script:SkaoActivityMediaTask -TaskPath '\' -ErrorAction SilentlyContinue)
    if ($tasks.Count -gt 1) { throw 'AI_MEDIA_TASK_CONFLICT: Multiple worker tasks were found.' }
    $task = $null
    if ($tasks.Count -eq 1) { $task = $tasks[0]; Assert-SkaoActivityMediaTask -Task $task -Context $context }
    if ($task -and !(Test-Path -LiteralPath (Join-Path $context.Root 'setup.json'))) {
        throw 'AI_MEDIA_CONFLICT: A worker task exists without recognized private setup state; it was preserved.'
    }
    if ($Check) {
        Assert-SkaoActivityMediaInstallation -Context $context -Sources $sources -Token $token -Complete
        if (!$task -or [string]$task.State -ne 'Running') { throw 'AI_MEDIA_NOT_RUNNING: The worker task is missing or stopped. Check mode made no changes.' }
        Ensure-SkaoActivityMediaRawRules -Check
        Wait-SkaoActivityMediaReady -Token $token -Check
        Invoke-SkaoActivityMediaChild -Script $gatewayScript -Options @{ Check = $true; ActivityImages = $true }
        Write-Output 'PASS: private managed activity image worker and gateway routes'
        return
    }
    $complete = $false
    try { Assert-SkaoActivityMediaInstallation -Context $context -Sources $sources -Token $token -Complete; $complete = $true }
    catch { if ([string]$_.Exception.Message -notlike 'AI_MEDIA_MISSING:*') { throw } }
    $rulesComplete = $true
    foreach ($entry in (Get-SkaoActivityMediaRawRules)) {
        $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $entry.Name -ErrorAction SilentlyContinue)
        if ($rules.Count -gt 1) { throw 'AI_MEDIA_FIREWALL: Multiple raw image port rules were found.' }
        if ($rules.Count -eq 1) { Assert-SkaoActivityMediaRawRule -Name $entry.Name -Port $entry.Port }
        else { $rulesComplete = $false }
    }
    if (!$complete -or !$task -or !$rulesComplete) { Assert-SkaoActivityMediaAdministrator }
    if (!$complete) {
        if (!(Test-Path -LiteralPath $context.Root)) { [void](New-Item -ItemType Directory -Path $context.Root); Set-SkaoActivityMediaRootAcl -Path $context.Root -Sid $context.Sid }
        $lock = $null
        try {
            try { $lock = New-Object IO.FileStream((Join-Path $context.Root 'setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
            catch { throw 'AI_MEDIA_BUSY: Another worker setup is using this installation.' }
            $receiptPath = Join-Path $context.Root 'setup.json'
            if (!(Test-Path -LiteralPath $receiptPath)) {
                Write-SkaoActivityMediaText -Path $receiptPath -Text ((Get-SkaoActivityMediaReceipt $context $sources) | ConvertTo-Json -Depth 8)
            }
            foreach ($name in @('jobs', 'logs', 'code', ('code/' + $sources.id))) {
                $directory = Join-Path $context.Root $name
                if (!(Test-Path -LiteralPath $directory)) { [void](New-Item -ItemType Directory -Path $directory) }
                [void](Assert-SkaoActivityMediaPath -Path $directory -Directory)
            }
            foreach ($entry in $sources.files) {
                $destination = Join-Path $context.Root ('code/' + $sources.id + '/' + $entry.name)
                if (!(Test-Path -LiteralPath $destination)) { [IO.File]::Copy((Join-Path $context.Source $entry.name), $destination) }
            }
            $configuration = Get-SkaoActivityMediaConfiguration $context $token
            $configPath = Join-Path $context.Root 'config.json'
            if (!(Test-Path -LiteralPath $configPath)) { Write-SkaoActivityMediaText -Path $configPath -Text ($configuration | ConvertTo-Json -Depth 6) }
            Write-SkaoActivityMediaText -Path (Join-Path $context.Root 'Run-ActivityMedia.cmd') -Text (Get-SkaoActivityMediaLauncher $sources)
            Assert-SkaoActivityMediaInstallation -Context $context -Sources $sources -Token $token -Complete
        }
        finally { if ($lock) { $lock.Dispose() } }
    }
    Ensure-SkaoActivityMediaRawRules
    if (!$task) { Register-SkaoActivityMediaTask -Context $context }
    $task = Get-ScheduledTask -TaskName $script:SkaoActivityMediaTask -TaskPath '\' -ErrorAction Stop
    Assert-SkaoActivityMediaTask -Task $task -Context $context
    if ([string]$task.State -ne 'Running') { Start-ScheduledTask -TaskName $script:SkaoActivityMediaTask -TaskPath '\' -ErrorAction Stop }
    Wait-SkaoActivityMediaReady -Token $token
    Invoke-SkaoActivityMediaChild -Script $gatewayScript -Options @{ ActivityImages = $true }
    Write-Output 'PASS: private managed activity image worker and gateway routes'
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-SkaoActivityMediaSetup -Check:$Check; $global:LASTEXITCODE = 0 }
    catch {
        $code = 'AI_MEDIA_SETUP'
        if ([string]$_.Exception.Message -match '^(AI_MEDIA_[A-Z_]+):') { $code = $Matches[1] }
        Write-Error ($code + ': Activity image setup stopped. Existing AI keys, models and gateway state were preserved.') -ErrorAction Continue
        exit 1
    }
}
