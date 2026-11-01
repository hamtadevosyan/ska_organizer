#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Setup-LocalAI.ps1')
$script:Checks = 0
function Assert-True { param($Value,$Label) if (!$Value) { throw ('FAIL: '+$Label) }; $script:Checks++ }
function Assert-Throws { param([scriptblock]$Body) $failed=$false; try { & $Body | Out-Null } catch { $failed=$true }; Assert-True $failed 'expected failure' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('skao-entry-test-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $temp)
try {
    $success = Join-Path $temp 'success.ps1'; $failure=Join-Path $temp 'failure.ps1'; $throwing=Join-Path $temp 'throwing.ps1'
    [IO.File]::WriteAllText($success, '$global:LASTEXITCODE = 0')
    [IO.File]::WriteAllText($failure, '$global:LASTEXITCODE = 7')
    [IO.File]::WriteAllText($throwing, 'throw "synthetic failure"')
    $global:LASTEXITCODE=9
    Invoke-SkaoSetupChild -Script $success -Options @{}
    Assert-True ($LASTEXITCODE -eq 0) 'stale native exit code reset'
    Assert-Throws { Invoke-SkaoSetupChild -Script $failure -Options @{} }
    Assert-Throws { Invoke-SkaoSetupChild -Script $throwing -Options @{} }
    Assert-Throws { Invoke-SkaoCompleteSetup -Directory $temp -Check -TestGeneration }
    Assert-Throws { Invoke-SkaoCompleteSetup -Directory $temp -Check -TransferToPi }
    Assert-Throws { Invoke-SkaoCompleteSetup -Directory $temp -PiUser 'synthetic' }
}
finally { Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Output ('PASS: '+$script:Checks+' setup entry-point checks')
