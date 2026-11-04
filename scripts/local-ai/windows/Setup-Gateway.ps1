#Requires -Version 5.1
[CmdletBinding()]
param([switch]$Check, [switch]$ActivityImages, [string]$LaptopIp, [string]$PiIp, [string]$ArchivePath)

$ErrorActionPreference = 'Stop'
$aiTaskName = 'SKAO AI Gateway'
$aiFirewallName = 'SKAO-AI-Gateway-From-Pi'
$aiModel = 'qwen3:4b-instruct-2507-q4_K_M'
$aiVersion = '2.11.7'
$aiZipHash = '0a1edc0b799512051c57071ce0e798d3f2cf67dc98171366f1d2b326072e3b06'
$aiExeHash = '5f93a9bd555f3aac9d33af2756ba14b3519d8cca4ffd55256bdaeab444c9db2a'
$aiModelDigest = '0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0'
$aiRoot = Join-Path $env:LOCALAPPDATA 'SKAO-AI'
$aiGateway = Join-Path $aiRoot 'gateway'
$aiMetadataPath = Join-Path $aiGateway 'setup.json'
$aiBinary = Join-Path $aiGateway 'caddy.exe'
$aiConfig = Join-Path $aiGateway 'Caddyfile'
$aiLauncher = Join-Path $aiGateway 'Run-Gateway.cmd'
$aiExport = Join-Path $aiGateway 'pi-connection'
$aiPublicCa = Join-Path $aiGateway 'data\pki\authorities\local\root.crt'
$aiIdentity = $null
$aiSid = $null

function Stop-Skao([string]$Message) {
    $errorObject = New-Object System.InvalidOperationException -ArgumentList $Message
    $errorObject.Data['SkaoSafe'] = $true
    throw $errorObject
}

function Assert-SkaoRawFirewall {
    param([string]$RuleName = 'SKAO-Ollama-Block-Remote', [string]$RawPort = '11434')
    $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop)
    if ($profiles.Count -ne 3) { Stop-Skao 'The three Windows firewall profiles could not be verified.' }
    foreach ($name in @('Domain', 'Private', 'Public')) {
        $profile = @($profiles | Where-Object { [string]$_.Name -eq $name })
        if ($profile.Count -ne 1 -or [string]$profile[0].Enabled -ne 'True' -or
            [string]$profile[0].AllowLocalFirewallRules -eq 'False') {
            Stop-Skao 'All Windows firewall profiles must be enabled and permit local firewall rules.'
        }
        $disabledInterfaces = @($profile[0].DisabledInterfaceAliases | Where-Object {
            $_ -and [string]$_ -ne 'NotConfigured'
        })
        if ($disabledInterfaces.Count -gt 0) {
            Stop-Skao 'A Windows firewall profile excludes network interfaces. Raw-port isolation cannot be confirmed.'
        }
    }
    $rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Name $RuleName -ErrorAction Stop)
    if ($rules.Count -ne 1) { Stop-Skao 'The dedicated raw Ollama firewall rule could not be verified.' }
    $rule = $rules[0]
    if ([string]$rule.Enabled -ne 'True' -or [string]$rule.Direction -ne 'Inbound' -or
        [string]$rule.Action -ne 'Block' -or [string]$rule.Profile -ne 'Any') {
        Stop-Skao 'The dedicated raw Ollama rule must block inbound traffic on every firewall profile.'
    }
    $addresses = @($rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
    $ports = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop)
    $applications = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
    $services = @($rule | Get-NetFirewallServiceFilter -ErrorAction Stop)
    $interfaces = @($rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop)
    $interfaceTypes = @($rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop)
    $security = @($rule | Get-NetFirewallSecurityFilter -ErrorAction Stop)
    if ($addresses.Count -ne 1 -or $ports.Count -ne 1 -or $applications.Count -ne 1 -or
        $services.Count -ne 1 -or $interfaces.Count -ne 1 -or $interfaceTypes.Count -ne 1 -or
        $security.Count -ne 1) {
        Stop-Skao 'The dedicated raw Ollama rule filters could not be verified.'
    }
    if ([string]$addresses[0].LocalAddress -ne 'Any' -or [string]$addresses[0].RemoteAddress -ne 'Any' -or
        [string]$ports[0].Protocol -notin @('TCP', '6') -or [string]$ports[0].LocalPort -ne $RawPort -or
        [string]$ports[0].RemotePort -ne 'Any' -or [string]$applications[0].Program -ne 'Any' -or
        [string]$applications[0].Package -ne 'Any' -or [string]$services[0].Service -ne 'Any' -or
        [string]$interfaces[0].InterfaceAlias -ne 'Any' -or [string]$interfaceTypes[0].InterfaceType -ne 'Any') {
        Stop-Skao 'The dedicated raw Ollama firewall rule has an unexpected address, port, application, service or interface restriction.'
    }
    if ([string]$security[0].Authentication -ne 'NotRequired' -or
        [string]$security[0].Encryption -ne 'NotRequired' -or
        [string]$security[0].OverrideBlockRules -ne 'False' -or
        [string]$security[0].LocalUser -ne 'Any' -or [string]$security[0].RemoteUser -ne 'Any' -or
        [string]$security[0].RemoteMachine -ne 'Any') {
        Stop-Skao 'The dedicated raw Ollama firewall rule has an unexpected authentication or identity restriction.'
    }
}

