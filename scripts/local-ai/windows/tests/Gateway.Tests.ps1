#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$oldLocal = $env:LOCALAPPDATA
$oldRoot = $env:SystemRoot
if (!$env:LOCALAPPDATA) { $env:LOCALAPPDATA = [IO.Path]::GetTempPath() }
if (!$env:SystemRoot) { $env:SystemRoot = [IO.Path]::GetTempPath() }
. (Join-Path $PSScriptRoot '..\Setup-Gateway.ps1')
$count = 0
function Assert-Test([bool]$Value, [string]$Name) { if (!$Value) { throw ('FAIL: ' + $Name) }; $script:count++ }
function Expect-Refusal([scriptblock]$Work, [string]$Name) {
    $caught = $null
    try { & $Work } catch { $caught = $_ }
    Assert-Test ($null -ne $caught -and $caught.Exception.Data['SkaoSafe'] -eq $true) $Name
}
function Copy-TestObject($Value) { return $Value | ConvertTo-Json -Depth 12 | ConvertFrom-Json }
$aiSid = 'S-1-5-21-123-123-123-1001'
$launcher = Join-Path $aiGateway 'Run-Gateway.cmd'
$taskBase = [pscustomobject]@{
    Principal = [pscustomobject]@{ UserId = $aiSid; RunLevel = 'Limited'; LogonType = 'Password' }
    Actions = @([pscustomobject]@{ Execute = (Join-Path $env:SystemRoot 'System32\cmd.exe'); Arguments = ('/d /c ""{0}""' -f $launcher); WorkingDirectory = $aiGateway })
    Triggers = @([pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskBootTrigger' }; Delay = 'PT45S'; Enabled = $true })
    Settings = [pscustomobject]@{ Priority = 7; MultipleInstances = 'IgnoreNew'; RestartCount = 3; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S'; DisallowStartIfOnBatteries = $false; StopIfGoingOnBatteries = $false; Enabled = $true }
    State = 'Running'
}
Assert-ManagedTask $taskBase $launcher $aiGateway 45
Assert-Test $true 'known manual startup task accepted'
$taskCases = @(
    { $task.Principal.UserId = 'S-1-5-21-999-999-999-1001' },
    { $task.Principal.RunLevel = 'Highest' },
    { $task.Principal.LogonType = 'Interactive' },
    { $task.Actions[0].Execute = 'other.exe' },
    { $task.Actions[0].Arguments = '/c arbitrary' },
    { $task.Actions[0].WorkingDirectory = 'other' },
    { $task.Actions = @() },
    { $task.Triggers[0].Delay = 'PT0S' },
    { $task.Triggers[0].Enabled = $false },
    { $task.Triggers = @() },
    { $task.Settings.Priority = 4 },
    { $task.Settings.MultipleInstances = 'Parallel' },
    { $task.Settings.RestartCount = 0 },
    { $task.Settings.RestartInterval = 'PT3M' },
    { $task.Settings.ExecutionTimeLimit = 'PT1H' },
    { $task.Settings.DisallowStartIfOnBatteries = $true },
    { $task.Settings.StopIfGoingOnBatteries = $true },
    { $task.Settings.Enabled = $false }
)
foreach ($case in $taskCases) {
    $task = Copy-TestObject $taskBase
    & $case
    Expect-Refusal { Assert-ManagedTask $task $launcher $aiGateway 45 } 'incompatible task preserved'
}

$settings = [pscustomobject]@{ LaptopIp = '192.168.1.10'; PiIp = '192.168.1.20' }
$script:rule = [pscustomobject]@{ Enabled = 'True'; Action = 'Allow'; Direction = 'Inbound'; Profile = 'Private' }
$script:address = [pscustomobject]@{ LocalAddress = $settings.LaptopIp; RemoteAddress = $settings.PiIp }
$script:port = [pscustomobject]@{ LocalPort = '8443'; RemotePort = 'Any'; Protocol = 'TCP' }
$script:application = [pscustomobject]@{ Program = $aiBinary; Package = 'Any' }
$script:service = [pscustomobject]@{ Service = 'Any' }
$script:interface = [pscustomobject]@{ InterfaceAlias = 'Any' }
$script:interfaceType = [pscustomobject]@{ InterfaceType = 'Any' }
$script:security = [pscustomobject]@{ Authentication = 'NotRequired'; Encryption = 'NotRequired'; OverrideBlockRules = 'False'; LocalUser = 'Any'; RemoteUser = 'Any'; RemoteMachine = 'Any' }
function Get-NetFirewallRule { [CmdletBinding()]param($PolicyStore, $Name) $script:rule }
function Get-NetFirewallAddressFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:address } }
function Get-NetFirewallPortFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:port } }
function Get-NetFirewallApplicationFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:application } }
function Get-NetFirewallServiceFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:service } }
function Get-NetFirewallInterfaceFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:interface } }
function Get-NetFirewallInterfaceTypeFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:interfaceType } }
function Get-NetFirewallSecurityFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:security } }
Assert-GatewayFirewall $settings
Assert-Test $true 'exact manual gateway firewall rule accepted'
$fields = @(
    @('rule', 'Enabled', 'False'), @('rule', 'Action', 'Block'), @('rule', 'Direction', 'Outbound'), @('rule', 'Profile', 'Any'),
    @('address', 'LocalAddress', 'Any'), @('address', 'RemoteAddress', 'LocalSubnet'),
    @('port', 'LocalPort', '11434'), @('port', 'RemotePort', '443'), @('port', 'Protocol', 'UDP'),
    @('application', 'Program', 'Any'), @('application', 'Package', 'other'), @('service', 'Service', 'other'),
    @('interface', 'InterfaceAlias', 'other'), @('interfaceType', 'InterfaceType', 'Wireless'),
    @('security', 'Authentication', 'Required'), @('security', 'Encryption', 'Required'),
    @('security', 'OverrideBlockRules', 'True'), @('security', 'LocalUser', 'other'), @('security', 'RemoteUser', 'other'), @('security', 'RemoteMachine', 'other')
)
foreach ($field in $fields) {
    $value = Get-Variable -Name $field[0] -Scope Script -ValueOnly
    $original = $value.($field[1])
    $value.($field[1]) = $field[2]
    Expect-Refusal { Assert-GatewayFirewall $settings } 'different firewall filter refused'
    $value.($field[1]) = $original
}

