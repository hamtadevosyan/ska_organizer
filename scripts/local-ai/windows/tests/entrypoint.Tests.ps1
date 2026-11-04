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
    $script:Stages = @(); $script:FailComparison = $false
    function Invoke-SkaoSetupChild {
        param($Script, $Options)
        $name = Split-Path -Leaf $Script
        $script:Stages += [pscustomobject]@{ Name = $name; Options = ($Options | ConvertTo-Json | ConvertFrom-Json) }
        if ($script:FailComparison -and $name -ceq 'Setup-ActivityImages.ps1' -and $Options.CompareSDXL) {
            throw 'synthetic comparison prerequisite failure'
        }
    }
    Invoke-SkaoCompleteSetup -Directory $temp | Out-Null
    Assert-True (($script:Stages.Name -join ',') -ceq 'Setup-Ollama.ps1,Setup-Gateway.ps1') 'default setup retains its original two stages'
    $script:Stages = @()
    Invoke-SkaoCompleteSetup -Directory $temp -ActivityImages | Out-Null
    Assert-True (($script:Stages.Name -join ',') -ceq 'Setup-Ollama.ps1,Setup-Gateway.ps1,Setup-ActivityImages.ps1,Setup-ActivityImages.ps1,Setup-ActivityMedia.ps1') 'one optional setup prepares both models before managed media'
    Assert-True (!$script:Stages[2].Options.CompareSDXL -and $script:Stages[3].Options.CompareSDXL) 'fresh optional setup installs baseline before comparison'
    Assert-True (@($script:Stages | Where-Object { $_.Options.TestGeneration }).Count -eq 0) 'optional setup performs no implicit inference'
    $script:Stages = @()
    Invoke-SkaoCompleteSetup -Directory $temp -ActivityImages -Check | Out-Null
    Assert-True (($script:Stages.Name -join ',') -ceq 'Setup-Ollama.ps1,Setup-Gateway.ps1,Setup-ActivityImages.ps1,Setup-ActivityMedia.ps1') 'optional check never calls baseline installation stage'
    Assert-True (@($script:Stages | Where-Object { !$_.Options.Check }).Count -eq 0 -and $script:Stages[2].Options.CompareSDXL) 'all optional check stages remain read-only'
    $script:Stages = @()
    Invoke-SkaoCompleteSetup -Directory $temp -ActivityImages -TransferToPi -PiUser 'synthetic' | Out-Null
    Assert-True ($script:Stages[-1].Name -ceq 'Transfer-To-Pi.ps1' -and $script:Stages[-1].Options.PiUser -ceq 'synthetic') 'optional transfer occurs after ready media setup'
    $script:Stages = @(); $script:FailComparison = $true
    Assert-Throws { Invoke-SkaoCompleteSetup -Directory $temp -ActivityImages }
    Assert-True (@($script:Stages | Where-Object { $_.Name -ceq 'Setup-ActivityMedia.ps1' }).Count -eq 0) 'failed model prerequisite cannot start worker or enable routes'
}
finally { Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Output ('PASS: '+$script:Checks+' setup entry-point checks')