function Ensure-SkaoRawFirewall {
    $existing = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name 'SKAO-Ollama-Block-Remote' -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 1) { Stop-Skao 'Multiple dedicated raw Ollama firewall rules were found.' }
    if ($existing.Count -eq 0) {
        New-NetFirewallRule -PolicyStore PersistentStore -Name 'SKAO-Ollama-Block-Remote' `
            -DisplayName 'SKAO block direct remote Ollama access' -Direction Inbound -Action Block `
            -Enabled True -Profile Any -Protocol TCP -LocalPort 11434 -RemotePort Any `
            -LocalAddress Any -RemoteAddress Any -Program Any -Service Any -InterfaceType Any | Out-Null
    }
    Assert-SkaoRawFirewall
}

function Assert-SkaoRuntimeConfiguration {
    param([Parameter(Mandatory = $true)][string]$AiRoot)
    $launcher = Join-Path $AiRoot 'Run-Ollama.cmd'
    Assert-ProtectedPath $AiRoot -Directory
    Assert-ProtectedPath $launcher
    $expected = @'
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
    Assert-Text $launcher $expected
    $tasks = @(Get-ScheduledTask -TaskName 'SKAO Local AI' -ErrorAction Stop)
    if ($tasks.Count -ne 1 -or [string]$tasks[0].State -ne 'Running') {
        Stop-Skao 'The SKAO Local AI task must be Running. Run Setup-Ollama.ps1 first.'
    }
    $task = $tasks[0]
    Assert-ManagedTask $task $launcher $AiRoot 30
    return [pscustomobject]@{ HostConfigured = '127.0.0.1:11434'; StartupTaskState = 'Running' }
}

function Invoke-SkaoGatewayCurl {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$CaFile,
        [ValidateRange(0.05, 10)][double]$TimeoutSeconds = 2,
        [switch]$IncludeProfile
    )
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (!(Test-Path -LiteralPath $curl -PathType Leaf)) { Stop-Skao 'The Windows curl executable was not found.' }
    $limit = $TimeoutSeconds.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        $arguments = @('-q', '--noproxy', '*', '--silent', '--show-error', '--connect-timeout', $limit,
            '--max-time', $limit, '--ssl-revoke-best-effort', '--cacert', $CaFile, '--output', 'NUL', '--write-out', '%{http_code}')
        if ($IncludeProfile) { $arguments += @('--dump-header', '-') }
        $lines = @(& $curl @arguments $Url 2>&1)
        $nativeExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    return [pscustomobject]@{ Lines = $lines; ExitCode = $nativeExitCode }
}

function Wait-SkaoGatewayHttps {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$CaFile,
        [ValidateRange(1, 60)][int]$TimeoutSeconds = 30,
        [ValidateSet('', 'activity-images-v1')][string]$ExpectedProfile = ''
    )
    $lastResponse = $null
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
            $remaining = $TimeoutSeconds - $watch.Elapsed.TotalSeconds
            if (Test-Path -LiteralPath $CaFile -PathType Leaf) {
                $limit = [Math]::Min(2.0, $remaining)
                if ($limit -lt 0.05) { break }
                $curlOptions = @{ Url = $Url; CaFile = $CaFile; TimeoutSeconds = $limit }
                if ($ExpectedProfile) { $curlOptions.IncludeProfile = $true }
                $response = Invoke-SkaoGatewayCurl @curlOptions
                $lastResponse = $response
                $responseLines = @($response.Lines | ForEach-Object { ([string]$_).Trim() })
                $responseStatuses = @($responseLines | Where-Object { $_ -cmatch '^\d{3}$' })
                $profileConfirmed = !$ExpectedProfile -or @($responseLines | Where-Object {
                    $_ -imatch ('^X-SKAO-Gateway-Profile:\s*' + [regex]::Escape($ExpectedProfile) + '\s*$')
                }).Count -eq 1
                if ($null -ne $response.ExitCode -and $response.ExitCode -eq 0 -and
                    $responseStatuses.Count -gt 0 -and $responseStatuses[$responseStatuses.Count - 1] -ceq '403' -and $profileConfirmed) { return }
            }
            $remaining = $TimeoutSeconds - $watch.Elapsed.TotalSeconds
            if ($remaining -le 0) { break }
            Start-Sleep -Milliseconds ([int][Math]::Min(500.0, $remaining * 1000.0))
        }
    }
    finally { $watch.Stop() }
    if ($null -eq $lastResponse) {
        Stop-Skao 'Gateway HTTPS readiness deadline expired. LastCurlExitCode=NotRun; LastHttpStatus=NotObserved. Check the public CA file and gateway startup.'
    }
    $lastCode = [string]$lastResponse.ExitCode
    if ([string]::IsNullOrWhiteSpace($lastCode)) { $lastCode = 'Unknown' }
    $lines = @($lastResponse.Lines | ForEach-Object { ([string]$_).Trim() })
    $statuses = @($lines | Where-Object { $_ -cmatch '^\d{3}$' })
    $lastStatus = 'NotObserved'
    if ($statuses.Count -gt 0) { $lastStatus = $statuses[$statuses.Count - 1] }
    $summaries = @($lines | Where-Object { $_ -imatch '^curl:\s*\(\d+\)' })
    $detail = ''
    if ($summaries.Count -gt 0) {
        $detail = $summaries[0]
        foreach ($sensitive in @($CaFile, $Url, $env:USERPROFILE)) {
            if (![string]::IsNullOrWhiteSpace([string]$sensitive)) {
                $detail = [regex]::Replace($detail, [regex]::Escape([string]$sensitive), '<local path or gateway>', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            }
        }
        try {
            $gatewayHost = ([Uri]$Url).Host
            if ($gatewayHost) { $detail = [regex]::Replace($detail, [regex]::Escape($gatewayHost), '<gateway address>', [Text.RegularExpressions.RegexOptions]::IgnoreCase) }
        }
        catch { }
        $detail = $detail -ireplace '(Bearer\s+)[A-Za-z0-9_-]{32,256}', '$1[redacted]'
        $detail = ($detail -replace '\s+', ' ').Trim()
        if ($detail.Length -gt 500) { $detail = $detail.Substring(0, 500) }
    }
    $message = 'Gateway HTTPS readiness deadline expired. LastCurlExitCode={0}; LastHttpStatus={1}.' -f $lastCode, $lastStatus
    if ($detail) { $message += ' ' + $detail }
    if ($lastCode -eq '60' -and ($lines -join "`n") -imatch '(revocation status (?:is )?unknown|CERT_TRUST_REVOCATION_STATUS_UNKNOWN|CRYPT_E_NO_REVOCATION_CHECK|CRYPT_E_REVOCATION_OFFLINE)') {
        $message += ' Schannel revocation information remains unavailable in best-effort mode; inspect the private CA chain. The pinned CA and certificate-name checks remain enabled.'
    }
    Stop-Skao $message
}

function Invoke-SkaoLocalCurl {
    param([Parameter(Mandatory = $true)][ValidateSet('/api/status', '/api/tags')][string]$Path)
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (!(Test-Path -LiteralPath $curl -PathType Leaf)) { Stop-Skao 'The Windows curl executable was not found.' }
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        $lines = @(& $curl -q --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 10 --max-filesize 1048576 --write-out '\n%{http_code}' ('http://127.0.0.1:11434' + $Path) 2>&1)
        $nativeExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    return [pscustomobject]@{ Lines = $lines; ExitCode = $nativeExitCode }
}

function Invoke-SkaoLocalJson {
    param([Parameter(Mandatory = $true)][ValidateSet('/api/status', '/api/tags')][string]$Path)
    $response = Invoke-SkaoLocalCurl -Path $Path
    $lines = @($response.Lines)
    if ($null -eq $response.ExitCode -or $response.ExitCode -ne 0 -or
        $lines.Count -lt 2 -or [string]$lines[$lines.Count - 1] -cne '200') {
        Stop-Skao 'The direct localhost Ollama HTTP request did not return HTTP 200.'
    }
    $body = (($lines | Select-Object -SkipLast 1) -join "`n").Trim()
    if ([Text.Encoding]::UTF8.GetByteCount($body) -gt 1048576 -or
        !$body.StartsWith('{') -or !$body.EndsWith('}')) {
        Stop-Skao 'The direct localhost Ollama response is not a bounded JSON object.'
    }
    try { $parsed = ConvertFrom-Json -InputObject $body -ErrorAction Stop }
    catch { Stop-Skao 'The direct localhost Ollama response is not valid JSON.' }
    if ($null -eq $parsed -or $parsed -isnot [pscustomobject]) {
        Stop-Skao 'The direct localhost Ollama response is not a JSON object.'
    }
    return $parsed
}

