# Loaded by pilot.ps1. These functions use its Compose/Native/settings helpers.
# Keep compatible with Windows PowerShell 5.1. No network or service changes on load.
function Test-PilotPrivateIPv4([string]$Address) {
    $Parsed = $null
    if ($Address -notmatch '^([0-9]{1,3}\.){3}[0-9]{1,3}$' -or
        ![System.Net.IPAddress]::TryParse($Address, [ref]$Parsed) -or $Parsed.ToString() -cne $Address) { return $false }
    $Octets = $Parsed.GetAddressBytes()
    return $Octets[0] -eq 10 -or ($Octets[0] -eq 192 -and $Octets[1] -eq 168) -or
        ($Octets[0] -eq 172 -and $Octets[1] -ge 16 -and $Octets[1] -le 31)
}

function Get-PilotLanAddresses {
    # Without -All, Windows returns connected, non-virtual interfaces only.
    foreach ($Configuration in @(Get-NetIPConfiguration -ErrorAction Stop)) {
        if ($null -eq $Configuration.NetProfile) { continue }
        foreach ($Address in @(Get-NetIPAddress -InterfaceIndex $Configuration.InterfaceIndex -AddressFamily IPv4 -AddressState Preferred -ErrorAction Stop)) {
            if (!(Test-PilotPrivateIPv4 $Address.IPAddress) -or $Address.SkipAsSource) { continue }
            [pscustomobject]@{
                IPAddress = $Address.IPAddress
                InterfaceAlias = $Configuration.InterfaceAlias
                NetworkCategory = [string]$Configuration.NetProfile.NetworkCategory
            }
        }
    }
}

function Select-PilotLanAddress([string]$RequestedAddress, [string]$InterfaceAlias, [string]$CurrentAddress) {
    $Candidates = @(Get-PilotLanAddresses | Where-Object {
        $_.NetworkCategory -eq 'Private' -and
        (!$RequestedAddress -or $_.IPAddress -eq $RequestedAddress) -and
        (!$InterfaceAlias -or $_.InterfaceAlias -eq $InterfaceAlias)
    })
    if (!$Candidates.Count) {
        throw 'No matching private LAN address is available. Connect Windows to the trusted local network and set that network to Private in Windows Settings, then rerun setup-phone. Public, VPN/virtual and loopback addresses are not selected.'
    }
    if ($Candidates.Count -eq 1) { return $Candidates[0] }
    $Current = @($Candidates | Where-Object { $_.IPAddress -eq $CurrentAddress })
    if ($Current.Count -eq 1) { return $Current[0] }
    if ([Console]::IsInputRedirected) { throw 'More than one private LAN address is available. Run pilot.ps1 lan -BindAddress YOUR_WINDOWS_LAN_IP (optionally -InterfaceAlias YOUR_ADAPTER).' }
    for ($Index = 0; $Index -lt $Candidates.Count; $Index++) {
        Write-Host "$($Index + 1). $($Candidates[$Index].InterfaceAlias) - $($Candidates[$Index].IPAddress)"
    }
    $Choice = 0
    $Answer = Read-Host 'Choose the network your phone uses (number)'
    if (![int]::TryParse($Answer, [ref]$Choice) -or $Choice -lt 1 -or $Choice -gt $Candidates.Count) { throw 'No network selected. Settings were not changed.' }
    return $Candidates[$Choice - 1]
}

function Assert-PilotAdministrator {
    $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = New-Object System.Security.Principal.WindowsPrincipal($Identity)
    if (!$Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Use SKAO.cmd setup-phone (it requests Windows administrator access), or run this command in an elevated PowerShell window as the pilot owner.'
    }
}

function Assert-PilotFirewallEnabled {
    $FirewallProfile = Get-NetFirewallProfile -PolicyStore ActiveStore -Name Private -ErrorAction Stop
    if ([string]$FirewallProfile.Enabled -ne 'True' -or [string]$FirewallProfile.DefaultInboundAction -eq 'Allow' -or
        [string]$FirewallProfile.AllowInboundRules -eq 'False') {
        throw 'The Private firewall must be enabled, block unsolicited inbound connections, and permit local allow rules. Review the Windows firewall policy before continuing.'
    }
}

