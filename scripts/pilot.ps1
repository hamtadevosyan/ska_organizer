# Windows PowerShell 5.1 or PowerShell 7. Run from a clean, tested Git checkout.
[CmdletBinding()]
param(
    [Parameter(Position=0, Mandatory=$true)]
    [ValidateSet('init','resume-install','start','stop','restart','status','logs','admin','trust','backup','verify','recover','import','update','schedule','firewall')]
    [string]$Action,
    [string]$PilotHost = 'localhost',
    [string]$BindAddress = '127.0.0.1',
    [string]$TimeZone = 'America/Los_Angeles',
    [string]$BackupDirectory,
    [string]$BackupName,
    [string]$ImportFile,
    [string]$ConfirmDatabase
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Private = Join-Path $Repo '.pilot'
$SettingsFile = Join-Path $Private 'runtime.env'
$InstallingFile = Join-Path $Private 'installing'
$ComposeFile = Join-Path $Repo 'compose.pilot.yaml'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Lock = $null

function Native([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE). Later steps were not run." }
}
function Compose([string[]]$Arguments, [string]$ConfigFile = $SettingsFile) {
    Native 'docker' (@('compose', '--project-directory', $Repo, '--env-file', $ConfigFile, '-f', $ComposeFile) + $Arguments)
}
function PrivateDirectory([string]$Directory) {
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    $Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    # Called only for new/empty installation directories; discard explicit old ACLs.
    Native 'icacls.exe' @($Directory, '/reset') | Out-Null
    Native 'icacls.exe' @($Directory, '/inheritance:r', '/grant:r', "*$($Sid):(OI)(CI)F", '*S-1-5-18:(OI)(CI)F') | Out-Null
}
function WriteSettings([hashtable]$Values, [string]$Destination = $SettingsFile) {
    $Lines = foreach ($Key in ($Values.Keys | Sort-Object)) {
        $Value = [string]$Values[$Key]
        if ($Value -match "['`r`n]" -or $Key -notmatch '^[A-Z_]+$') { throw 'Invalid pilot setting.' }
        "$Key='$Value'"
    }
    $Temporary = "$Destination.tmp"
    [System.IO.File]::WriteAllText($Temporary, ($Lines -join "`n") + "`n", $Utf8)
    Move-Item -LiteralPath $Temporary -Destination $Destination -Force
}
function ReadSettings {
    if (!(Test-Path -LiteralPath $SettingsFile)) { throw 'Run init first, or restore the original .pilot settings and secrets.' }
    $Result = @{}
    foreach ($Line in [System.IO.File]::ReadAllLines($SettingsFile)) {
        if ($Line -notmatch "^([A-Z_]+)='([^']*)'$") { throw 'Invalid .pilot/runtime.env format.' }
        $Result[$Matches[1]] = $Matches[2]
    }
    foreach ($Key in @('PILOT_HOST','PILOT_BIND','PILOT_DATABASE','PILOT_RELEASE','PILOT_BACKUP_DIR','FACILITY_TIME_ZONE')) {
        if (!$Result.ContainsKey($Key) -or !$Result[$Key]) { throw "Missing pilot setting: $Key" }
    }
    if ($Result.PILOT_RELEASE -notmatch '^[a-f0-9]{40}$' -or $Result.PILOT_DATABASE -notmatch '^(ska_organizer|skao_recovery_[a-f0-9]{24})$') {
        throw 'Invalid pilot release or database name.'
    }
    return $Result
}
function GitRelease {
    $Dirty = @(Native 'git' @('-C', $Repo, 'status', '--porcelain', '--untracked-files=all'))
    if ($Dirty.Count -gt 0) { throw 'Commit or move your local changes before building a release. Do not add .pilot or backups to Git.' }
    $Commit = [string](Native 'git' @('-C', $Repo, 'rev-parse', 'HEAD'))
    if ($Commit -notmatch '^[a-f0-9]{40}$') { throw 'Could not identify the Git release.' }
    return $Commit
}
function NewPassword {
    $Bytes = New-Object byte[] 32
    $Generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $Generator.GetBytes($Bytes) } finally { $Generator.Dispose() }
    return ([BitConverter]::ToString($Bytes)).Replace('-', '').ToLowerInvariant()
}
function Tools([string[]]$Arguments, [string]$Database = '') {
    $Run = @('--profile','operations','run','--rm','--no-deps','-T')
    if ($Database) { $Run += @('-e', "PGDATABASE=$Database") }
    $Output = @(Compose ($Run + @('tools') + $Arguments))
    try { return (($Output -join "`n") | ConvertFrom-Json) }
    catch { throw 'The data tool did not return a valid result. Inspect the operation before retrying.' }
}
function ShowData($Result) { $Result | ConvertTo-Json -Depth 8 | Write-Output }
function ConfirmSwitch([hashtable]$Values) {
    Write-Host "Current database: $($Values.PILOT_DATABASE). It will be retained. Users must sign in again after recovery."
    $Answer = $ConfirmDatabase
    if (!$Answer) { $Answer = Read-Host 'Type the current database name to switch to the recovered copy' }
    if ($Answer -cne $Values.PILOT_DATABASE) { throw 'Confirmation did not match. The active database was not changed.' }
}
function RequireImages([string]$Release) {
    foreach ($Service in @('server','web','tools')) {
        Native 'docker' @('image', 'inspect', '--format', '{{.Id}}', "skao-pilot-${Service}:$Release") | Out-Null
    }
}
function Migrate([string]$ConfigFile = $SettingsFile, [string]$Database = '') {
    $Run = @('run','--rm','--no-deps','-T')
    if ($Database) { $Run += @('-e', "DATABASE_NAME=$Database") }
    Compose ($Run + @('server','node','scripts/database.js','migrate')) $ConfigFile
}
function Activate([hashtable]$Values) {
    Copy-Item -LiteralPath $SettingsFile -Destination (Join-Path $Private 'previous.env') -Force
    WriteSettings $Values
    try { Compose @('up','-d','--no-build','--wait','--wait-timeout','180','server','web') }
    catch {
        Compose @('stop','server')
        throw 'The selected release did not become healthy. The application is stopped; both databases are retained. Follow backup-recovery.md before changing the release again.'
    }
}
function CopyCertificate {
    $Container = [string](Compose @('ps','-q','web'))
    if (!$Container) { throw 'Start the web container before exporting its certificate.' }
    Native 'docker' @('cp', "${Container}:/data/caddy/pki/authorities/local/root.crt", (Join-Path $Private 'root.crt'))
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'Use this helper in Windows PowerShell on the Docker Desktop host. Ubuntu remains your development environment.' }
    Get-Command docker -ErrorAction Stop | Out-Null
    Native 'docker' @('info','--format','{{.OSType}}') | Out-Null
    Native 'docker' @('compose','version') | Out-Null
    if ($Action -eq 'init') {
        if (Test-Path -LiteralPath $Private) { throw '.pilot already exists. Use start, or follow the recovery guide; init never replaces secrets.' }
        if ($PilotHost -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$' -or $PilotHost.Contains('..')) { throw 'Choose localhost, a private DNS hostname or an IPv4 address, without a scheme or port.' }
        $ParsedAddress = $null
        if (![System.Net.IPAddress]::TryParse($BindAddress, [ref]$ParsedAddress) -or $ParsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'BindAddress must be an IPv4 address.' }
        $Octets = $ParsedAddress.GetAddressBytes()
        $PrivateAddress = $Octets[0] -eq 10 -or ($Octets[0] -eq 192 -and $Octets[1] -eq 168) -or ($Octets[0] -eq 172 -and $Octets[1] -ge 16 -and $Octets[1] -le 31)
        if ($BindAddress -ne '127.0.0.1' -and !$PrivateAddress) { throw 'Bind to loopback or the Windows host private LAN IPv4 address.' }
        if ($PilotHost -eq 'localhost' -and $BindAddress -ne '127.0.0.1') { throw 'For LAN access, use a hostname/IP that other devices can resolve to the Windows host.' }
        if ($TimeZone -notmatch '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$') { throw 'Use an IANA time zone, for example America/Los_Angeles.' }
        $Commit = GitRelease
        $Volumes = @(Native 'docker' @('volume','ls','--format','{{.Name}}'))
        if ($Volumes -contains 'skao_pilot_database') { throw 'The pilot database already exists. Restore its matching settings and secrets; do not initialize another password.' }
        if (!$BackupDirectory) { $BackupDirectory = Join-Path $env:LOCALAPPDATA 'SKAO\backups' }
        $BackupDirectory = [System.IO.Path]::GetFullPath($BackupDirectory)
        foreach ($UnsafeDirectory in @([System.IO.Path]::GetPathRoot($BackupDirectory), $env:USERPROFILE, $Repo, $Private)) {
            if ($BackupDirectory.TrimEnd('\') -ieq $UnsafeDirectory.TrimEnd('\')) { throw 'Choose a dedicated backup subdirectory, not a drive root, profile or repository.' }
        }
        if (Test-Path -LiteralPath $BackupDirectory) {
            if (@(Get-ChildItem -LiteralPath $BackupDirectory -Force).Count -gt 0) { throw 'For a new pilot, choose a new empty dedicated backup directory.' }
        }
        PrivateDirectory $Private
        PrivateDirectory (Join-Path $Private 'secrets')
        PrivateDirectory $BackupDirectory
        foreach ($Name in @('db-admin-password','app-password')) {
            [System.IO.File]::WriteAllText((Join-Path $Private "secrets\$Name"), (NewPassword), $Utf8)
        }
        $State = @{ PILOT_HOST=$PilotHost.ToLowerInvariant(); PILOT_BIND=$BindAddress; FACILITY_TIME_ZONE=$TimeZone;
            PILOT_RELEASE=$Commit; PILOT_DATABASE='ska_organizer'; PILOT_BACKUP_DIR=$BackupDirectory.Replace('\','/') }
        WriteSettings $State
        [System.IO.File]::WriteAllText($InstallingFile, $Commit, $Utf8)
    } else { $State = ReadSettings }
    $Lock = [System.IO.File]::Open((Join-Path $Private 'operation.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    Compose @('config','--quiet')
    if ($Action -eq 'resume-install') {
        if (!(Test-Path -LiteralPath $InstallingFile)) { throw 'No incomplete installation is recorded. Use update for an existing pilot.' }
        if ((GitRelease) -ne $State.PILOT_RELEASE) { throw 'Return to the recorded installation commit before resuming.' }
        Compose @('stop','server')
    }
    if ($Action -notin @('init','resume-install','status','logs','stop') -and (Test-Path -LiteralPath $InstallingFile)) {
        throw 'The initial installation is incomplete. Fix the reported error and use resume-install.'
    }
    switch ($Action) {
        { $_ -in @('init','resume-install') } {
            Compose @('--profile','operations','build','server','web','tools')
            Compose @('up','-d','--wait','--wait-timeout','120','db')
            Migrate
            Compose @('up','-d','--no-build','--wait','--wait-timeout','180','server','web')
            CopyCertificate
            Remove-Item -LiteralPath $InstallingFile
            Write-Host "Installed at https://$($State.PILOT_HOST):8443. Next run trust and admin. No accounts or sample records were added."
        }
        'start' { Compose @('up','-d','--no-build','--wait','--wait-timeout','180','db','server','web') }
        'stop' { Compose @('stop','web','server','db') }
        'restart' {
            Compose @('stop','web','server','db')
            Compose @('up','-d','--no-build','--wait','--wait-timeout','180','db','server','web')
        }
        'status' {
            Compose @('ps')
            Write-Host "Release: $($State.PILOT_RELEASE) | Database: $($State.PILOT_DATABASE) | https://$($State.PILOT_HOST):8443"
            Get-ChildItem -LiteralPath $State.PILOT_BACKUP_DIR -Directory -Filter 'backup-*' | Sort-Object Name -Descending | Select-Object -First 5 Name
        }
        'logs' { Compose @('logs','--tail','100','server','web','db') }
        'admin' { Compose @('exec','server','node','scripts/create-admin.js') }
        'trust' {
            CopyCertificate
            $Certificate = Join-Path $Private 'root.crt'
            Get-FileHash -Algorithm SHA256 -LiteralPath $Certificate | Format-List
            Import-Certificate -FilePath $Certificate -CertStoreLocation 'Cert:\CurrentUser\Root' | Select-Object Subject, Thumbprint
            Write-Host 'The local pilot CA is trusted for this Windows user. Restart Chrome. Install only root.crt on other authorized devices; never share its private key.'
        }
        'backup' { ShowData (Tools @('backup')) }
        'verify' {
            if (!$BackupName) { throw 'Use verify -BackupName backup-NAME.' }
            ShowData (Tools @('verify', $BackupName))
        }
        'recover' {
            if (!$BackupName) { throw 'Use recover -BackupName backup-NAME.' }
            $Manifest = Tools @('inspect', $BackupName)
            RequireImages $Manifest.release
            ConfirmSwitch $State
            # Pause writes before the safety backup. On any error keep the API stopped.
            Compose @('stop','server')
            $Safety = Tools @('backup')
            Write-Host "Safety backup: $($Safety.backup)"
            $Recovered = Tools @('restore', $BackupName)
            $Next = $State.Clone(); $Next.PILOT_DATABASE=$Recovered.database; $Next.PILOT_RELEASE=$Recovered.release
            Activate $Next
            ShowData $Recovered
            Write-Host 'Reconcile the recovered records before letting staff return. The prior database is still retained.'
        }
        'import' {
            if (!$ImportFile -or !(Test-Path -LiteralPath $ImportFile -PathType Leaf)) { throw 'Use import -ImportFile C:\path\trusted-old.dump.' }
            $Name = 'legacy-' + [Guid]::NewGuid().ToString('N') + '.dump'
            Copy-Item -LiteralPath $ImportFile -Destination (Join-Path $State.PILOT_BACKUP_DIR $Name)
            $Imported = Tools @('import', $Name)
            Migrate $SettingsFile $Imported.database
            $ImportedBackup = Tools @('backup') $Imported.database
            ShowData $ImportedBackup
            Write-Host "Imported database: $($Imported.database). The active database is unchanged. This is not source reconciliation: use recover with the printed backup, then compare old and new records before using the pilot."
        }
        'update' {
            $Next = $State.Clone(); $Next.PILOT_RELEASE=GitRelease
            if ($Next.PILOT_RELEASE -eq $State.PILOT_RELEASE) { throw 'This commit is already selected. Use start or status. For a failed initial install, see the resume instructions.' }
            $Candidate = Join-Path $Private 'candidate.env'
            WriteSettings $Next $Candidate
            Compose @('--profile','operations','build','server','web','tools') $Candidate
            Compose @('stop','server')
            $Safety = Tools @('backup')
            Write-Host "Pre-update backup: $($Safety.backup). Keep its old release images until recovery is verified."
            # Migrate a verified copy, preserving the old database/schema intact.
            $CandidateDatabase = Tools @('restore', $Safety.backup)
            $Next.PILOT_DATABASE = $CandidateDatabase.database
            WriteSettings $Next $Candidate
            Migrate $Candidate
            Activate $Next
            Remove-Item -LiteralPath $Candidate
            Write-Host 'Update is healthy. Complete the pilot checklist before reopening to staff.'
        }
        'schedule' {
            $TaskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -File `"$PSCommandPath`" backup"
            $Trigger = New-ScheduledTaskTrigger -Daily -At '3:00AM'
            $Principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
            $TaskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
            Register-ScheduledTask -TaskName 'SKAO pilot daily backup' -Action $TaskAction -Trigger $Trigger -Principal $Principal -Settings $TaskSettings -Force | Out-Null
            Write-Host 'Daily backup scheduled for 03:00, or when next available while you are signed in and Docker is running. Check Task Scheduler results and backup dates regularly.'
        }
        'firewall' {
            if ($State.PILOT_BIND -eq '127.0.0.1') { throw 'This pilot uses loopback only. A firewall rule cannot enable LAN access.' }
            $Rule = 'SKAO private HTTPS 8443'
            if (Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue) { throw 'The firewall rule already exists. Review it in Windows Firewall.' }
            New-NetFirewallRule -DisplayName $Rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8443 -LocalAddress $State.PILOT_BIND -RemoteAddress LocalSubnet -Profile Private | Out-Null
        }
    }
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
} finally { if ($null -ne $Lock) { $Lock.Dispose() } }