function Test-PrivateIPv4([string]$Address) {
    if ($Address -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { return $false }
    $parts = @($Address.Split('.') | ForEach-Object { [int]$_ })
    if (@($parts | Where-Object { $_ -gt 255 }).Count -gt 0) { return $false }
    if (($parts -join '.') -cne $Address) { return $false }
    return ($parts[0] -eq 10 -or
        ($parts[0] -eq 172 -and $parts[1] -ge 16 -and $parts[1] -le 31) -or
        ($parts[0] -eq 192 -and $parts[1] -eq 168))
}

function Assert-NoLink([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            Stop-Skao 'A setup path is a link or junction. Use a normal directory under the AI account.'
        }
    }
}

function Write-Utf8([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Assert-ProtectedPath {
    param([string]$Path, [switch]$Directory, [long]$MaximumLength = 1048576)
    Assert-NoLink $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ([bool]$item.PSIsContainer -ne [bool]$Directory -or (!$Directory -and $item.Length -gt $MaximumLength)) {
        Stop-Skao 'A protected setup item has an unexpected type or size.'
    }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    try { $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value }
    catch { Stop-Skao 'A protected setup item owner could not be verified.' }
    if ($owner -notin @($aiSid, 'S-1-5-18', 'S-1-5-32-544')) {
        Stop-Skao 'A protected setup item has an unexpected owner.'
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ([string]$rule.AccessControlType -eq 'Allow' -and
            $rule.IdentityReference.Value -notin @($aiSid, 'S-1-5-18', 'S-1-5-32-544')) {
            Stop-Skao 'A protected setup item allows another account or group access.'
        }
    }
}

function Assert-ProtectedTree {
    # Check before descending; never follow a junction during recursive inspection.
    $pending = New-Object 'Collections.Generic.Queue[string]'
    $pending.Enqueue($aiGateway)
    $count = 0
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        Assert-ProtectedPath $directory -Directory
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            $count++
            if ($count -gt 1000) { Stop-Skao 'The gateway directory contains too many items for safe adoption.' }
            Assert-NoLink $item.FullName
            if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
            else { Assert-ProtectedPath $item.FullName -MaximumLength 1073741824 }
        }
    }
}

function Protect-GatewayDirectory {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $owner = New-Object Security.Principal.SecurityIdentifier($aiSid)
    $acl.SetOwner($owner)
    foreach ($sidText in @($aiSid, 'S-1-5-18', 'S-1-5-32-544')) {
        $sid = New-Object Security.Principal.SecurityIdentifier($sidText)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $aiGateway -AclObject $acl
}

function Get-NormalizedText([string]$Text) {
    return $Text.Replace("`r`n", "`n").TrimEnd("`n")
}

function Assert-Text([string]$Path, [string]$Expected) {
    Assert-ProtectedPath $Path
    $actual = [IO.File]::ReadAllText($Path)
    if ((Get-NormalizedText $actual) -cne (Get-NormalizedText $Expected)) {
        Stop-Skao 'An existing managed setup file differs from the saved setup. It was left unchanged.'
    }
}

function Get-PrincipalSid($Principal) {
    $value = [string]$Principal.UserId
    if ($value -match '^S-1-') { return $value }
    try {
        $account = New-Object Security.Principal.NTAccount($value)
        return $account.Translate([Security.Principal.SecurityIdentifier]).Value
    }
    catch { Stop-Skao 'A scheduled task account could not be verified.' }
}

function Assert-ManagedTask($Task, [string]$Launcher, [string]$WorkingDirectory, [int]$Delay) {
    if ($null -eq $Task) { Stop-Skao 'A managed startup task is missing.' }
    $actions = @($Task.Actions)
    $triggers = @($Task.Triggers)
    $settings = $Task.Settings
    if ((Get-PrincipalSid $Task.Principal) -cne $aiSid -or
        [string]$Task.Principal.RunLevel -ne 'Limited' -or
        [string]$Task.Principal.LogonType -ne 'Password' -or
        $actions.Count -ne 1 -or
        [string]$actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32\cmd.exe') -or
        [string]$actions[0].Arguments -cne ('/d /c ""{0}""' -f $Launcher) -or
        [string]$actions[0].WorkingDirectory -ine $WorkingDirectory -or
        $triggers.Count -ne 1 -or
        [string]$triggers[0].CimClass.CimClassName -ne 'MSFT_TaskBootTrigger' -or
        [string]$triggers[0].Delay -ne ('PT{0}S' -f $Delay) -or
        [string]$triggers[0].Enabled -ne 'True' -or
        $settings.Priority -ne 7 -or [string]$settings.MultipleInstances -ne 'IgnoreNew' -or
        $settings.RestartCount -ne 3 -or [string]$settings.RestartInterval -ne 'PT1M' -or
        [string]$settings.ExecutionTimeLimit -ne 'PT0S' -or
        [string]$settings.DisallowStartIfOnBatteries -ne 'False' -or
        [string]$settings.StopIfGoingOnBatteries -ne 'False' -or
        [string]$settings.Enabled -ne 'True') {
        Stop-Skao 'An existing startup task differs from the saved setup. It was left unchanged.'
    }
}

function Assert-LocalRuntime {
    $null = Assert-SkaoRuntimeConfiguration -AiRoot $aiRoot
    $status = Invoke-SkaoLocalJson -Path '/api/status'
    if ($status.cloud.disabled -isnot [bool] -or $status.cloud.disabled -ne $true) {
        Stop-Skao 'Ollama did not confirm cloud.disabled=true.'
    }
    $tags = Invoke-SkaoLocalJson -Path '/api/tags'
    $installed = @($tags.models | Where-Object { $_.name -ceq $aiModel -or $_.model -ceq $aiModel })
    if ($installed.Count -ne 1 -or $installed[0].digest -cne $aiModelDigest -or $installed[0].size -le 0) {
        Stop-Skao 'The required pinned local Instruct model was not found. Run Setup-Ollama.ps1 first.'
    }
}

function Assert-Network($Settings) {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $Settings.LaptopIp -ErrorAction Stop)
    if ($addresses.Count -ne 1) { Stop-Skao 'The saved laptop address is not assigned to one local interface.' }
    $profiles = @(Get-NetConnectionProfile -InterfaceIndex $addresses[0].InterfaceIndex -ErrorAction Stop)
    if ($profiles.Count -ne 1 -or [string]$profiles[0].NetworkCategory -ne 'Private') {
        Stop-Skao 'The selected trusted Windows LAN must already be Private. The script does not change network categories.'
    }
}