$script:rule = [pscustomobject]@{ Enabled = 'True'; Action = 'Block'; Direction = 'Inbound'; Profile = 'Any' }
$script:address = [pscustomobject]@{ LocalAddress = 'Any'; RemoteAddress = 'Any' }
$script:port = [pscustomobject]@{ LocalPort = '11434'; RemotePort = 'Any'; Protocol = 'TCP' }
$script:application = [pscustomobject]@{ Program = 'Any'; Package = 'Any' }
$script:profiles = @('Domain', 'Private', 'Public') | ForEach-Object { [pscustomobject]@{ Name = $_; Enabled = 'True'; AllowLocalFirewallRules = 'NotConfigured'; DisabledInterfaceAliases = @() } }
function Get-NetFirewallProfile { [CmdletBinding()]param($PolicyStore, $Name) $script:profiles }
Assert-SkaoRawFirewall
Assert-Test $true 'dedicated all-profile raw port block accepted'
$rawFields = @(
    @('rule', 'Enabled', 'False'), @('rule', 'Action', 'Allow'), @('rule', 'Direction', 'Outbound'), @('rule', 'Profile', 'Private'),
    @('address', 'LocalAddress', '192.168.1.10'), @('address', 'RemoteAddress', 'LocalSubnet'),
    @('port', 'LocalPort', '8443'), @('port', 'RemotePort', '443'), @('port', 'Protocol', 'UDP'),
    @('application', 'Program', 'other'), @('application', 'Package', 'other'), @('service', 'Service', 'other'),
    @('interface', 'InterfaceAlias', 'other'), @('interfaceType', 'InterfaceType', 'Wireless'),
    @('security', 'Authentication', 'Required'), @('security', 'Encryption', 'Required'),
    @('security', 'OverrideBlockRules', 'True'), @('security', 'LocalUser', 'other'), @('security', 'RemoteUser', 'other'), @('security', 'RemoteMachine', 'other')
)
foreach ($field in $rawFields) {
    $value = Get-Variable -Name $field[0] -Scope Script -ValueOnly
    $original = $value.($field[1])
    $value.($field[1]) = $field[2]
    Expect-Refusal { Assert-SkaoRawFirewall } 'narrowed or weakened raw block refused'
    $value.($field[1]) = $original
}
foreach ($profile in $script:profiles) {
    $profile.Enabled = 'False'
    Expect-Refusal { Assert-SkaoRawFirewall } 'disabled firewall profile rejected'
    $profile.Enabled = 'True'
    $profile.AllowLocalFirewallRules = 'False'
    Expect-Refusal { Assert-SkaoRawFirewall } 'disabled local policy merge rejected'
    $profile.AllowLocalFirewallRules = 'NotConfigured'
    $profile.DisabledInterfaceAliases = @('Ethernet')
    Expect-Refusal { Assert-SkaoRawFirewall } 'interface excluded from firewall rejected'
    $profile.DisabledInterfaceAliases = @()
}
$allProfiles = $script:profiles
$script:profiles = @($allProfiles[0], $allProfiles[1])
Expect-Refusal { Assert-SkaoRawFirewall } 'incomplete profile inventory rejected'
$script:profiles = $allProfiles
$oneAddress = $script:address
$script:address = @($oneAddress, $oneAddress)
Expect-Refusal { Assert-SkaoRawFirewall } 'ambiguous filter inventory rejected'
$script:address = $oneAddress