function Get-PilotFirewallSnapshot {
    $Rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object {
        $_.Name -eq 'SKAO-Pilot-HTTPS-8443' -or $_.DisplayName -eq 'SKAO private HTTPS 8443'
    })
    if ($Rules.Count -gt 1) { throw 'Multiple SKAO HTTPS firewall rules exist. Review the duplicates in Windows Firewall before setup-phone can safely manage one rule.' }
    if (!$Rules.Count) { return @{ Exists = $false; Name = 'SKAO-Pilot-HTTPS-8443'; Parameters = @{} } }
    $Rule = $Rules[0]
    $Port = $Rule | Get-NetFirewallPortFilter -ErrorAction Stop
    $Address = $Rule | Get-NetFirewallAddressFilter -ErrorAction Stop
    $Interface = $Rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop
    return @{ Exists = $true; Name = $Rule.Name; Parameters = @{
        Direction = [string]$Rule.Direction; Action = [string]$Rule.Action; Enabled = [string]$Rule.Enabled
        Profile = [string]$Rule.Profile; EdgeTraversalPolicy = [string]$Rule.EdgeTraversalPolicy
        Protocol = [string]$Port.Protocol; LocalPort = @($Port.LocalPort); RemotePort = @($Port.RemotePort)
        LocalAddress = @($Address.LocalAddress); RemoteAddress = @($Address.RemoteAddress)
        InterfaceAlias = @($Interface.InterfaceAlias)
    } }
}

function Get-PilotFirewallParameters($Target) {
    return @{
        Direction = 'Inbound'; Action = 'Allow'; Enabled = 'True'; Protocol = 'TCP'
        LocalPort = '8443'; RemotePort = 'Any'; LocalAddress = $Target.IPAddress
        RemoteAddress = 'LocalSubnet'; Profile = 'Private'; EdgeTraversalPolicy = 'Block'
        # InterfaceAlias takes wildcard patterns; escape literal adapter names.
        InterfaceAlias = [System.Management.Automation.WildcardPattern]::Escape($Target.InterfaceAlias)
    }
}

function Set-PilotFirewall($Target, [hashtable]$Snapshot) {
    $Parameters = Get-PilotFirewallParameters $Target
    if ($Snapshot.Exists) {
        Set-NetFirewallRule -PolicyStore PersistentStore -Name $Snapshot.Name @Parameters -ErrorAction Stop | Out-Null
    } else {
        New-NetFirewallRule -PolicyStore PersistentStore -Name $Snapshot.Name -DisplayName 'SKAO private HTTPS 8443' @Parameters -ErrorAction Stop | Out-Null
    }
}

function Restore-PilotFirewall([hashtable]$Snapshot) {
    if ($Snapshot.Exists) {
        $Parameters = $Snapshot.Parameters
        Set-NetFirewallRule -PolicyStore PersistentStore -Name $Snapshot.Name @Parameters -ErrorAction Stop | Out-Null
    } else {
        # Only remove the rule this operation could have created; unrelated rules stay intact.
        $Rule = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object { $_.Name -eq $Snapshot.Name })
        if ($Rule.Count) { Remove-NetFirewallRule -PolicyStore PersistentStore -Name $Snapshot.Name -ErrorAction Stop }
    }
}

function Assert-PilotFirewall($Target) {
    Assert-PilotFirewallEnabled
    $Snapshot = Get-PilotFirewallSnapshot
    if (!$Snapshot.Exists) { throw 'The SKAO firewall rule is missing. Run setup-phone.' }
    $Expected = Get-PilotFirewallParameters $Target
    foreach ($Key in $Expected.Keys) {
        if (($Snapshot.Parameters[$Key] -join ',') -ine ($Expected[$Key] -join ',')) {
            throw "The SKAO firewall rule needs repair ($Key). Run setup-phone."
        }
    }
}

function Assert-PilotPublishedPorts([hashtable]$Values) {
    $Published = @()
    foreach ($Service in @('web','server','db')) {
        $Container = [string](Compose @('ps','-q',$Service))
        if (!$Container) { throw "$Service is not running. Run start, then doctor." }
        $Ports = ((Native 'docker' @('inspect','--format','{{json .NetworkSettings.Ports}}',$Container)) -join "`n") | ConvertFrom-Json
        if ($null -eq $Ports) { continue }
        foreach ($Property in $Ports.PSObject.Properties) {
            foreach ($Binding in @($Property.Value)) {
                if ($null -ne $Binding) {
                    $Published += [pscustomobject]@{ Service = $Service; Port = $Property.Name; HostIp = $Binding.HostIp; HostPort = $Binding.HostPort }
                }
            }
        }
    }
    if ($Published.Count -ne 1 -or $Published[0].Service -ne 'web' -or $Published[0].Port -ne '8443/tcp' -or
        $Published[0].HostIp -ne $Values.PILOT_BIND -or $Published[0].HostPort -ne '8443') {
        throw 'Unexpected pilot port publication. Expected only web HTTPS 8443 on the saved Windows address; inspect Docker configuration.'
    }
}