function Assert-GatewayFirewall($Settings) {
    $rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Name $aiFirewallName -ErrorAction Stop)
    if ($rules.Count -ne 1) { Stop-Skao 'The dedicated HTTPS gateway firewall rule is missing or ambiguous.' }
    $rule = $rules[0]
    $addresses = @($rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
    $ports = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop)
    $apps = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
    $services = @($rule | Get-NetFirewallServiceFilter -ErrorAction Stop)
    $interfaces = @($rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop)
    $types = @($rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop)
    $security = @($rule | Get-NetFirewallSecurityFilter -ErrorAction Stop)
    if ($addresses.Count -ne 1 -or $ports.Count -ne 1 -or $apps.Count -ne 1 -or
        $services.Count -ne 1 -or $interfaces.Count -ne 1 -or $types.Count -ne 1 -or $security.Count -ne 1) {
        Stop-Skao 'The gateway firewall rule filter count is unexpected.'
    }
    if ([string]$rule.Enabled -ne 'True' -or [string]$rule.Action -ne 'Allow' -or
        [string]$rule.Direction -ne 'Inbound' -or [string]$rule.Profile -ne 'Private' -or
        [string]$addresses[0].LocalAddress -cne $Settings.LaptopIp -or
        [string]$addresses[0].RemoteAddress -cne $Settings.PiIp -or
        [string]$ports[0].LocalPort -ne '8443' -or [string]$ports[0].RemotePort -ne 'Any' -or
        [string]$ports[0].Protocol -notin @('TCP', '6') -or
        [string]$apps[0].Program -ine $aiBinary -or [string]$apps[0].Package -ne 'Any' -or
        [string]$services[0].Service -ne 'Any' -or [string]$interfaces[0].InterfaceAlias -ne 'Any' -or
        [string]$types[0].InterfaceType -ne 'Any' -or
        [string]$security[0].Authentication -ne 'NotRequired' -or
        [string]$security[0].Encryption -ne 'NotRequired' -or
        [string]$security[0].OverrideBlockRules -ne 'False' -or
        [string]$security[0].LocalUser -ne 'Any' -or [string]$security[0].RemoteUser -ne 'Any' -or
        [string]$security[0].RemoteMachine -ne 'Any') {
        Stop-Skao 'An existing HTTPS firewall rule differs from the exact Pi-only rule. It was left unchanged.'
    }
}

function Get-GatewayConfiguration($Settings, [string]$Token, [ValidateSet(1, 2)][int]$Profile = 1) {
    $template = @'
{
    admin off
    persist_config off
    auto_https disable_redirects
    skip_install_trust
    storage file_system {
        root "__DATA_PATH__"
    }
    servers {
        protocols h1 h2
        max_header_size 16KB
    }
}
https://__LAPTOP_IP__:8443 {
    bind __LAPTOP_IP__
    tls internal
    @allowedGet {
        remote_ip __PI_IP__
        header Authorization "Bearer __TOKEN__"
        method GET
        expression `{http.request.uri.query} == ""`
        path /api/status /api/tags
    }
    @allowedPost {
        remote_ip __PI_IP__
        header Authorization "Bearer __TOKEN__"
        method POST
        expression `{http.request.uri.query} == ""`
        path /api/show /api/generate
    }
    handle @allowedGet {
        reverse_proxy 127.0.0.1:11434 {
            header_up -Authorization
            header_up Host localhost:11434
        }
    }
    handle @allowedPost {
        request_body {
            max_size 65536
        }
        reverse_proxy 127.0.0.1:11434 {
            header_up -Authorization
            header_up Host localhost:11434
        }
    }
    handle {
        respond "Forbidden" 403
    }
}
'@
    if ($Profile -eq 2) {
        $template = @'
# SKAO_GATEWAY_PROFILE=activity-images-v1
{
    admin off
    persist_config off
    auto_https disable_redirects
    skip_install_trust
    storage file_system {
        root "__DATA_PATH__"
    }
    servers {
        protocols h1 h2
        max_header_size 16KB
    }
}
https://__LAPTOP_IP__:8443 {
    bind __LAPTOP_IP__
    tls internal
    header X-SKAO-Gateway-Profile "activity-images-v1"
    @allowedGet {
        remote_ip __PI_IP__
        header Authorization "Bearer __TOKEN__"
        method GET
        expression `{http.request.uri.query} == ""`
        path /api/status /api/tags
    }
    @allowedShow {
        remote_ip __PI_IP__
        header Authorization "Bearer __TOKEN__"
        method POST
        expression `{http.request.uri.query} == ""`
        path /api/show
    }
    @allowedGenerate {
        remote_ip __PI_IP__
        header Authorization "Bearer __TOKEN__"
        method POST
        expression `{http.request.uri.query} == ""`
        path /api/generate
    }
    @allowedImageGet {
        remote_ip __PI_IP__
        header Authorization "Bearer __TOKEN__"
        method GET
        expression `{http.request.uri.query} == ""`
        path_regexp activityImageGet "^/api/activity-images/(?:status|jobs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:/frames/[1-6])?)$"
    }
    @allowedImagePost {
        remote_ip __PI_IP__
        header Authorization "Bearer __TOKEN__"
        method POST
        expression `{http.request.uri.query} == ""`
        path /api/activity-images/jobs
    }
    @allowedImageDelete {
        remote_ip __PI_IP__
        header Authorization "Bearer __TOKEN__"
        method DELETE
        expression `{http.request.uri.query} == ""`
        path_regexp activityImageDelete "^/api/activity-images/jobs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    }
    handle @allowedGet {
        reverse_proxy 127.0.0.1:11434 {
            header_up -Authorization
            header_up Host localhost:11434
        }
    }
    handle @allowedShow {
        request_body {
            max_size 65536
        }
        reverse_proxy 127.0.0.1:11434 {
            header_up -Authorization
            header_up Host localhost:11434
        }
    }
    handle @allowedGenerate {
        request_body {
            max_size 65536
        }
        reverse_proxy 127.0.0.1:11435 {
            header_up Authorization "Bearer __TOKEN__"
            header_up Host 127.0.0.1:11435
        }
    }
    handle @allowedImageGet {
        request_body {
            max_size 16384
        }
        reverse_proxy 127.0.0.1:11435 {
            header_up Authorization "Bearer __TOKEN__"
            header_up Host 127.0.0.1:11435
        }
    }
    handle @allowedImagePost {
        request_body {
            max_size 16384
        }
        reverse_proxy 127.0.0.1:11435 {
            header_up Authorization "Bearer __TOKEN__"
            header_up Host 127.0.0.1:11435
        }
    }
    handle @allowedImageDelete {
        request_body {
            max_size 16384
        }
        reverse_proxy 127.0.0.1:11435 {
            header_up Authorization "Bearer __TOKEN__"
            header_up Host 127.0.0.1:11435
        }
    }
    handle {
        respond "Forbidden" 403
    }
}
'@
    }
    return $template.Replace('__DATA_PATH__', (Join-Path $aiGateway 'data').Replace('\', '/')).Replace('__LAPTOP_IP__', $Settings.LaptopIp).Replace('__PI_IP__', $Settings.PiIp).Replace('__TOKEN__', $Token)
}

function Get-GatewayProfile($Settings, [string]$Token) {
    if (!(Test-Path -LiteralPath $aiConfig)) { return 1 }
    Assert-ProtectedPath $aiConfig
    $actual = Get-NormalizedText ([IO.File]::ReadAllText($aiConfig))
    foreach ($profile in @(1, 2)) {
        if ($actual -ceq (Get-NormalizedText (Get-GatewayConfiguration $Settings $Token $profile))) { return $profile }
    }
    Stop-Skao 'The existing gateway configuration is not a recognized profile. It was left unchanged.'
}

function Get-GatewayLauncher {
    return @'
@echo off
setlocal
"%~dp0caddy.exe" run --config "%~dp0Caddyfile" --adapter caddyfile > "%~dp0gateway-background.log" 2>&1
exit /b %errorlevel%
'@
}

function Get-ConnectionEnvironment($Settings, [string]$Token) {
    return @"
SKAO_AI_MODEL=$aiModel
SKAO_AI_LAN=1
SKAO_AI_URL=https://$($Settings.LaptopIp):8443
SKAO_AI_TOKEN=$Token
SKAO_AI_CA_FILE=/etc/skao/ai/ca.pem
SKAO_AI_TIMEOUT_MS=120000
"@
}

function Get-ExistingToken {
    $tokens = @()
    $environmentFile = Join-Path $aiExport 'ai.env'
    if (Test-Path -LiteralPath $environmentFile) {
        Assert-ProtectedPath $environmentFile
        $matches = @([regex]::Matches([IO.File]::ReadAllText($environmentFile), '(?m)^SKAO_AI_TOKEN=([A-Za-z0-9_-]{43})\r?$'))
        if ($matches.Count -ne 1) { Stop-Skao 'The existing protected connection token could not be verified.' }
        $tokens += $matches[0].Groups[1].Value
    }
    if (Test-Path -LiteralPath $aiConfig) {
        Assert-ProtectedPath $aiConfig
        $configText = [IO.File]::ReadAllText($aiConfig)
        $expectedCount = 2
        if ((Get-NormalizedText $configText).StartsWith("# SKAO_GATEWAY_PROFILE=activity-images-v1`n", [StringComparison]::Ordinal)) { $expectedCount = 6 }
        $matches = @([regex]::Matches($configText, 'header Authorization "Bearer ([A-Za-z0-9_-]{43})"'))
        $values = @($matches | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
        if ($matches.Count -ne $expectedCount -or $values.Count -ne 1) {
            Stop-Skao 'The existing gateway configuration token could not be verified.'
        }
        $tokens += $matches[0].Groups[1].Value
    }
    if (@($tokens | Select-Object -Unique).Count -gt 1) {
        Stop-Skao 'The saved gateway and exported connection tokens differ. They were left unchanged.'
    }
    if ($tokens.Count -gt 0) { return $tokens[0] }
    return $null
}

function Assert-GatewayBinary {
    Assert-ProtectedPath $aiBinary -MaximumLength 53159936
    $item = Get-Item -LiteralPath $aiBinary -Force -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -ne 53159936 -or
        (Get-FileHash -LiteralPath $aiBinary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $aiExeHash) {
        Stop-Skao 'The existing Caddy executable does not match the pinned official build. It was not run.'
    }
    # Binary size exceeds the bounded text-file check; check its ACL separately.
    $acl = Get-Acl -LiteralPath $aiBinary -ErrorAction Stop
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ([string]$rule.AccessControlType -eq 'Allow' -and
            $rule.IdentityReference.Value -notin @($aiSid, 'S-1-5-18', 'S-1-5-32-544')) {
            Stop-Skao 'The gateway executable allows another account or group access.'
        }
    }
}

function Assert-PublicCa([string]$Path) {
    Assert-ProtectedPath $Path
    $text = [IO.File]::ReadAllText($Path)
    if ($text -cnotmatch '\A\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\s*\z') {
        Stop-Skao 'The public CA export is not exactly one PEM certificate.'
    }
    try {
        $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($Path)
        $basicConstraints = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
        if ($basicConstraints.Count -ne 1) { Stop-Skao 'The exported certificate has no unique CA constraint.' }
        $constraints = New-Object Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($basicConstraints[0], $basicConstraints[0].Critical)
        if (!$constraints.CertificateAuthority -or $certificate.HasPrivateKey -or
            $certificate.NotBefore -gt [DateTime]::Now -or $certificate.NotAfter -le [DateTime]::Now) {
            Stop-Skao 'The public CA export is not a current public CA certificate.'
        }
    }
    finally { if ($null -ne $certificate) { $certificate.Dispose() } }
}

function Assert-ExistingFiles($Settings, [string]$Token, [ValidateSet(1, 2)][int]$Profile = 1) {
    Assert-ProtectedPath $aiGateway -Directory
    Assert-ProtectedPath $aiExport -Directory
    Assert-ProtectedPath (Join-Path $aiGateway 'data') -Directory
    Assert-GatewayBinary
    Assert-Text $aiConfig (Get-GatewayConfiguration $Settings $Token $Profile)
    Assert-Text $aiLauncher (Get-GatewayLauncher)
    Assert-Text (Join-Path $aiExport 'ai.env') (Get-ConnectionEnvironment $Settings $Token)
}

function Assert-CurrentCaExport {
    foreach ($directory in @('data\pki', 'data\pki\authorities', 'data\pki\authorities\local')) {
        Assert-ProtectedPath (Join-Path $aiGateway $directory) -Directory
    }
    Assert-PublicCa $aiPublicCa
    $exported = Join-Path $aiExport 'ca.pem'
    Assert-PublicCa $exported
    if ((Get-FileHash -LiteralPath $exported -Algorithm SHA256).Hash -cne
        (Get-FileHash -LiteralPath $aiPublicCa -Algorithm SHA256).Hash) {
        Stop-Skao 'The existing public CA export differs from this gateway. It was left unchanged.'
    }
}

function Write-MissingText([string]$Path, [string]$Content) {
    if (Test-Path -LiteralPath $Path) { Assert-Text $Path $Content; return }
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Content.Replace("`r`n", "`n") + "`n")
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() }
    finally { $stream.Dispose() }
}

