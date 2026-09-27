# Dependency-free tests: Windows PowerShell 5.1 in CI, PowerShell 7 locally.
# All Docker, network, firewall and Git operations below are test doubles.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $SourceRoot 'scripts/pilot-menu.ps1')
. (Join-Path $SourceRoot 'scripts/pilot-network.ps1')
# Load the real settings/certificate helpers, without executing the pilot entry point.
$Tokens = $null; $Errors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $SourceRoot 'scripts/pilot.ps1'), [ref]$Tokens, [ref]$Errors)
if ($Errors.Count) { throw 'pilot.ps1 has parse errors.' }
foreach ($Definition in $Ast.EndBlock.Statements) {
    if ($Definition -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($Definition.Extent.Text))
    }
}
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('skao-automation-' + [guid]::NewGuid().ToString('N'))
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Passed = 0
$Failed = 0

function Assert([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Work, [string]$Pattern) {
    $Thrown = $false
    try { & $Work | Out-Null }
    catch { $Thrown = $true; Assert ($_.Exception.Message -match $Pattern) "Unexpected error: $($_.Exception.Message)" }
    Assert $Thrown "Expected an error matching: $Pattern"
}
function Test([string]$Name, [scriptblock]$Work) {
    try { Reset-Scenario; & $Work; $script:Passed++; Write-Host "PASS $Name" }
    catch { $script:Failed++; Write-Host "FAIL $Name`: $($_.Exception.Message)`n$($_.ScriptStackTrace)" }
}
function New-Address([string]$IP = '192.168.50.20', [string]$Alias = 'Wi-Fi', [string]$Category = 'Private') {
    return [pscustomobject]@{ IPAddress = $IP; InterfaceAlias = $Alias; NetworkCategory = $Category }
}
function Reset-Scenario {
    $script:Repo = Join-Path $TestRoot ([guid]::NewGuid().ToString('N'))
    $script:Private = Join-Path $Repo '.pilot'
    $script:SettingsFile = Join-Path $Private 'runtime.env'
    New-Item -ItemType Directory -Path $Private -Force | Out-Null
    $script:Initial = @{ PILOT_HOST = 'localhost'; PILOT_BIND = '127.0.0.1'; PILOT_DATABASE = 'ska_organizer';
        PILOT_RELEASE = ('a' * 40); FACILITY_TIME_ZONE = 'America/Los_Angeles'; PILOT_BACKUP_DIR = (Join-Path $Repo 'backups') }
    WriteSettings $Initial
    [System.IO.File]::WriteAllText((Join-Path $Private 'secret-sentinel'), 'synthetic secret - preserve', $Utf8)
    $script:Addresses = @((New-Address))
    $script:Rules = @{}
    $script:Calls = New-Object System.Collections.Generic.List[object]
    $script:FailUp = $false; $script:FailRollback = $false; $script:FailHttps = $false
    $script:FailFirewallOnce = $false; $script:FailImage = $false; $script:FailConfig = $false
    $script:FailFirewallRestore = $false; $script:BadPorts = $false; $script:PrivateKeyExport = $false
    $script:FirewallEnabled = 'True'; $script:FirewallPolicy = 'Block'
    $script:Dirty = $false; $script:Branch = 'development'; $script:Upstream = 'origin/development'
    $script:FailPull = $false; $script:MissingWeb = $false; $script:BadDatabasePort = $false
    $script:FailSettingsRestore = $false; $script:Admin = $true; $script:ChildExit = 0
}
function Record([string]$Program, [string[]]$Arguments) { $script:Calls.Add([pscustomobject]@{ Program = $Program; Arguments = $Arguments }) }
function Assert-PilotAdministrator { }
function Test-SkaoAdministrator { return $script:Admin }
function GitRelease { return $script:Initial.PILOT_RELEASE }
function Start-Process {
    [CmdletBinding()]param($FilePath,$ArgumentList,$WorkingDirectory,$Verb,[switch]$NoNewWindow,[switch]$Wait,[switch]$PassThru)
    Assert ($Wait -and $PassThru) 'Did not wait for the child exit code.'
    if ($Verb -eq 'RunAs') {
        Assert (!$NoNewWindow) 'Combined elevation with NoNewWindow.'
        Record 'elevate' @($FilePath,$ArgumentList,$Verb)
    } else {
        Assert ($NoNewWindow) 'Did not preserve the console connection.'
        Assert ($WorkingDirectory -eq $Repo) 'Changed the child working directory.'
        Record $FilePath @($ArgumentList)
    }
    return [pscustomobject]@{ ExitCode = $script:ChildExit }
}
function Copy-Item {
    [CmdletBinding()]param($LiteralPath,$Destination,[switch]$Force)
    if ($script:FailSettingsRestore -and $LiteralPath -eq (Join-Path $Private 'lan-previous.env') -and $Destination -eq $SettingsFile) { throw 'Synthetic settings restore failure' }
    Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}
function Get-Command { [CmdletBinding()]param([string]$Name) return [pscustomobject]@{ Name = $Name } }
function Get-NetIPConfiguration {
    [CmdletBinding()]param()
    for ($Index = 0; $Index -lt $script:Addresses.Count; $Index++) {
        $Address = $script:Addresses[$Index]
        [pscustomobject]@{ InterfaceIndex = $Index; InterfaceAlias = $Address.InterfaceAlias;
            NetProfile = [pscustomobject]@{ NetworkCategory = $Address.NetworkCategory } }
    }
}
function Get-NetIPAddress {
    [CmdletBinding()]param($InterfaceIndex, $AddressFamily, $AddressState)
    [pscustomobject]@{ IPAddress = $script:Addresses[$InterfaceIndex].IPAddress; SkipAsSource = $false }
}
function Get-NetFirewallProfile {
    [CmdletBinding()]param($PolicyStore, $Name)
    [pscustomobject]@{ Enabled = $script:FirewallEnabled; DefaultInboundAction = $script:FirewallPolicy; AllowInboundRules = 'True' }
}
function Get-NetFirewallRule {
    [CmdletBinding()]param($PolicyStore)
    foreach ($Rule in $script:Rules.Values) { [pscustomobject]$Rule }
}
function Get-NetFirewallPortFilter {
    [CmdletBinding()]param([Parameter(ValueFromPipeline)]$InputObject)
    process { [pscustomobject]@{ Protocol = $InputObject.Protocol; LocalPort = $InputObject.LocalPort; RemotePort = $InputObject.RemotePort } }
}
function Get-NetFirewallAddressFilter {
    [CmdletBinding()]param([Parameter(ValueFromPipeline)]$InputObject)
    process { [pscustomobject]@{ LocalAddress = $InputObject.LocalAddress; RemoteAddress = $InputObject.RemoteAddress } }
}
function Get-NetFirewallInterfaceFilter {
    [CmdletBinding()]param([Parameter(ValueFromPipeline)]$InputObject)
    process { [pscustomobject]@{ InterfaceAlias = $InputObject.InterfaceAlias } }
}
function New-NetFirewallRule {
    [CmdletBinding()]param($PolicyStore,$Name,$DisplayName,$Direction,$Action,$Enabled,$Protocol,$LocalPort,$RemotePort,$LocalAddress,$RemoteAddress,$Profile,$EdgeTraversalPolicy,$InterfaceAlias)
    Assert (!$script:Rules.ContainsKey($Name)) 'Duplicate firewall rule created.'
    $script:Rules[$Name] = @{ Name = $Name; DisplayName = $DisplayName }
    foreach ($Key in $PSBoundParameters.Keys) { if ($Key -notin @('PolicyStore','ErrorAction')) { $script:Rules[$Name][$Key] = $PSBoundParameters[$Key] } }
    Record 'firewall-new' @($Name)
    if ($script:FailFirewallOnce) { $script:FailFirewallOnce = $false; throw 'Synthetic firewall write failure' }
}
function Set-NetFirewallRule {
    [CmdletBinding()]param($PolicyStore,$Name,$Direction,$Action,$Enabled,$Protocol,$LocalPort,$RemotePort,$LocalAddress,$RemoteAddress,$Profile,$EdgeTraversalPolicy,$InterfaceAlias)
    if ($script:FailFirewallRestore -and $LocalAddress -eq '127.0.0.1') { throw 'Synthetic firewall restore failure' }
    Assert ($script:Rules.ContainsKey($Name)) 'Missing firewall rule.'
    foreach ($Key in $PSBoundParameters.Keys) { if ($Key -notin @('PolicyStore','ErrorAction')) { $script:Rules[$Name][$Key] = $PSBoundParameters[$Key] } }
    Record 'firewall-set' @($Name)
    if ($script:FailFirewallOnce) { $script:FailFirewallOnce = $false; throw 'Synthetic firewall write failure' }
}
function Remove-NetFirewallRule {
    [CmdletBinding()]param($PolicyStore, $Name)
    $script:Rules.Remove($Name)
    Record 'firewall-remove' @($Name)
}
function Compose([string[]]$Arguments, [string]$ConfigFile = $SettingsFile) {
    Record 'compose' $Arguments
    if ($Arguments[0] -eq 'config' -and $script:FailConfig) { throw 'Synthetic config failure' }
    if ($Arguments[0] -eq 'up') {
        $Active = ReadSettings
        if (($script:FailUp -and $Active.PILOT_HOST -ne 'localhost') -or ($script:FailRollback -and $Active.PILOT_HOST -eq 'localhost')) { throw 'Synthetic container health failure' }
    }
    if ($Arguments[0] -eq 'ps' -and $Arguments[1] -eq '-q') {
        if ($script:MissingWeb -and $Arguments[2] -eq 'web') { return '' }
        return $Arguments[2]
    }
}
function Native([string]$Program, [string[]]$Arguments) {
    Record $Program $Arguments
    if ($Program -eq 'curl.exe') {
        if ($script:FailHttps) { throw 'Synthetic TLS hostname failure' }
        return '200'
    }
    if ($Program -eq 'docker') {
        switch ($Arguments[0]) {
            'image' { if ($script:FailImage) { throw 'Synthetic missing release image' }; return 'sha256:synthetic' }
            'cp' {
                $Contents = $script:PublicPem
                if ($script:PrivateKeyExport) { $Contents += "`n-----BEGIN PRIVATE KEY-----`nsynthetic`n-----END PRIVATE KEY-----" }
                [System.IO.File]::WriteAllText($Arguments[2], $Contents, $Utf8)
            }
            'inspect' {
                if ($Arguments[-1] -eq 'web') {
                    $IP = (ReadSettings).PILOT_BIND
                    if ($script:BadPorts) { $IP = '0.0.0.0' }
                    return ('{"80/tcp":null,"8443/tcp":[{"HostIp":"' + $IP + '","HostPort":"8443"}]}')
                }
                if ($script:BadDatabasePort -and $Arguments[-1] -eq 'db') { return '{"5432/tcp":[{"HostIp":"0.0.0.0","HostPort":"5432"}]}' }
                return '{}'
            }
            default { throw "Unexpected docker command: $Arguments" }
        }
        return
    }
    throw "Unexpected external command: $Program"
}
function Invoke-SkaoGit([string[]]$Arguments) {
    Record 'git' $Arguments
    switch ($Arguments[0]) {
        'status' { if ($script:Dirty) { return ' M user-work.txt' }; return }
        'branch' { return $script:Branch }
        'rev-parse' { return $script:Upstream }
        'pull' { if ($script:FailPull) { throw 'Synthetic diverged branch' }; return }
        default { throw 'Unexpected Git command.' }
    }
}
function Run-Lan { Set-PilotLan (ReadSettings) '' '' | Out-Null }
function Assert-Preserved {
    $Current = ReadSettings
    foreach ($Key in @('PILOT_RELEASE','PILOT_DATABASE','PILOT_BACKUP_DIR','FACILITY_TIME_ZONE')) { Assert ($Current[$Key] -ceq $Initial[$Key]) "Changed $Key" }
    Assert ((Get-Content -LiteralPath (Join-Path $Private 'secret-sentinel') -Raw) -ceq 'synthetic secret - preserve') 'Changed existing secrets.'
    Assert (@($script:Calls | Where-Object { $_.Arguments -contains 'build' -or $_.Arguments -contains 'migrate' -or $_.Arguments -contains 'down' -or $_.Arguments -contains 'prune' }).Count -eq 0) 'LAN setup built, migrated, destroyed, or pruned something.'
}

try {
    # A fresh synthetic CA only for public-certificate format checks. No key is written to disk.
    # Windows PowerShell's default RSA provider exposes KeySize as read-only.
    # Select the key size at construction on both supported PowerShell editions.
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        $RSA = [System.Security.Cryptography.RSACng]::new(2048)
    } else {
        $RSA = [System.Security.Cryptography.RSA]::Create(2048)
    }
    $Request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=SKAO synthetic automation CA', $RSA,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $Request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
    $Certificate = $Request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(7))
    $PublicBytes = $Certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    $script:PublicPem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($PublicBytes, [Base64FormattingOptions]::InsertLineBreaks) + "`n-----END CERTIFICATE-----`n"
    $Certificate.Dispose(); $RSA.Dispose()

    Test 'Only canonical private IPv4 addresses are accepted' {
        foreach ($IP in @('10.0.0.2','172.16.0.5','172.31.255.254','192.168.50.20')) { Assert (Test-PilotPrivateIPv4 $IP) "Rejected $IP" }
        foreach ($IP in @('127.0.0.1','0.0.0.0','8.8.8.8','169.254.1.1','172.15.1.1','172.32.1.1','::1','192.168.01.1','10.1','10.0.0.999')) { Assert (!(Test-PilotPrivateIPv4 $IP)) "Accepted $IP" }
    }
    Test 'Public networks stop before settings or firewall changes' {
        $script:Addresses = @((New-Address '192.168.50.20' 'Wi-Fi' 'Public'))
        Assert-Throws { Run-Lan } 'No matching private LAN'
        Assert ($script:Calls.Count -eq 0) 'Made a system change.'
        Assert ((ReadSettings).PILOT_HOST -eq 'localhost') 'Changed settings.'
    }
    Test 'Explicit address and adapter select the intended private network' {
        $script:Addresses = @((New-Address), (New-Address '10.1.2.3' 'Ethernet'))
        $Target = Select-PilotLanAddress '10.1.2.3' 'Ethernet' ''
        Assert ($Target.InterfaceAlias -eq 'Ethernet') 'Selected the wrong network.'
        Assert-Throws { Select-PilotLanAddress '10.1.2.3' 'Wi-Fi' '' } 'No matching'
    }
    Test 'Existing private address wins when multiple adapters are connected' {
        $script:Addresses = @((New-Address), (New-Address '10.1.2.3' 'Ethernet'))
        Assert ((Select-PilotLanAddress '' '' '10.1.2.3').IPAddress -eq '10.1.2.3') 'Changed adapters unnecessarily.'
    }
    Test 'Disabled firewall prevents configuration' {
        $script:FirewallEnabled = 'False'
        Assert-Throws { Run-Lan } 'Private firewall must be enabled'
        Assert ($script:Rules.Count -eq 0) 'Created a rule with firewall disabled.'
    }
    Test 'Allow-all inbound policy prevents configuration' {
        $script:FirewallPolicy = 'Allow'
        Assert-Throws { Run-Lan } 'block unsolicited'
    }
    Test 'First setup preserves data and publishes a matching phone URL' {
        Run-Lan
        Assert ((ReadSettings).PILOT_HOST -eq '192.168.50.20') 'Wrong HTTPS hostname.'
        Assert ((ReadSettings).PILOT_BIND -eq '192.168.50.20') 'Wrong bind address.'
        Assert-Preserved
        Assert-PilotFirewall (New-Address)
        Assert (Test-Path -LiteralPath (Join-Path $Private 'phone/academy-root.cer')) 'Missing public certificate.'
        Assert ((Get-Content -LiteralPath (Join-Path $Private 'phone/PHONE.txt') -Raw) -match 'https://192.168.50.20:8443') 'Missing phone URL.'
    }
    Test 'Repeated setup reuses a single narrow firewall rule' {
        Run-Lan; Run-Lan
        Assert ($script:Rules.Count -eq 1) 'Duplicated rule.'
        Assert (@($script:Calls | Where-Object { $_.Program -eq 'firewall-new' }).Count -eq 1) 'Recreated rule unnecessarily.'
        Assert-Preserved
    }
    Test 'DHCP address change updates host, binding, firewall and exported URL' {
        Run-Lan
        $script:Addresses = @((New-Address '192.168.50.45'))
        Run-Lan
        Assert ((ReadSettings).PILOT_BIND -eq '192.168.50.45') 'Kept stale bind.'
        Assert ($script:Rules['SKAO-Pilot-HTTPS-8443'].LocalAddress -eq '192.168.50.45') 'Kept stale rule.'
        Assert-Preserved
    }
    Test 'Legacy firewall rule is repaired without replacing unrelated rules' {
        $Parameters = Get-PilotFirewallParameters (New-Address)
        New-NetFirewallRule -Name 'legacy-guid' -DisplayName 'SKAO private HTTPS 8443' @Parameters
        $script:Rules['legacy-guid'].InterfaceAlias = 'Any'
        $script:Rules['unrelated'] = @{ Name = 'unrelated'; DisplayName = 'Another app' }
        Run-Lan
        Assert ($script:Rules.Count -eq 2 -and $script:Rules.ContainsKey('legacy-guid') -and $script:Rules.ContainsKey('unrelated')) 'Changed rule ownership.'
        Assert ($script:Rules['legacy-guid'].InterfaceAlias -eq 'Wi-Fi') 'Did not narrow legacy rule.'
    }
    Test 'Duplicate SKAO rules are refused before mutation' {
        $Parameters = Get-PilotFirewallParameters (New-Address)
        New-NetFirewallRule -Name 'one' -DisplayName 'SKAO private HTTPS 8443' @Parameters
        New-NetFirewallRule -Name 'two' -DisplayName 'SKAO private HTTPS 8443' @Parameters
        Assert-Throws { Run-Lan } 'Multiple SKAO HTTPS'
        Assert ((ReadSettings).PILOT_HOST -eq 'localhost') 'Changed settings.'
    }
    Test 'Missing release image leaves firewall and settings unchanged' {
        $script:FailImage = $true
        Assert-Throws { Run-Lan } 'missing release image'
        Assert ($script:Rules.Count -eq 0 -and (ReadSettings).PILOT_HOST -eq 'localhost') 'Mutated before preflight.'
    }
    Test 'Invalid Compose configuration leaves firewall and settings unchanged' {
        $script:FailConfig = $true
        Assert-Throws { Run-Lan } 'config failure'
        Assert ($script:Rules.Count -eq 0 -and (ReadSettings).PILOT_HOST -eq 'localhost') 'Mutated before validation.'
    }
    Test 'Failed partial firewall creation is removed without starting containers' {
        $script:FailFirewallOnce = $true
        Assert-Throws { Run-Lan } 'Previous settings and firewall restored'
        Assert ($script:Rules.Count -eq 0) 'Left a partial rule.'
        Assert (@($script:Calls | Where-Object { $_.Program -eq 'compose' -and $_.Arguments[0] -eq 'up' }).Count -eq 0) 'Started containers after firewall failure.'
    }
    Test 'Container health failure restores original configuration' {
        $script:FailUp = $true
        Assert-Throws { Run-Lan } 'Previous settings and firewall restored'
        Assert ((ReadSettings).PILOT_HOST -eq 'localhost' -and $script:Rules.Count -eq 0) 'Rollback incomplete.'
        Assert-Preserved
        Assert (!(Test-Path -LiteralPath (Join-Path $Private 'lan-candidate.env'))) 'Left candidate settings.'
    }
    Test 'TLS failure restores settings and the prior firewall filters' {
        $Parameters = Get-PilotFirewallParameters (New-Address '127.0.0.1' 'Any')
        New-NetFirewallRule -Name 'legacy-guid' -DisplayName 'SKAO private HTTPS 8443' @Parameters
        $script:FailHttps = $true
        Assert-Throws { Run-Lan } 'Previous settings and firewall restored'
        Assert (($script:Rules['legacy-guid'].LocalAddress -join ',') -eq '127.0.0.1') 'Lost previous firewall address.'
        Assert ((ReadSettings).PILOT_HOST -eq 'localhost') 'Lost previous HTTPS hostname.'
        Assert-Preserved
    }
    Test 'Unexpected broad Docker publication triggers rollback' {
        $script:BadPorts = $true
        Assert-Throws { Run-Lan } 'Unexpected pilot port publication'
        Assert ((ReadSettings).PILOT_BIND -eq '127.0.0.1') 'Kept broad publication settings.'
    }
    Test 'Separate database port publication triggers rollback' {
        $script:BadDatabasePort = $true
        Assert-Throws { Run-Lan } 'Unexpected pilot port publication'
        Assert ((ReadSettings).PILOT_BIND -eq '127.0.0.1') 'Kept invalid publication settings.'
    }
    Test 'Rollback container failure is reported explicitly' {
        $script:FailUp = $true; $script:FailRollback = $true
        Assert-Throws { Run-Lan } 'Rollback needs attention: previous containers'
        Assert ((ReadSettings).PILOT_HOST -eq 'localhost') 'Did not restore settings file.'
    }
    Test 'Rollback firewall failure still restores settings and tries old containers' {
        $Parameters = Get-PilotFirewallParameters (New-Address '127.0.0.1' 'Any')
        New-NetFirewallRule -Name 'legacy-guid' -DisplayName 'SKAO private HTTPS 8443' @Parameters
        $script:FailHttps = $true; $script:FailFirewallRestore = $true
        Assert-Throws { Run-Lan } 'Rollback needs attention: firewall'
        Assert ((ReadSettings).PILOT_HOST -eq 'localhost') 'Did not restore settings independently.'
        Assert (@($script:Calls | Where-Object { $_.Program -eq 'compose' -and $_.Arguments[0] -eq 'up' }).Count -eq 2) 'Did not try previous containers.'
    }
    Test 'Settings restore failure stops the app instead of restarting the wrong configuration' {
        $script:FailHttps = $true; $script:FailSettingsRestore = $true
        Assert-Throws { Run-Lan } 'Rollback needs attention: settings'
        Assert (@($script:Calls | Where-Object { $_.Program -eq 'compose' -and ($_.Arguments -join ' ') -eq 'stop web server' }).Count -eq 1) 'Did not stop the app.'
        Assert (@($script:Calls | Where-Object { $_.Program -eq 'compose' -and $_.Arguments[0] -eq 'up' }).Count -eq 1) 'Restarted un-restored settings.'
    }
    Test 'HTTPS probe verifies local CA, ignores proxies and avoids data endpoints' {
        Run-Lan
        $Curl = @($script:Calls | Where-Object { $_.Program -eq 'curl.exe' })[0].Arguments
        Assert ($Curl[0] -eq '--disable' -and $Curl -contains '--cacert' -and $Curl -contains '--noproxy') 'Probe misses trust/proxy policy.'
        Assert ($Curl -notcontains '--insecure' -and $Curl[-1] -eq 'https://192.168.50.20:8443/api/ready') 'Unsafe TLS probe.'
    }
    Test 'Certificate export contains only a public CA with a matching fingerprint' {
        Run-Lan
        $Path = Join-Path $Private 'phone/academy-root.cer'
        $CA = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Path)
        try { Assert (!$CA.HasPrivateKey) 'Exported a key.' } finally { $CA.Dispose() }
        $ExpectedHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
        $Details = (Get-Content -LiteralPath (Join-Path $Private 'phone/PHONE.txt') -Raw).Replace(':','')
        Assert ($Details.Contains($ExpectedHash)) 'Fingerprint does not match the export.'
        Assert (@(Get-ChildItem -LiteralPath (Join-Path $Private 'phone')).Count -eq 2) 'Unexpected phone export contents.'
    }
    Test 'Private-key text is refused by certificate export' {
        $Values = ReadSettings; $Values.PILOT_BIND = '192.168.50.20'; $Values.PILOT_HOST = '192.168.50.20'
        $script:PrivateKeyExport = $true
        Assert-Throws { Export-PilotPhoneCertificate $Values } 'not a single public certificate'
        Assert (!(Test-Path -LiteralPath (Join-Path $Private 'phone'))) 'Prepared invalid phone files.'
    }
    Test 'Certificate command refuses a localhost phone URL' {
        Assert-Throws { Export-PilotPhoneCertificate (ReadSettings) } 'Run setup-phone first'
    }
    Test 'Export failure leaves a healthy LAN setup available for a certificate retry' {
        $script:PrivateKeyExport = $true
        Assert-Throws { Run-Lan } 'not a single public certificate'
        Assert ((ReadSettings).PILOT_BIND -eq '192.168.50.20') 'Undid healthy LAN settings.'
        Assert ($script:Rules.Count -eq 1) 'Undid healthy firewall rule.'
    }
    Test 'Doctor passes healthy setup and makes no service/firewall changes' {
        Run-Lan; $script:Calls.Clear()
        Test-PilotDoctor (ReadSettings)
        Assert (@($script:Calls | Where-Object { $_.Program -like 'firewall-*' -or $_.Arguments[0] -in @('up','stop','down','build') }).Count -eq 0) 'Doctor changed a running service.'
    }
    Test 'Doctor reports stale addresses and does not fix them silently' {
        Run-Lan; $script:Addresses = @((New-Address '192.168.50.99'))
        Assert-Throws { Test-PilotDoctor (ReadSettings) } 'diagnostic check'
        Assert ((ReadSettings).PILOT_BIND -eq '192.168.50.20') 'Doctor silently changed settings.'
    }
    Test 'Doctor reports a missing web container' {
        Run-Lan; $script:MissingWeb = $true
        Assert-Throws { Test-PilotDoctor (ReadSettings) } 'diagnostic check'
    }
    Test 'Update refuses uncommitted work before pulling' {
        $script:Dirty = $true
        Assert-Throws { Update-SkaoCheckout } 'local changes'
        Assert (@($script:Calls | Where-Object { $_.Arguments[0] -eq 'pull' }).Count -eq 0) 'Pulled over local work.'
    }
    Test 'Update does not pull while another pilot operation holds the lock' {
        $Operation = [System.IO.File]::Open((Join-Path $Private 'operation.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
        try { Assert-Throws { Update-SkaoCheckout } 'used by another process' }
        finally { $Operation.Dispose() }
        Assert ($script:Calls.Count -eq 0) 'Ran Git during another operation.'
    }
    Test 'Update refuses feature branches and detached checkouts' {
        foreach ($Name in @('feature/unfinished','')) { $script:Branch = $Name; Assert-Throws { Update-SkaoCheckout } 'feature review/merge' }
    }
    Test 'Update refuses unexpected upstreams' {
        $script:Upstream = 'another/development'
        Assert-Throws { Update-SkaoCheckout } 'Expected this checkout to track'
    }
    Test 'Update fetches the selected release branch by fast-forward only' {
        Update-SkaoCheckout
        $Pull = @($script:Calls | Where-Object { $_.Arguments[0] -eq 'pull' })
        Assert ($Pull.Count -eq 1 -and ($Pull[0].Arguments -join ' ') -ceq 'pull --ff-only --no-rebase origin development') 'Unsafe update arguments.'
    }
    Test 'Update propagates a diverged branch error' {
        $script:FailPull = $true
        Assert-Throws { Update-SkaoCheckout } 'diverged branch'
    }
    Test 'Repeating update for the active commit verifies health without cloning the database' {
        $Switch = $Ast.Find({ param($Node) $Node -is [System.Management.Automation.Language.SwitchStatementAst] }, $true)
        $Action = 'update'; $State = ReadSettings
        & ([scriptblock]::Create($Switch.Extent.Text))
        $Operations = @($script:Calls | Where-Object { $_.Program -eq 'compose' })
        Assert ($Operations.Count -eq 1 -and ($Operations[0].Arguments -join ' ') -eq 'up -d --no-build --wait --wait-timeout 180 db server web') 'Repeated a database update.'
        Assert-Preserved
    }
    Test 'Launcher forwards restart and the child failure code' {
        $script:ChildExit = 7
        Assert ((Invoke-SkaoAction 'restart') -eq 7) 'Lost child exit code.'
        Assert ($script:Calls.Count -eq 1 -and $script:Calls[0].Arguments[0] -match '^\-NoProfile -File "[^"]+pilot\.ps1" restart$') 'Ran another action or lost path quoting.'
    }
    Test 'Launcher requests UAC only for setup and propagates its exit code' {
        $script:Admin = $false; $script:ChildExit = 5
        Assert ((Invoke-SkaoAction 'setup-phone') -eq 5) 'Lost elevated exit code.'
        Assert ($script:Calls.Count -eq 1 -and $script:Calls[0].Program -eq 'elevate' -and $script:Calls[0].Arguments[-1] -eq 'RunAs') 'Missing elevation.'
        Assert ($script:Calls[0].Arguments[1] -notmatch 'ExecutionPolicy') 'Changed execution policy.'
    }
    Test 'Launcher does not deploy after a failed update pull' {
        $script:FailPull = $true
        Assert-Throws { Invoke-SkaoAction 'update' } 'diverged branch'
        Assert (@($script:Calls | Where-Object { $_.Program -eq 'powershell.exe' }).Count -eq 0) 'Deployed after Git failure.'
    }
} finally {
    if (Test-Path -LiteralPath $TestRoot) { Remove-Item -LiteralPath $TestRoot -Recurse -Force }
}
Write-Host "`n$Passed passed; $Failed failed. Docker/Windows/phone integration still needs a real host."
if ($Failed) { exit 1 }
exit 0
