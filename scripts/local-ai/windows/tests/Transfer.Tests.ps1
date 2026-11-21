#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Transfer-To-Pi.ps1')
$count = 0
function Assert-Test([bool]$Value, [string]$Name) {
    if (!$Value) { throw ('FAIL: ' + $Name) }
    $script:count++
}
foreach ($address in @('10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.2')) {
    Assert-Test (Test-SkaoPrivateIpv4 $address) 'private IPv4 accepted'
}
foreach ($address in @('1.2.3.4', '127.0.0.1', '192.168.01.2', '256.2.3.4', '172.32.0.1', '10.0.0.1; echo bad', '::1', '')) {
    Assert-Test (!(Test-SkaoPrivateIpv4 $address)) 'untrusted endpoint rejected'
}
$script:hashes = @(('a' * 64), ('b' * 64))
$script:remote = 'synthetic@192.168.1.2'
$script:ssh = 'Invoke-SyntheticSsh'
$script:receiver = '# synthetic receiver source'
$script:fakeExit = 0
$script:fakeReply = '{"status":"ready"}'
function Invoke-SyntheticSsh {
    process { }
    end { $global:LASTEXITCODE = $script:fakeExit; $script:fakeReply }
}
Assert-Test ((Invoke-SkaoReceiver 'inspect' '').status -ceq 'ready') 'valid reply parsed'
$script:fakeExit = 255
$script:fakeReply = 'do-not-print-sensitive-detail'
$caught = ''
try { Invoke-SkaoReceiver 'inspect' '' | Out-Null } catch { $caught = $_.Exception.Message }
Assert-Test ($caught -ceq 'SKAO_TRANSFER_SSH_INSPECT_FAILED') 'failed SSH redacted'
$script:fakeExit = 0
$caught = ''
try { Invoke-SkaoReceiver 'prepare' '' | Out-Null } catch { $caught = $_.Exception.Message }
Assert-Test ($caught -ceq 'SKAO_TRANSFER_SSH_REPLY_INVALID') 'invalid reply redacted'
$script:fakeReply = '{"status":"ready"}'
$caught = ''
try { Invoke-SkaoReceiver 'publish' '../escape' | Out-Null } catch { $caught = $_.Exception.Message }
Assert-Test ($caught -ceq 'SKAO_TRANSFER_STAGE_INVALID') 'stage cannot escape'
$script:fakeReply = '{"error":"synthetic"}'
$caught = ''
try { Invoke-SkaoReceiver 'inspect' '' | Out-Null } catch { $caught = $_.Exception.Message }
Assert-Test ($caught -ceq 'SKAO_TRANSFER_REMOTE_CHECK_FAILED') 'remote denial preserved as controlled error'

# A child script that only sets a failing native exit must stop before account/SSH work.
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('skao-transfer-test-' + [guid]::NewGuid().ToString('N'))
$oldOs = $env:OS
try {
    $null = New-Item -Path $temporary -ItemType Directory
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\Transfer-To-Pi.ps1') -Destination (Join-Path $temporary 'Transfer-To-Pi.ps1')
    [IO.File]::WriteAllText((Join-Path $temporary 'Setup-Gateway.ps1'), '$global:LASTEXITCODE = 23; return')
    [IO.File]::WriteAllText((Join-Path $temporary 'Receive-Connection.py'), '# synthetic')
    $env:OS = 'Windows_NT'
    $executable = (Get-Process -Id $PID).Path
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = @(& $executable -NoProfile -File (Join-Path $temporary 'Transfer-To-Pi.ps1') -Check -PiUser synthetic 2>&1)
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $oldPreference }
    Assert-Test ($code -eq 1 -and ($result -join "`n") -match 'SKAO_TRANSFER_GATEWAY_CHECK_FAILED') 'failing child stops transfer'
}
finally {
    $env:OS = $oldOs
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
Write-Host ('PASS: ' + $count + ' transfer PowerShell checks')