# The read-only token loader must preserve the exact manual export/config bytes.
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('skao-gateway-test-' + [guid]::NewGuid().ToString('N'))
try {
    $null = New-Item -ItemType Directory -Path $temporary
    $aiGateway = $temporary
    $aiExport = Join-Path $temporary 'pi-connection'
    $aiConfig = Join-Path $temporary 'Caddyfile'
    $null = New-Item -ItemType Directory -Path $aiExport
    function Assert-ProtectedPath { param([string]$Path, [switch]$Directory, [long]$MaximumLength = 1048576) }
    $token = 'a' * 43
    $envPath = Join-Path $aiExport 'ai.env'
    $envText = (Get-ConnectionEnvironment $settings $token) + "`n"
    $configText = (Get-GatewayConfiguration $settings $token) + "`n"
    [IO.File]::WriteAllText($envPath, $envText)
    [IO.File]::WriteAllText($aiConfig, $configText)
    $beforeEnv = (Get-Item -LiteralPath $envPath).LastWriteTimeUtc
    Assert-Test ((Get-ExistingToken) -ceq $token) 'matching manual token reused'
    Assert-Test ([IO.File]::ReadAllText($envPath) -ceq $envText -and [IO.File]::ReadAllText($aiConfig) -ceq $configText -and (Get-Item -LiteralPath $envPath).LastWriteTimeUtc -eq $beforeEnv) 'token read never rewrites source'
    Assert-Text $envPath $envText.Replace("`n", "`r`n")
    Assert-Test $true 'manual CRLF or LF accepted'
    [IO.File]::WriteAllText($envPath, $envText.Replace($token, ('b' * 43)))
    Expect-Refusal { Get-ExistingToken | Out-Null } 'mismatched token never regenerated'
    [IO.File]::WriteAllText($envPath, $envText + ('SKAO_AI_TOKEN=' + $token + "`n"))
    Expect-Refusal { Get-ExistingToken | Out-Null } 'duplicate token rejected'
    [IO.File]::WriteAllText($envPath, 'not a connection file')
    Expect-Refusal { Get-ExistingToken | Out-Null } 'malformed token rejected'
    Assert-Test ($configText -cmatch 'path /api/status /api/tags' -and $configText -cmatch 'path /api/show /api/generate' -and $configText -cmatch 'max_size 65536' -and $configText -cmatch 'header_up -Authorization') 'only intended gateway routes rendered'
    # .NET Framework exposes this provider's KeySize as read-only.
    $key = New-Object Security.Cryptography.RSACryptoServiceProvider(2048)
    try {
        $key.PersistKeyInCsp = $false
        $name = New-Object Security.Cryptography.X509Certificates.X500DistinguishedName('CN=SKAO synthetic test CA')
        $request = New-Object Security.Cryptography.X509Certificates.CertificateRequest($name, $key, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $request.CertificateExtensions.Add((New-Object Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($true, $false, 0, $true)))
        $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(2))
        try {
            $pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert), [Base64FormattingOptions]::InsertLineBreaks).Replace("`r`n", "`n") + "`n-----END CERTIFICATE-----`n"
            $certificatePath = Join-Path $temporary 'ca.pem'
            [IO.File]::WriteAllText($certificatePath, $pem)
            Assert-PublicCa $certificatePath
            Assert-Test $true 'real synthetic public CA accepted'
            [IO.File]::WriteAllText($certificatePath, $pem + $pem)
            Expect-Refusal { Assert-PublicCa $certificatePath } 'multiple certificates rejected'
            [IO.File]::WriteAllText($certificatePath, $pem + '-----BEGIN PRIVATE KEY-----')
            Expect-Refusal { Assert-PublicCa $certificatePath } 'appended private key rejected'
        }
        finally { $certificate.Dispose() }
        $expired = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-3), [DateTimeOffset]::Now.AddDays(-1))
        try {
            $pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($expired.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert), [Base64FormattingOptions]::InsertLineBreaks).Replace("`r`n", "`n") + "`n-----END CERTIFICATE-----`n"
            [IO.File]::WriteAllText($certificatePath, $pem)
            Expect-Refusal { Assert-PublicCa $certificatePath } 'expired certificate rejected'
        }
        finally { $expired.Dispose() }
    }
    finally { $key.Dispose() }
}
finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    $env:LOCALAPPDATA = $oldLocal
    $env:SystemRoot = $oldRoot
}

