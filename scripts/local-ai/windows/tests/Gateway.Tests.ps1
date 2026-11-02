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
Write-Host ('PASS: ' + $count + ' gateway PowerShell checks')
