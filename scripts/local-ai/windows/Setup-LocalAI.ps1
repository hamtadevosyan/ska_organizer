#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$TestGeneration,
    [switch]$TransferToPi,
    [string]$PiUser,
    [string]$LaptopIp,
    [string]$PiIp,
    [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'

function Invoke-SkaoSetupChild {
    param([Parameter(Mandatory = $true)][string]$Script,
          [Parameter(Mandatory = $true)][hashtable]$Options)
    if (!(Test-Path -LiteralPath $Script -PathType Leaf)) { throw 'AI_PACKAGE: A required companion setup script is missing.' }
    $global:LASTEXITCODE = 0
    & $Script @Options
    $powershellSucceeded = $?
    $childExit = $LASTEXITCODE
    if (!$powershellSucceeded -or $childExit -ne 0) { throw 'AI_CHILD_FAILED: A setup stage failed. Later setup stages were not run.' }
}

function Invoke-SkaoCompleteSetup {
    param([string]$Directory, [switch]$Check, [switch]$TestGeneration,
          [switch]$TransferToPi, [string]$PiUser, [string]$LaptopIp,
          [string]$PiIp, [string]$ArchivePath)
    if ($Check -and ($TestGeneration -or $TransferToPi -or $ArchivePath)) {
        throw 'AI_ARGUMENTS: -Check cannot install, transfer or generate.'
    }
    if ($PiUser -and !$TransferToPi) { throw 'AI_ARGUMENTS: -PiUser is used only with -TransferToPi.' }
    $ollama = @{}
    if ($Check) { $ollama.Check = $true }
    if ($TestGeneration) { $ollama.TestGeneration = $true }
    if ($ArchivePath) { $ollama.ArchivePath = $ArchivePath }
    Invoke-SkaoSetupChild -Script (Join-Path $Directory 'Setup-Ollama.ps1') -Options $ollama
    $gateway = @{}
    if ($Check) { $gateway.Check = $true }
    if ($LaptopIp) { $gateway.LaptopIp = $LaptopIp }
    if ($PiIp) { $gateway.PiIp = $PiIp }
    Invoke-SkaoSetupChild -Script (Join-Path $Directory 'Setup-Gateway.ps1') -Options $gateway
    if ($TransferToPi) {
        $transfer = @{}
        if ($PiUser) { $transfer.PiUser = $PiUser }
        Invoke-SkaoSetupChild -Script (Join-Path $Directory 'Transfer-To-Pi.ps1') -Options $transfer
    }
    Write-Output 'PASS: Windows local AI setup completed'
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-SkaoCompleteSetup -Directory $PSScriptRoot -Check:$Check -TestGeneration:$TestGeneration -TransferToPi:$TransferToPi -PiUser $PiUser -LaptopIp $LaptopIp -PiIp $PiIp -ArchivePath $ArchivePath
        $global:LASTEXITCODE = 0
    }
    catch {
        $code = 'AI_SETUP'
        if ([string]$_.Exception.Message -match '^(AI_[A-Z_]+):') { $code = $Matches[1] }
        Write-Error ($code + ': Windows AI setup stopped; later stages were not run. Review the saved setup guide.') -ErrorAction Continue
        exit 1
    }
}