# Canonical v2 profile adoption and migration use real temporary files; native
# task/firewall/worker operations are isolated at their explicit boundaries.
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('skao-gateway-v2-' + [guid]::NewGuid().ToString('N'))
try {
    [void](New-Item -ItemType Directory -Path $temporary)
    $env:SystemRoot = $temporary
    $aiGateway = $temporary; $aiConfig = Join-Path $temporary 'Caddyfile'
    $aiExport = Join-Path $temporary 'pi-connection'; [void](New-Item -ItemType Directory -Path $aiExport)
    $aiMetadataPath = Join-Path $temporary 'setup.json'; $aiLauncher = Join-Path $temporary 'Run-Gateway.cmd'
    $aiPublicCa = Join-Path $temporary 'root.crt'; $aiBinary = Join-Path $temporary 'caddy.exe'
    $settings = [pscustomobject]@{ Version = 1; OwnerSid = $aiSid; LaptopIp = '192.168.1.10'; PiIp = '192.168.1.20' }
    $token = 'a' * 43
    [IO.File]::WriteAllText($aiMetadataPath, ($settings | ConvertTo-Json))
    [IO.File]::WriteAllText($aiLauncher, (Get-GatewayLauncher))
    [IO.File]::WriteAllText($aiPublicCa, 'synthetic public CA')
    [IO.File]::WriteAllText((Join-Path $aiExport 'ca.pem'), 'synthetic public CA')
    [IO.File]::WriteAllText($aiBinary, 'synthetic pinned executable')
    [IO.File]::WriteAllText((Join-Path $aiExport 'ai.env'), (Get-ConnectionEnvironment $settings $token))
    $v1 = (Get-GatewayConfiguration $settings $token 1).Replace("`n", "`r`n") + "`r`n"
    $v2 = Get-GatewayConfiguration $settings $token 2
    [IO.File]::WriteAllText($aiConfig, $v1)
    Assert-Test ((Get-GatewayProfile $settings $token) -eq 1 -and (Get-ExistingToken) -ceq $token) 'exact legacy profile and token still adopted'
    $preserved = @{}
    foreach ($path in @($aiMetadataPath, $aiLauncher, $aiPublicCa, $aiBinary, (Join-Path $aiExport 'ai.env'), (Join-Path $aiExport 'ca.pem'))) {
        $preserved[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    }
    [IO.File]::WriteAllText($aiConfig, $v2)
    Assert-Test ((Get-GatewayProfile $settings $token) -eq 2 -and (Get-ExistingToken) -ceq $token) 'exact image-capable profile reuses the same protected token'
    Assert-Test (@([regex]::Matches($v2, 'header Authorization "Bearer ([A-Za-z0-9_-]{43})"')).Count -eq 6) 'each v2 route group has explicit token authentication'
    Assert-Test (@([regex]::Matches($v2, 'remote_ip 192\.168\.1\.20')).Count -eq 6) 'each v2 route group requires the saved Pi source address'
    Assert-Test (@([regex]::Matches($v2, 'http\.request\.uri\.query')).Count -eq 6) 'all v2 groups reject query strings'
    Assert-Test (@([regex]::Matches($v2, 'max_size 16384')).Count -eq 3 -and @([regex]::Matches($v2, 'max_size 65536')).Count -eq 2) 'image bodies are16KiB and existing text bodies remain64KiB'
    Assert-Test ($v2.Contains('header X-SKAO-Gateway-Profile "activity-images-v1"') -and
        $v2.Contains('header_up Host 127.0.0.1:11435') -and $v2.Contains('method DELETE')) 'v2 advertises only its nonsecret profile and uses the loopback worker'
    $getExpression = [regex]::Match($v2, 'path_regexp activityImageGet "([^"]+)"').Groups[1].Value
    $deleteExpression = [regex]::Match($v2, 'path_regexp activityImageDelete "([^"]+)"').Groups[1].Value
    $job = '12345678-1234-1234-1234-123456789abc'
    foreach ($path in @('/api/activity-images/status', ('/api/activity-images/jobs/' + $job), ('/api/activity-images/jobs/' + $job + '/frames/1'), ('/api/activity-images/jobs/' + $job + '/frames/6'))) {
        Assert-Test ($path -cmatch $getExpression) 'only bounded canonical image GET paths match'
    }
    foreach ($path in @(('/api/activity-images/jobs/' + $job + '/frames/0'), ('/api/activity-images/jobs/' + $job + '/frames/7'),
        ('/api/activity-images/jobs/' + $job.ToUpperInvariant()), '/api/activity-images/jobs/not-a-job', '/api/activity-images/other')) {
        Assert-Test ($path -cnotmatch $getExpression) 'invalid IDs frames and unknown image paths do not match'
    }
    Assert-Test (('/api/activity-images/jobs/' + $job) -cmatch $deleteExpression -and
        ('/api/activity-images/jobs/' + $job + '/frames/1') -cnotmatch $deleteExpression) 'DELETE is limited to a whole canonical job'
    $beforeUnknown = $v2 + "`n# unrecognized local customization"
    [IO.File]::WriteAllText($aiConfig, $beforeUnknown)
    Expect-Refusal { Get-GatewayProfile $settings $token | Out-Null } 'unknown configuration remains refused'
    Assert-Test ([IO.File]::ReadAllText($aiConfig) -ceq $beforeUnknown) 'profile inspection never rewrites foreign configuration'
    [IO.File]::WriteAllText($aiConfig, $v2.Replace('header Authorization "Bearer ' + $token + '"', 'header Authorization "Bearer ' + ('b' * 43) + '"'))
    Expect-Refusal { Get-ExistingToken | Out-Null } 'v2 token mismatch is never regenerated'
    [IO.File]::WriteAllText($aiConfig, $v1)
    $ready = [pscustomobject]@{ version = 1; enabled = $true; available = $true; busy = $false; model = 'sd_xl_base_1.0.safetensors'; message = 'ready' }
    Assert-SkaoActivityWorkerStatus $ready
    Assert-Test $true 'typed local worker capability is accepted without inference'
    foreach ($change in @(@('version','1'), @('enabled','true'), @('available',$false), @('busy','false'), @('model','remote'))) {
        $status = Copy-TestObject $ready; $status.($change[0]) = $change[1]
        Expect-Refusal { Assert-SkaoActivityWorkerStatus $status } 'unavailable or incorrectly typed worker capability refused'
    }
    $script:GatewayRestarts = @(); $script:GatewayShows = @(); $script:WorkerStatusCalls = 0
    $script:WorkerStatus = $ready; $script:ValidationFails = $false; $script:RestartV2Fails = $false; $script:ActiveProfile = 1
    function Assert-Administrator { }
    function Assert-GatewayBinary { }
    function Assert-CurrentCaExport { }
    function Assert-SkaoActivityImageIsolation { }
    function Invoke-SkaoActivityWorkerStatus { param($Token) $script:WorkerStatusCalls++; return $script:WorkerStatus }
    function Show-GatewayCheck { param($Settings,$Profile=1) $script:GatewayShows += $Profile }
    function Test-SkaoGatewayProfileActive { param($Settings) return $script:ActiveProfile -eq 2 }
    function Test-SkaoGatewayCandidate {
        param($Path,$LogPath)
        Assert-Text $Path (Get-GatewayConfiguration $settings $token 2)
        [IO.File]::WriteAllText($LogPath, 'synthetic validation output without credentials')
        if ($script:ValidationFails) { Stop-Skao 'synthetic candidate rejection' }
    }
    function Restart-SkaoGatewayTask {
        param($Settings,$Profile)
        $script:GatewayRestarts += $Profile
        if ($Profile -eq 2 -and $script:RestartV2Fails) { Stop-Skao 'synthetic restart failure' }
        $script:ActiveProfile = $Profile
    }
    function Register-ScheduledTask { throw 'Unexpected gateway task registration or credential replacement.' }
    $result = Use-SkaoGatewayProfile -Settings $settings -Token $token -Profile 1
    Assert-Test ($result -eq 1 -and $script:GatewayRestarts.Count -eq 0 -and $script:WorkerStatusCalls -eq 0 -and
        [IO.File]::ReadAllText($aiConfig) -ceq $v1) 'ordinary v1 adoption makes no changes and has no worker prerequisite'
    Expect-Refusal { Use-SkaoGatewayProfile -Settings $settings -Token $token -Profile 1 -Check -ActivityImages | Out-Null } 'image check never migrates legacy gateway'
    Assert-Test ([IO.File]::ReadAllText($aiConfig) -ceq $v1 -and $script:GatewayRestarts.Count -eq 0) 'missing image-profile check preserves legacy bytes and task'
    $script:WorkerStatus = Copy-TestObject $ready; $script:WorkerStatus.busy = $true
    Expect-Refusal { Enable-SkaoGatewayActivityImages $settings $token } 'busy worker prevents gateway replacement'
    Assert-Test ([IO.File]::ReadAllText($aiConfig) -ceq $v1 -and $script:GatewayRestarts.Count -eq 0) 'busy-worker refusal preserves gateway'
    $script:WorkerStatus = $ready; $script:ValidationFails = $true
    Expect-Refusal { Enable-SkaoGatewayActivityImages $settings $token } 'invalid staged configuration cannot replace gateway'
    Assert-Test ([IO.File]::ReadAllText($aiConfig) -ceq $v1 -and $script:GatewayRestarts.Count -eq 0) 'candidate failure never restarts gateway or replaces bytes'
    $script:ValidationFails = $false; $script:RestartV2Fails = $true
    $caught = $null
    try { Enable-SkaoGatewayActivityImages $settings $token } catch { $caught = $_ }
    Assert-Test ($caught.Exception.Data['SkaoSafe'] -eq $true -and !$caught.Exception.Message.Contains($token)) 'migration failure exposes a safe token-free message'
    Assert-Test (($script:GatewayRestarts -join ',') -ceq '2,1' -and [IO.File]::ReadAllText($aiConfig) -ceq $v1) 'failed image restart restores exact original CRLF bytes and restarts original profile'
    $script:RestartV2Fails = $false; $script:GatewayRestarts = @()
    $result = Use-SkaoGatewayProfile -Settings $settings -Token $token -Profile 1 -ActivityImages
    Assert-Test ($result -eq 2 -and ($script:GatewayRestarts -join ',') -ceq '2' -and
        (Get-GatewayProfile $settings $token) -eq 2) 'explicit enable switches only a recognized v1 profile after worker readiness'
    foreach ($path in $preserved.Keys) {
        Assert-Test ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ceq $preserved[$path]) 'profile migration preserves metadata CA exports launcher and pinned binary bytes'
    }
    $beforeRepeat = [IO.File]::ReadAllText($aiConfig); $restartCount = $script:GatewayRestarts.Count
    $result = Use-SkaoGatewayProfile -Settings $settings -Token $token -Profile 2
    $result = Use-SkaoGatewayProfile -Settings $settings -Token $token -Profile 2 -Check -ActivityImages
    Assert-Test ($result -eq 2 -and $script:GatewayRestarts.Count -eq $restartCount -and
        [IO.File]::ReadAllText($aiConfig) -ceq $beforeRepeat) 'default adoption and explicit read-only v2 check never downgrade or restart a healthy profile'
    $script:ActiveProfile = 1
    $result = Use-SkaoGatewayProfile -Settings $settings -Token $token -Profile 2
    Assert-Test ($result -eq 2 -and $script:GatewayRestarts.Count -eq $restartCount + 1 -and
        [IO.File]::ReadAllText($aiConfig) -ceq $beforeRepeat) 'normal setup resumes an interrupted atomic profile switch without config or credential rewrite'

    # Readiness needs both verified denial and the active v2 marker, never just403.
    $script:CurlReplies = @(
        [pscustomobject]@{ ExitCode = 0; Lines = @('403') },
        [pscustomobject]@{ ExitCode = 0; Lines = @('HTTP/1.1 403 Forbidden', 'X-SKAO-Gateway-Profile: activity-images-v1', '', '403') }
    )
    $script:CurlCalls = 0; $script:ProfileRequests = @()
    function Invoke-SkaoGatewayCurl {
        param($Url,$CaFile,$TimeoutSeconds,[switch]$IncludeProfile)
        $script:ProfileRequests += [bool]$IncludeProfile
        $reply = $script:CurlReplies[[Math]::Min($script:CurlCalls,$script:CurlReplies.Count-1)]
        $script:CurlCalls++; return $reply
    }
    Wait-SkaoGatewayHttps -Url 'https://192.168.1.10:8443/api/status' -CaFile $aiPublicCa -TimeoutSeconds 2 -ExpectedProfile 'activity-images-v1'
    Assert-Test ($script:CurlCalls -eq 2 -and @($script:ProfileRequests | Where-Object { !$_ }).Count -eq 0) 'old-profile403 alone cannot satisfy v2 readiness'
}
finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    $env:LOCALAPPDATA = $oldLocal
    $env:SystemRoot = $oldRoot
}
Write-Host ('PASS: ' + $count + ' gateway PowerShell checks')
