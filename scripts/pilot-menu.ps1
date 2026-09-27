# SKAO.cmd is the short entry point; this script also works directly in PowerShell.
[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [ValidateSet('menu','setup-phone','start','stop','restart','update','status','logs','backup','doctor','certificate','trust','firewall')]
    [string]$Action = 'menu',
    [switch]$Elevated
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot

function Invoke-SkaoGit([string[]]$Arguments) {
    $Output = @(& git -C $Repo @Arguments)
    if ($LASTEXITCODE -ne 0) { throw 'Git failed. The deployment was not started. Resolve the reported error and rerun update.' }
    return $Output
}

function Update-SkaoCheckout {
    if (!(Test-Path -LiteralPath (Join-Path $Repo '.pilot/runtime.env'))) {
        throw 'This is not the installed pilot checkout. Run SKAO.cmd from the existing Windows pilot repository.'
    }
    # Do not change deployment files while another pilot operation is using them.
    $CheckoutLock = [System.IO.File]::Open((Join-Path $Repo '.pilot/operation.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    try {
        if (@(Invoke-SkaoGit @('status','--porcelain','--untracked-files=all')).Count) {
            throw 'The checkout has local changes. Commit/merge your tested work first, or preserve it elsewhere. update will not overwrite it.'
        }
        $Branch = [string](Invoke-SkaoGit @('branch','--show-current'))
        if ($Branch -notin @('development','main')) { throw 'update follows an existing development or main branch. Finish your feature review/merge first; no branch is switched automatically.' }
        $Upstream = [string](Invoke-SkaoGit @('rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}'))
        if ($Upstream -cne "origin/$Branch") { throw "Expected this checkout to track origin/$Branch. Review its Git upstream before updating." }
        # Fast-forward only: no forced reset, stash, merge commit, push, or branch switch.
        Invoke-SkaoGit @('pull','--ff-only','--no-rebase','origin',$Branch) | Out-Host
    } finally { $CheckoutLock.Dispose() }
}

function Test-SkaoAdministrator {
    $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = New-Object System.Security.Principal.WindowsPrincipal($Identity)
    return $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-SkaoAction([string]$Name) {
    if ($Name -in @('setup-phone','firewall') -and !(Test-SkaoAdministrator)) {
        # Windows UAC applies only to firewall configuration, not everyday operations.
        # A file path cannot contain a quote; the action has already been validated.
        $Arguments = '-NoProfile -File "{0}" -Action {1} -Elevated' -f (Join-Path $PSScriptRoot 'pilot-menu.ps1'), $Name
        $Process = Start-Process -FilePath 'powershell.exe' -ArgumentList $Arguments -WorkingDirectory $Repo -Verb RunAs -Wait -PassThru -ErrorAction Stop
        return $Process.ExitCode
    }
    if ($Name -eq 'update') { Update-SkaoCheckout }
    $PilotAction = $Name
    if ($Name -eq 'setup-phone') { $PilotAction = 'lan' }
    & powershell.exe -NoProfile -File (Join-Path $PSScriptRoot 'pilot.ps1') $PilotAction | Out-Host
    return $LASTEXITCODE
}

# Dot-sourcing loads functions for the isolated tests, without starting a menu or process.
if ($MyInvocation.InvocationName -eq '.') { return }

$ExitCode = 0
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Run SKAO.cmd on the Windows Docker Desktop computer.' }
    if ($Elevated -and !(Test-SkaoAdministrator)) { throw 'Administrator access was not granted. No setup was run.' }
    if ($Action -eq 'menu') {
        $Commands = @('setup-phone','start','restart','update','status','doctor','certificate','backup','stop','logs','trust')
        do {
            Write-Host "`nSmart Kids Academy - Docker controls"
            for ($Index = 0; $Index -lt $Commands.Count; $Index++) { Write-Host "$($Index + 1). $($Commands[$Index])" }
            Write-Host '0. Exit'
            $Answer = Read-Host 'Choose a command'
            if ($Answer -eq '0') { break }
            $Choice = 0
            if (![int]::TryParse($Answer, [ref]$Choice) -or $Choice -lt 1 -or $Choice -gt $Commands.Count) {
                Write-Host 'Choose one of the listed numbers.'
                continue
            }
            try { $ExitCode = Invoke-SkaoAction $Commands[$Choice - 1] }
            catch { $ExitCode = 1; Write-Host $_.Exception.Message -ForegroundColor Red }
            if ($ExitCode -ne 0) { Write-Host "Command failed (exit $ExitCode). Read the error above before retrying." -ForegroundColor Red }
            Read-Host 'Press Enter to return to the menu' | Out-Null
        } while ($true)
    } else { $ExitCode = Invoke-SkaoAction $Action }
} catch {
    $ExitCode = 1
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    # Keep the separate UAC window visible so the phone URL and any error can be read.
    if ($Elevated) { Read-Host "Command exit code: $ExitCode. Press Enter to close this window" | Out-Null }
}
exit $ExitCode