function Assert-PilotHttps([hashtable]$Values) {
    # curl.exe avoids the PowerShell 5.1 curl alias. Ignore curlrc and proxy settings.
    # Verify both the hostname and local CA; never use --insecure or follow redirects.
    CopyCertificate
    $Code = [string](Native 'curl.exe' @('--disable','--noproxy','*','--silent','--show-error','--fail',
        '--connect-timeout','5','--max-time','20','--cacert',(Join-Path $Private 'root.crt'),
        '--output','NUL','--write-out','%{http_code}',"https://$($Values.PILOT_HOST):8443/api/ready"))
    if ($Code -ne '200') { throw "HTTPS readiness returned $Code. Check the URL, Docker health and certificate." }
}

function Export-PilotPhoneCertificate([hashtable]$Values) {
    if (!(Test-PilotPrivateIPv4 $Values.PILOT_BIND) -or $Values.PILOT_HOST -eq 'localhost') {
        throw 'Run setup-phone first so the exported phone details contain a LAN address.'
    }
    CopyCertificate
    $Source = Join-Path $Private 'root.crt'
    $Pem = [System.IO.File]::ReadAllText($Source)
    if ($Pem -notmatch '\A\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*\z') {
        throw 'The exported file is not a single public certificate. Nothing was prepared for the phone.'
    }
    $Certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Source)
    try {
        $Constraints = @($Certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
        if ($Certificate.HasPrivateKey -or $Constraints.Count -ne 1 -or !$Constraints[0].CertificateAuthority -or
            $Certificate.NotAfter -le (Get-Date) -or $Certificate.NotBefore -gt (Get-Date)) { throw 'The public root CA is invalid or expired.' }
        $Directory = Join-Path $Private 'phone'
        New-Item -ItemType Directory -Path $Directory -Force | Out-Null
        $Destination = Join-Path $Directory 'academy-root.cer'
        [System.IO.File]::WriteAllBytes($Destination, $Certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
        $Hasher = [System.Security.Cryptography.SHA256]::Create()
        try { $Fingerprint = ([BitConverter]::ToString($Hasher.ComputeHash($Certificate.RawData))).Replace('-', ':') }
        finally { $Hasher.Dispose() }
        $Details = @(
            'Smart Kids Academy - phone connection',
            "URL: https://$($Values.PILOT_HOST):8443",
            "Root certificate SHA-256 fingerprint: $Fingerprint",
            '',
            'Transfer academy-root.cer to the authorized phone using a trusted local transfer.',
            'Install it as a CA/root certificate, not a Wi-Fi or client identity certificate.',
            'Compare its SHA-256 fingerprint with the Windows output before trusting it.',
            'iPhone/iPad: after installing the profile, enable its SSL trust in Settings > General > About > Certificate Trust Settings.',
            'Android: use Settings > Security > Encryption & credentials > Install a certificate > CA certificate (wording varies).',
            'Keep the phone on the same local Wi-Fi; guest Wi-Fi may block local devices.',
            'The Windows computer must be awake with Docker running.',
            'https://support.apple.com/en-us/102390',
            'https://support.google.com/pixelphone/answer/2844832'
        )
        [System.IO.File]::WriteAllText((Join-Path $Directory 'PHONE.txt'), ($Details -join "`r`n") + "`r`n", $Utf8)
        Write-Host "Phone URL: https://$($Values.PILOT_HOST):8443"
        Write-Host "Public certificate: $Destination"
        Write-Host "SHA-256 fingerprint: $Fingerprint"
        Write-Host 'The phone needs one-time certificate installation/trust. PHONE.txt contains the device details.'
    } finally { $Certificate.Dispose() }
}

function Set-PilotLan([hashtable]$Values, [string]$RequestedAddress, [string]$InterfaceAlias) {
    Assert-PilotAdministrator
    Get-Command curl.exe -ErrorAction Stop | Out-Null
    $Target = Select-PilotLanAddress $RequestedAddress $InterfaceAlias $Values.PILOT_BIND
    Assert-PilotFirewallEnabled
    $Firewall = Get-PilotFirewallSnapshot
    $Next = $Values.Clone()
    $Next.PILOT_HOST = $Target.IPAddress
    $Next.PILOT_BIND = $Target.IPAddress
    $Candidate = Join-Path $Private 'lan-candidate.env'
    $Previous = Join-Path $Private 'lan-previous.env'
    WriteSettings $Next $Candidate
    try {
        Compose @('config','--quiet') $Candidate
        # Preserve the saved release and all data. This operation never builds or migrates.
        foreach ($Service in @('server','web')) {
            Native 'docker' @('image','inspect','--format','{{.Id}}',"skao-pilot-${Service}:$($Values.PILOT_RELEASE)") | Out-Null
        }
        Copy-Item -LiteralPath $SettingsFile -Destination $Previous -Force
        $SettingsChanged = $false
        try {
            Set-PilotFirewall $Target $Firewall
            WriteSettings $Next
            $SettingsChanged = $true
            Compose @('up','-d','--no-build','--wait','--wait-timeout','180','db','server','web')
            Assert-PilotPublishedPorts $Next
            Assert-PilotFirewall $Target
            Assert-PilotHttps $Next
        } catch {
            $Failure = $_.Exception.Message
            $RollbackErrors = @()
            $SettingsRestored = $true
            # Restore settings and firewall independently, so one failed restore does not skip the other.
            try { if ($SettingsChanged) { Copy-Item -LiteralPath $Previous -Destination $SettingsFile -Force } }
            catch { $SettingsRestored = $false; $RollbackErrors += "settings: $($_.Exception.Message)" }
            try { Restore-PilotFirewall $Firewall }
            catch { $RollbackErrors += "firewall: $($_.Exception.Message)" }
            if ($SettingsChanged) {
                try {
                    if ($SettingsRestored) { Compose @('up','-d','--no-build','--wait','--wait-timeout','180','db','server','web') }
                    else { Compose @('stop','web','server') }
                }
                catch { $RollbackErrors += "previous containers: $($_.Exception.Message)" }
            }
            if ($RollbackErrors.Count) {
                throw "Phone setup failed: $Failure. Rollback needs attention: $($RollbackErrors -join '; '). Previous settings are in .pilot/lan-previous.env. Run doctor; preserve .pilot and all volumes."
            }
            throw "Phone setup failed: $Failure. Previous settings and firewall restored; no database migration or reset was performed."
        }
    } finally {
        if (Test-Path -LiteralPath $Candidate) { Remove-Item -LiteralPath $Candidate }
    }
    Write-Host "Phone access is configured on $($Target.InterfaceAlias). Repeat setup-phone to repair it or adapt to an address change."
    # Export failure does not undo an already healthy LAN configuration; certificate can be retried alone.
    Export-PilotPhoneCertificate $Next
}

function Test-PilotDoctor([hashtable]$Values) {
    Write-Host "Pilot URL: https://$($Values.PILOT_HOST):8443 | Release: $($Values.PILOT_RELEASE)"
    Get-PilotLanAddresses | Format-Table InterfaceAlias, IPAddress, NetworkCategory | Out-Host
    Compose @('ps','--all')
    $Failures = 0
    $Checks = [ordered]@{
        'Private LAN and firewall' = {
            $Target = Select-PilotLanAddress -RequestedAddress $Values.PILOT_BIND
            Assert-PilotFirewall $Target
        }
        'Only pilot HTTPS is published' = { Assert-PilotPublishedPorts $Values }
        'HTTPS hostname, CA and API readiness' = { Assert-PilotHttps $Values }
    }
    foreach ($Label in $Checks.Keys) {
        try { & $Checks[$Label]; Write-Host "PASS: $Label" }
        catch { $Failures++; Write-Host "FAIL: $Label - $($_.Exception.Message)" }
    }
    if ($Failures) { throw "$Failures diagnostic check(s) failed. No service or firewall settings were changed." }
    Write-Host 'Computer checks passed. Phone connectivity, phone certificate trust and sign-in still need checking on the phone.'
}