function Assert-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal($aiIdentity)
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Stop-Skao 'This step needs an elevated PowerShell or SSH session under the protected AI account.'
    }
}

function Invoke-SkaoActivityWorkerStatus([string]$Token) {
    $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:11435/api/activity-images/status')
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 5000
    $request.ReadWriteTimeout = 5000
    $request.KeepAlive = $false
    $request.Headers['Authorization'] = 'Bearer ' + $Token
    $request.Accept = 'application/json'
    $response = $null; $stream = $null
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200 -or [string]$response.ContentType -notmatch '^application/json(?:;|$)') {
            Stop-Skao 'The activity image worker did not return its authenticated local status.'
        }
        $stream = $response.GetResponseStream()
        $buffer = New-Object byte[] 8192
        $memory = New-Object IO.MemoryStream
        try {
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if ($memory.Length + $read -gt 65536 -or $watch.Elapsed.TotalSeconds -gt 5) { Stop-Skao 'The activity image worker exceeded its status response limit.' }
                $memory.Write($buffer, 0, $read)
            }
            $text = [Text.Encoding]::UTF8.GetString($memory.ToArray())
        }
        finally { $memory.Dispose() }
        return ($text | ConvertFrom-Json -ErrorAction Stop)
    }
    catch { Stop-Skao 'The authenticated activity image worker is unavailable. Its configuration and existing AI setup were retained.' }
    finally {
        if ($stream) { $stream.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Assert-SkaoActivityWorkerStatus($Status) {
    if ($null -eq $Status -or $Status -isnot [pscustomobject] -or
        ($Status.version -isnot [int] -and $Status.version -isnot [long]) -or $Status.version -ne 1 -or
        $Status.enabled -isnot [bool] -or !$Status.enabled -or
        $Status.available -isnot [bool] -or !$Status.available -or
        $Status.busy -isnot [bool] -or [string]$Status.model -cne 'sd_xl_base_1.0.safetensors') {
        Stop-Skao 'The activity image worker has not confirmed the installed local SDXL capability.'
    }
}

function Assert-SkaoActivityImageIsolation {
    Assert-SkaoRawFirewall -RuleName 'SKAO-ActivityImages-Block-Remote' -RawPort '11435'
    Assert-SkaoRawFirewall -RuleName 'SKAO-ComfyUI-Block-Remote' -RawPort '8188'
}

function Test-SkaoGatewayProfileActive($Settings) {
    $reply = Invoke-SkaoGatewayCurl -Url ('https://{0}:8443/api/status' -f $Settings.LaptopIp) -CaFile $aiPublicCa -TimeoutSeconds 2 -IncludeProfile
    $lines = @($reply.Lines | ForEach-Object { ([string]$_).Trim() })
    return $reply.ExitCode -eq 0 -and @($lines | Where-Object { $_ -ceq '403' }).Count -eq 1 -and
        @($lines | Where-Object { $_ -imatch '^X-SKAO-Gateway-Profile:\s*activity-images-v1\s*$' }).Count -eq 1
}

function Test-SkaoGatewayCandidate([string]$Path, [string]$LogPath) {
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        & $aiBinary validate --config $Path --adapter caddyfile *> $LogPath
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $oldPreference }
    if ($code -ne 0) { Stop-Skao 'Caddy rejected the staged activity-image configuration. The existing gateway was retained; inspect its protected validation log locally.' }
}

function Restart-SkaoGatewayTask($Settings, [ValidateSet(1, 2)][int]$Profile) {
    $task = Get-ScheduledTask -TaskName $aiTaskName -ErrorAction Stop
    Assert-ManagedTask $task $aiLauncher $aiGateway 45
    if ([string]$task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $aiTaskName -ErrorAction Stop
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            $task = Get-ScheduledTask -TaskName $aiTaskName -ErrorAction Stop
            if ([string]$task.State -ne 'Running') { break }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        if ([string]$task.State -eq 'Running') { Stop-Skao 'The managed gateway task did not stop; no task credentials were changed.' }
    }
    Start-ScheduledTask -TaskName $aiTaskName -ErrorAction Stop
    $options = @{ Url = ('https://{0}:8443/api/status' -f $Settings.LaptopIp); CaFile = $aiPublicCa; TimeoutSeconds = 30 }
    if ($Profile -eq 2) { $options.ExpectedProfile = 'activity-images-v1' }
    Wait-SkaoGatewayHttps @options
    $task = Get-ScheduledTask -TaskName $aiTaskName -ErrorAction Stop
    Assert-ManagedTask $task $aiLauncher $aiGateway 45
    if ([string]$task.State -ne 'Running') { Stop-Skao 'The managed gateway task did not remain running.' }
}

function Enable-SkaoGatewayActivityImages($Settings, [string]$Token) {
    Assert-Administrator
    Assert-ExistingFiles $Settings $Token 1
    Assert-CurrentCaExport
    Assert-SkaoActivityImageIsolation
    $status = Invoke-SkaoActivityWorkerStatus $Token
    Assert-SkaoActivityWorkerStatus $status
    if ($status.busy) { Stop-Skao 'The activity image worker is busy. Finish the current AI request before enabling gateway routes.' }
    $lockPath = Join-Path $aiGateway 'activity-images-upgrade.lock'
    Assert-NoLink $lockPath
    if (Test-Path -LiteralPath $lockPath) { Assert-ProtectedPath $lockPath }
    $lock = $null; $candidate = $null; $swapped = $false
    $suffix = [Guid]::NewGuid().ToString('N')
    $backup = Join-Path $aiGateway ('Caddyfile.before-activity-images-' + $suffix)
    $validationLog = Join-Path $aiGateway ('activity-images-validation-' + $suffix + '.log')
    try {
        try { $lock = New-Object IO.FileStream($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { Stop-Skao 'Another gateway upgrade is running. Existing gateway state was retained.' }
        Assert-ExistingFiles $Settings $Token 1
        $original = [IO.File]::ReadAllBytes($aiConfig)
        $originalHash = (Get-FileHash -LiteralPath $aiConfig -Algorithm SHA256).Hash
        $preserved = @{}
        foreach ($path in @($aiMetadataPath, $aiLauncher, (Join-Path $aiExport 'ai.env'), $aiPublicCa, (Join-Path $aiExport 'ca.pem'))) {
            $preserved[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        }
        $candidate = Join-Path $aiGateway ('Caddyfile.activity-images-' + $suffix + '.new')
        Write-MissingText $candidate (Get-GatewayConfiguration $Settings $Token 2)
        Test-SkaoGatewayCandidate -Path $candidate -LogPath $validationLog
        if ((Get-FileHash -LiteralPath $aiConfig -Algorithm SHA256).Hash -cne $originalHash) {
            Stop-Skao 'Gateway configuration changed during upgrade. It was retained without replacement.'
        }
        foreach ($path in $preserved.Keys) {
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $preserved[$path]) {
                Stop-Skao 'Protected gateway state changed during upgrade. No configuration was replaced.'
            }
        }
        [IO.File]::Replace($candidate, $aiConfig, $backup)
        $candidate = $null; $swapped = $true
        Restart-SkaoGatewayTask -Settings $Settings -Profile 2
        Assert-ExistingFiles $Settings $Token 2
        Assert-CurrentCaExport
        foreach ($path in $preserved.Keys) {
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $preserved[$path]) {
                Stop-Skao 'Protected gateway connection state changed while applying the image routes.'
            }
        }
    }
    catch {
        if ($swapped) {
            $restored = $false
            try {
                Assert-Text $aiConfig (Get-GatewayConfiguration $Settings $Token 2)
                $restore = Join-Path $aiGateway ('Caddyfile.restore-' + $suffix + '.new')
                [IO.File]::WriteAllBytes($restore, $original)
                $failed = Join-Path $aiGateway ('Caddyfile.failed-activity-images-' + $suffix)
                [IO.File]::Replace($restore, $aiConfig, $failed)
                Restart-SkaoGatewayTask -Settings $Settings -Profile 1
                $restored = $true
            }
            catch { }
            if ($restored) { Stop-Skao 'Activity-image gateway upgrade failed. The exact previous configuration was restored; existing credentials and CA were retained.' }
            Stop-Skao 'Activity-image gateway upgrade failed. Its protected backup was retained; existing credentials and CA were not replaced.'
        }
        Stop-Skao 'Activity-image gateway upgrade stopped before replacement. The existing configuration and credentials were retained.'
    }
    finally {
        try { if ($candidate -and (Test-Path -LiteralPath $candidate)) { Remove-Item -LiteralPath $candidate -Force } }
        finally { if ($lock) { $lock.Dispose() } }
    }
    Write-Host 'PASS: activity-image gateway profile enabled; existing token, CA, addresses and task credentials retained'
}

function Show-GatewayCheck($Settings, [ValidateSet(1, 2)][int]$Profile = 1) {
    $task = Get-ScheduledTask -TaskName $aiTaskName -ErrorAction Stop
    Assert-ManagedTask $task $aiLauncher $aiGateway 45
    if ([string]$task.State -ne 'Running') { Stop-Skao 'The gateway task is not Running.' }
    Assert-LocalRuntime
    Assert-Network $Settings
    Assert-SkaoRawFirewall
    Assert-GatewayFirewall $Settings
    Assert-CurrentCaExport
    $options = @{ Url = ('https://{0}:8443/api/status' -f $Settings.LaptopIp); CaFile = $aiPublicCa; TimeoutSeconds = 10 }
    if ($Profile -eq 2) { $options.ExpectedProfile = 'activity-images-v1' }
    Wait-SkaoGatewayHttps @options
    Write-Host 'PASS: private gateway files and pinned executable'
    Write-Host 'PASS: raw Ollama firewall block and exact Pi-only HTTPS rule'
    Write-Host 'PASS: CA-verified HTTPS denial (403); cloud disabled; pinned local model'
    Write-Host 'Verify authenticated access and raw-port isolation from the Pi next.'
}

function Use-SkaoGatewayProfile($Settings, [string]$Token, [ValidateSet(1, 2)][int]$Profile,
    [switch]$Check, [switch]$ActivityImages) {
    if ($Check -and $ActivityImages -and $Profile -ne 2) {
        Stop-Skao 'Activity-image gateway routes are not enabled. Check mode made no changes.'
    }
    if ($ActivityImages) {
        Assert-SkaoActivityImageIsolation
        $status = Invoke-SkaoActivityWorkerStatus $Token
        Assert-SkaoActivityWorkerStatus $status
    }
    if (!$Check -and $ActivityImages -and $Profile -eq 1) {
        Show-GatewayCheck $Settings 1
        Enable-SkaoGatewayActivityImages $Settings $Token
        $Profile = 2
    }
    elseif (!$Check -and $Profile -eq 2 -and !(Test-SkaoGatewayProfileActive $Settings)) {
        # Recover an interrupted profile switch without touching task credentials.
        Assert-Administrator
        if ($ActivityImages -and $status.busy) { Stop-Skao 'The activity image worker is busy. Finish the current AI request before restarting its gateway.' }
        Restart-SkaoGatewayTask -Settings $Settings -Profile 2
    }
    Show-GatewayCheck $Settings $Profile
    if ($ActivityImages) { Write-Host 'PASS: authenticated local activity worker and image-port isolation' }
    return $Profile
}

# Dot-sourcing loads only functions for the portable test suite.
if ($MyInvocation.InvocationName -eq '.') { return }

try {
    if ($env:OS -ne 'Windows_NT' -or ![Environment]::Is64BitOperatingSystem) {
        Stop-Skao 'Run this script on the Windows 11 x64 AI laptop.'
    }
    $aiIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $aiSid = $aiIdentity.User.Value
    foreach ($path in @($aiRoot, $aiGateway, $aiMetadataPath, $aiConfig, $aiLauncher, $aiBinary, $aiExport,
        (Join-Path $aiGateway 'data'), (Join-Path $aiExport 'ai.env'), (Join-Path $aiExport 'ca.pem'))) { Assert-NoLink $path }
    Assert-ProtectedPath $aiRoot -Directory
    Assert-LocalRuntime
    $settings = $null
    if (Test-Path -LiteralPath $aiMetadataPath) {
        Assert-ProtectedTree
        Assert-ProtectedPath $aiMetadataPath
        try { $settings = [IO.File]::ReadAllText($aiMetadataPath) | ConvertFrom-Json -ErrorAction Stop }
        catch { Stop-Skao 'The saved gateway metadata is not valid JSON.' }
        if ($settings.OwnerSid -cne $aiSid -or $settings.Version -ne 1 -or
            !(Test-PrivateIPv4 $settings.LaptopIp) -or !(Test-PrivateIPv4 $settings.PiIp) -or
            $settings.LaptopIp -eq $settings.PiIp -or
            @($settings.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'LaptopIp,OwnerSid,PiIp,Version') {
            Stop-Skao 'The saved gateway metadata does not match this account or setup version.'
        }
        if (($LaptopIp -and $LaptopIp -cne $settings.LaptopIp) -or ($PiIp -and $PiIp -cne $settings.PiIp)) {
            Stop-Skao 'Supplied addresses differ from saved gateway settings. No addresses or keys were changed.'
        }
    }
    $tasks = @(Get-ScheduledTask -TaskName $aiTaskName -ErrorAction SilentlyContinue)
    if ($tasks.Count -gt 1) { Stop-Skao 'Multiple gateway tasks were found.' }
    $existingTask = $null
    if ($tasks.Count -eq 1) { $existingTask = $tasks[0]; Assert-ManagedTask $existingTask $aiLauncher $aiGateway 45 }
    if ($null -eq $settings) {
        if ($Check) { Stop-Skao 'Gateway setup is missing. Check mode made no changes.' }
        if ($ActivityImages) { Stop-Skao 'Complete the normal local AI gateway setup before enabling activity images.' }
        if ($null -ne $existingTask -or (Test-Path -LiteralPath $aiGateway) -or
            @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $aiFirewallName -ErrorAction SilentlyContinue).Count -gt 0) {
            Stop-Skao 'Gateway state exists without recognized metadata. It was left unchanged.'
        }
        if (!$LaptopIp) { $LaptopIp = (Read-Host 'Laptop PRIVATE IPv4 address (enter the real value here only)').Trim() }
        if (!$PiIp) { $PiIp = (Read-Host 'Pi PRIVATE IPv4 address (enter the real value here only)').Trim() }
        if (!(Test-PrivateIPv4 $LaptopIp) -or !(Test-PrivateIPv4 $PiIp) -or $LaptopIp -eq $PiIp) {
            Stop-Skao 'Enter two different real RFC1918 private IPv4 addresses. 1.2.3.4 is only an example.'
        }
        $settings = [pscustomobject]@{ Version = 1; OwnerSid = $aiSid; LaptopIp = $LaptopIp; PiIp = $PiIp }
    }
    Assert-Network $settings
    $token = Get-ExistingToken
    $profile = 1
    if ($token) {
        $profile = Get-GatewayProfile $settings $token
        foreach ($file in @($aiConfig, $aiLauncher, (Join-Path $aiExport 'ai.env'))) {
            if (Test-Path -LiteralPath $file) {
                if ($file -eq $aiConfig) { Assert-Text $file (Get-GatewayConfiguration $settings $token $profile) }
                elseif ($file -eq $aiLauncher) { Assert-Text $file (Get-GatewayLauncher) }
                else { Assert-Text $file (Get-ConnectionEnvironment $settings $token) }
            }
        }
    }
    elseif ((Test-Path -LiteralPath (Join-Path $aiGateway 'data\pki')) -or $null -ne $existingTask) {
        Stop-Skao 'An existing gateway has no recoverable saved token. Its CA and task were left unchanged.'
    }
    $complete = $token -and (Test-Path -LiteralPath $aiBinary) -and (Test-Path -LiteralPath $aiConfig) -and
        (Test-Path -LiteralPath $aiLauncher) -and (Test-Path -LiteralPath (Join-Path $aiExport 'ai.env'))
    if ($complete) { Assert-ExistingFiles $settings $token $profile }
    $existingRules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $aiFirewallName -ErrorAction SilentlyContinue)
    $rawRules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name 'SKAO-Ollama-Block-Remote' -ErrorAction SilentlyContinue)
    $hasCompleteExports = (Test-Path -LiteralPath $aiPublicCa) -and (Test-Path -LiteralPath (Join-Path $aiExport 'ca.pem'))
    if ($Check -or ($complete -and $hasCompleteExports -and $existingRules.Count -eq 1 -and $rawRules.Count -eq 1 -and
        $null -ne $existingTask -and [string]$existingTask.State -eq 'Running')) {
        if (!$complete -or $null -eq $existingTask -or [string]$existingTask.State -ne 'Running') {
            Stop-Skao 'Gateway setup is incomplete or its task is stopped. Check mode made no changes.'
        }
        $null = Use-SkaoGatewayProfile -Settings $settings -Token $token -Profile $profile -Check:$Check -ActivityImages:$ActivityImages
        $global:LASTEXITCODE = 0
        return
    }
    if ($ActivityImages) { Stop-Skao 'The normal local AI gateway must be complete and running before enabling activity images.' }
    Assert-Administrator
    Ensure-SkaoRawFirewall
    if ($existingRules.Count -gt 0) { Assert-GatewayFirewall $settings }
    if (!(Test-Path -LiteralPath $aiGateway)) {
        $null = New-Item -ItemType Directory -Path $aiGateway
        Protect-GatewayDirectory
    }
    Assert-ProtectedPath $aiGateway -Directory
    if (!(Test-Path -LiteralPath $aiMetadataPath)) {
        Write-MissingText $aiMetadataPath ($settings | ConvertTo-Json)
    }
    foreach ($directory in @($aiExport, (Join-Path $aiGateway 'data'))) {
        Assert-NoLink $directory
        if (!(Test-Path -LiteralPath $directory)) { $null = New-Item -ItemType Directory -Path $directory }
        Assert-ProtectedPath $directory -Directory
    }
    if (!(Test-Path -LiteralPath $aiBinary)) {
        $downloaded = $false
        $zip = $ArchivePath
        if (!$zip) {
            $zip = Join-Path $aiGateway ('caddy-{0}-{1}.zip' -f $aiVersion, [Guid]::NewGuid().ToString('N'))
            $downloaded = $true
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $ProgressPreference = 'SilentlyContinue'
            Write-Host 'Downloading the pinned HTTPS gateway...'
            Invoke-WebRequest -UseBasicParsing -Uri ('https://github.com/caddyserver/caddy/releases/download/v{0}/caddy_{0}_windows_amd64.zip' -f $aiVersion) -OutFile $zip -TimeoutSec 180
        }
        try {
            Assert-NoLink $zip
            if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -cne $aiZipHash) {
                Stop-Skao 'The official Caddy archive checksum did not match. No executable was run.'
            }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $archive = [IO.Compression.ZipFile]::OpenRead($zip)
            try {
                $entries = @($archive.Entries | Where-Object { $_.FullName -ceq 'caddy.exe' })
                if ($entries.Count -ne 1) { Stop-Skao 'The verified Caddy archive has no unique executable entry.' }
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $aiBinary, $false)
            }
            finally { $archive.Dispose() }
        }
        finally { if ($downloaded -and (Test-Path -LiteralPath $zip)) { Remove-Item -LiteralPath $zip } }
    }
    Assert-GatewayBinary
    if (!$token) {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    # Write the token-bearing environment first so an interrupted run can reuse it.
    Write-MissingText (Join-Path $aiExport 'ai.env') (Get-ConnectionEnvironment $settings $token)
    Write-MissingText $aiConfig (Get-GatewayConfiguration $settings $token $profile)
    Write-MissingText $aiLauncher (Get-GatewayLauncher)
    Assert-ExistingFiles $settings $token $profile
    if ($null -eq $existingTask) {
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $global:LASTEXITCODE = 0
            & $aiBinary validate --config $aiConfig --adapter caddyfile *> (Join-Path $aiGateway 'validation.log')
            $validationExit = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $previousPreference }
        if ($validationExit -ne 0) { Stop-Skao 'Caddy rejected its configuration. Inspect the protected validation log locally.' }
        $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\cmd.exe') -Argument ('/d /c ""{0}""' -f $aiLauncher) -WorkingDirectory $aiGateway
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $trigger.Delay = 'PT45S'
        $taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 7 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $principal = New-ScheduledTaskPrincipal -UserId $aiIdentity.Name -LogonType Password -RunLevel Limited
        $definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $taskSettings -Principal $principal
        $password = Read-Host 'Windows password for this AI account (local prompt; not Hello PIN)' -AsSecureString
        try {
            $credential = New-Object Management.Automation.PSCredential($aiIdentity.Name, $password)
            Register-ScheduledTask -TaskName $aiTaskName -InputObject $definition -User $aiIdentity.Name -Password ($credential.GetNetworkCredential().Password) | Out-Null
        }
        finally { $credential = $null; $password.Dispose() }
    }
    if ($existingRules.Count -eq 0) {
        New-NetFirewallRule -PolicyStore PersistentStore -Name $aiFirewallName -DisplayName 'SKAO AI HTTPS from configured Pi only' -Direction Inbound -Action Allow -Enabled True -Profile Private -Protocol TCP -LocalPort 8443 -LocalAddress $settings.LaptopIp -RemoteAddress $settings.PiIp -Program $aiBinary | Out-Null
    }
    Assert-GatewayFirewall $settings
    $task = Get-ScheduledTask -TaskName $aiTaskName -ErrorAction Stop
    Assert-ManagedTask $task $aiLauncher $aiGateway 45
    if ([string]$task.State -ne 'Running') { Start-ScheduledTask -TaskName $aiTaskName }
    $readiness = @{ Url = ('https://{0}:8443/api/status' -f $settings.LaptopIp); CaFile = $aiPublicCa; TimeoutSeconds = 30 }
    if ($profile -eq 2) { $readiness.ExpectedProfile = 'activity-images-v1' }
    Wait-SkaoGatewayHttps @readiness
    Assert-PublicCa $aiPublicCa
    $exported = Join-Path $aiExport 'ca.pem'
    if (!(Test-Path -LiteralPath $exported)) {
        $source = [IO.File]::OpenRead($aiPublicCa)
        try {
            $destination = [IO.File]::Open($exported, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $source.CopyTo($destination); $destination.Flush() } finally { $destination.Dispose() }
        }
        finally { $source.Dispose() }
    }
    Show-GatewayCheck $settings $profile
    $global:LASTEXITCODE = 0
}
catch {
    $message = 'Gateway setup stopped while validating or preparing a protected item. Review the current setup stage locally.'
    if ($_.Exception.Data['SkaoSafe'] -eq $true) { $message = $_.Exception.Message }
    Write-Error -Message $message -ErrorAction Continue
    Write-Host 'Existing keys, certificates, settings and startup tasks were retained.'
    exit 1
}
