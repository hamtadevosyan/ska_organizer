#Requires -Version 5.1
[CmdletBinding()]
param([switch]$Check, [string]$PiUser)

$ErrorActionPreference = 'Stop'

function Stop-SkaoTransfer([string]$Code) { throw ('SKAO_TRANSFER_' + $Code) }

function Test-SkaoPrivateIpv4([string]$Value) {
    if ($Value -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { return $false }
    $parts = @($Value.Split('.') | ForEach-Object { [int]$_ })
    if (@($parts | Where-Object { $_ -gt 255 }).Count -or ($parts -join '.') -cne $Value) { return $false }
    return $parts[0] -eq 10 -or ($parts[0] -eq 172 -and $parts[1] -ge 16 -and $parts[1] -le 31) -or ($parts[0] -eq 192 -and $parts[1] -eq 168)
}

function Assert-SkaoTransferPath([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force
    if ([bool]$item.PSIsContainer -ne $Directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Stop-SkaoTransfer 'SOURCE_PATH_UNSAFE'
    }
    if (!$Directory -and ($item.Length -le 0 -or $item.Length -gt 65536)) { Stop-SkaoTransfer 'SOURCE_SIZE' }
}

function Invoke-SkaoReceiver([ValidateSet('inspect', 'prepare', 'publish', 'cleanup')][string]$Mode, [string]$Stage) {
    $arguments = @('python3', '-', $Mode, $script:hashes[0], $script:hashes[1])
    if ($Stage) {
        if ($Stage -cnotmatch '^\.incoming-[0-9a-f]{32}$') { Stop-SkaoTransfer 'STAGE_INVALID' }
        $arguments += $Stage
    }
    $command = $arguments -join ' '
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        $reply = @($script:receiver | & $script:ssh -T -o ConnectTimeout=10 -o ConnectionAttempts=1 $script:remote $command 2>&1)
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $oldPreference }
    if ($code -ne 0) { Stop-SkaoTransfer ('SSH_' + $Mode.ToUpperInvariant() + '_FAILED') }
    try { $parsed = ($reply -join "`n") | ConvertFrom-Json }
    catch { Stop-SkaoTransfer 'SSH_REPLY_INVALID' }
    if ($null -eq $parsed -or $parsed -isnot [pscustomobject] -or $parsed.error) { Stop-SkaoTransfer 'REMOTE_CHECK_FAILED' }
    return $parsed
}

if ($MyInvocation.InvocationName -eq '.') { return }

try {
    if ($env:OS -ne 'Windows_NT') { Stop-SkaoTransfer 'WINDOWS_REQUIRED' }
    $gatewayScript = Join-Path $PSScriptRoot 'Setup-Gateway.ps1'
    $receiverPath = Join-Path $PSScriptRoot 'Receive-Connection.py'
    if (!(Test-Path -LiteralPath $gatewayScript -PathType Leaf) -or !(Test-Path -LiteralPath $receiverPath -PathType Leaf)) {
        Stop-SkaoTransfer 'COMPANION_MISSING'
    }
    $global:LASTEXITCODE = 0
    & $gatewayScript -Check
    $checkSucceeded = $?
    $checkCode = $LASTEXITCODE
    if (!$checkSucceeded -or $checkCode -ne 0) { Stop-SkaoTransfer 'GATEWAY_CHECK_FAILED' }
    $root = Join-Path $env:LOCALAPPDATA 'SKAO-AI'
    $gateway = Join-Path $root 'gateway'
    $export = Join-Path $gateway 'pi-connection'
    foreach ($directory in @($root, $gateway, $export)) { Assert-SkaoTransferPath $directory $true }
    $metadata = Join-Path $gateway 'setup.json'
    Assert-SkaoTransferPath $metadata $false
    $settings = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($settings.Version -ne 1 -or $settings.OwnerSid -cne $sid -or !(Test-SkaoPrivateIpv4 ([string]$settings.PiIp))) {
        Stop-SkaoTransfer 'ACCOUNT_OR_METADATA_MISMATCH'
    }
    $sources = @((Join-Path $export 'ca.pem'), (Join-Path $export 'ai.env'))
    foreach ($source in $sources) { Assert-SkaoTransferPath $source $false }
    $script:hashes = @($sources | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() })
    $script:ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
    $scp = Join-Path $env:SystemRoot 'System32\OpenSSH\scp.exe'
    if (!(Test-Path -LiteralPath $script:ssh -PathType Leaf) -or !(Test-Path -LiteralPath $scp -PathType Leaf)) { Stop-SkaoTransfer 'OPENSSH_CLIENT_MISSING' }
    if (!$PiUser) { $PiUser = (Read-Host 'Pi SSH username (normal account)').Trim() }
    if ($PiUser -cnotmatch '^[a-z_][a-z0-9_.-]{0,31}$' -or $PiUser -ceq 'root') { Stop-SkaoTransfer 'NORMAL_PI_USERNAME_REQUIRED' }
    $script:remote = '{0}@{1}' -f $PiUser, $settings.PiIp
    $script:receiver = [IO.File]::ReadAllText($receiverPath)
    if ($script:receiver -match '[^\x00-\x7F]') { Stop-SkaoTransfer 'RECEIVER_MUST_BE_ASCII' }
    $inspection = Invoke-SkaoReceiver 'inspect' ''
    if ($inspection.status -ceq 'ready') {
        Write-Host 'PASS: private Pi connection files already match; nothing copied.'
        $global:LASTEXITCODE = 0
        return
    }
    if ($inspection.status -cne 'missing') { Stop-SkaoTransfer 'REMOTE_STATE_INVALID' }
    if ($Check) { Stop-SkaoTransfer 'PI_CONNECTION_FILES_MISSING' }
    $prepared = Invoke-SkaoReceiver 'prepare' ''
    if ($prepared.status -ceq 'ready') { Write-Host 'PASS: private Pi connection files already match.'; $global:LASTEXITCODE = 0; return }
    if ($prepared.status -cne 'staging' -or [string]$prepared.stage -cnotmatch '^\.incoming-[0-9a-f]{32}$') { Stop-SkaoTransfer 'STAGE_INVALID' }
    $stage = [string]$prepared.stage
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        & $scp -q -o ConnectTimeout=10 -o ConnectionAttempts=1 @sources ('{0}:skao-ai-transfer/{1}/' -f $script:remote, $stage)
        $copyCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $oldPreference }
    if ($copyCode -ne 0) { Stop-SkaoTransfer 'SCP_FAILED_PRIVATE_STAGING_RETAINED' }
    # Hashes were captured before copying; a changed source cannot be published.
    $published = Invoke-SkaoReceiver 'publish' $stage
    if ($published.status -cne 'ready') { Stop-SkaoTransfer 'PUBLICATION_INCOMPLETE' }
    Write-Host 'PASS: only ca.pem and ai.env transferred and verified in the private Pi folder.'
    Write-Host 'Continue with the saved Pi setup command as that Pi account.'
    $global:LASTEXITCODE = 0
}
catch {
    $message = [string]$_.Exception.Message
    if ($message -cnotmatch '^SKAO_TRANSFER_[A-Z0-9_]+$') { $message = 'SKAO_TRANSFER_CHECK_FAILED' }
    Write-Error $message -ErrorAction Continue
    exit 1
}
