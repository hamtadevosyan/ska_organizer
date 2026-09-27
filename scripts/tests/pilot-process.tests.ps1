# Exercise real child-process output/exit handling without Docker or pilot data.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ShellName = 'pwsh'
if ($PSVersionTable.PSEdition -eq 'Desktop') { $ShellName = 'powershell.exe' }
elseif ($env:OS -eq 'Windows_NT') { $ShellName = 'pwsh.exe' }
$PowerShellExe = Join-Path $PSHOME $ShellName
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('skao process ' + [guid]::NewGuid().ToString('N'))
$Repo = $TestRoot
$SettingsFile = Join-Path $TestRoot 'saved settings.env'
$ComposeFile = Join-Path $TestRoot 'compose.pilot.yaml'
$Fixture = Join-Path $TestRoot 'docker fixture.ps1'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Passed = 0
$Skipped = 0

function Assert([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }

# Load only these production functions; never execute pilot.ps1's entry point.
$Tokens = $null; $Errors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $SourceRoot 'scripts/pilot.ps1'), [ref]$Tokens, [ref]$Errors)
Assert ($Errors.Count -eq 0) 'pilot.ps1 has parse errors.'
foreach ($Definition in $Ast.EndBlock.Statements) {
    if ($Definition -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Definition.Name -in @('Native','Compose','Tools')) {
        . ([scriptblock]::Create($Definition.Extent.Text))
    }
}
function docker {
    # Preserve native stdout, stderr and exit status across the real boundary.
    & $PowerShellExe -NoProfile -File $Fixture @args
}

$EnvironmentNames = @('COMPOSE_ANSI','COMPOSE_PROGRESS','BUILDKIT_PROGRESS')
$SavedEnvironment = @{}
foreach ($Name in $EnvironmentNames) { $SavedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process') }
try {
    New-Item -ItemType Directory -Path $TestRoot | Out-Null
    # Deliberately inherit terminal preferences: the script must override them.
    $env:COMPOSE_ANSI = 'always'
    $env:COMPOSE_PROGRESS = 'tty'
    $env:BUILDKIT_PROGRESS = 'tty'
    [System.IO.File]::WriteAllText($Fixture, @'
$ErrorActionPreference = 'Stop'
if ($args[0] -ne 'compose') { throw 'Expected Compose.' }
$AnsiIndex = [Array]::IndexOf($args, '--ansi')
$ProgressIndex = [Array]::IndexOf($args, '--progress')
if ($AnsiIndex -lt 0 -or $ProgressIndex -lt 0 -or $args[$AnsiIndex + 1] -ne 'never' -or $args[$ProgressIndex + 1] -ne 'plain') {
    [Console]::Error.WriteLine('failed to get console: synthetic redirected console')
    exit 31
}
$ProjectIndex = [Array]::IndexOf($args, '--project-directory')
$EnvIndex = [Array]::IndexOf($args, '--env-file')
if ($ProjectIndex -lt 0 -or $args[$ProjectIndex + 1] -ne $PSScriptRoot -or $EnvIndex -lt 0 -or $args[$EnvIndex + 1] -ne (Join-Path $PSScriptRoot 'saved settings.env')) {
    throw 'A path containing spaces was split.'
}
[Console]::Error.WriteLine('Synthetic Docker progress on stderr.')
if ($args -contains 'build') {
    [Console]::Error.WriteLine('Synthetic Docker build failure.')
    exit 23
}
[Console]::Out.WriteLine('{"operation":"backup","backup":"backup-synthetic"}')
exit 0
'@, $Utf8)

    $Result = Tools @('backup')
    Assert ($Result.operation -eq 'backup' -and $Result.backup -eq 'backup-synthetic') 'Child progress polluted the JSON result.'
    $Passed++; Write-Host 'PASS Captured Compose output stays valid JSON with inherited TTY preferences and paths containing spaces'

    $Failure = ''
    $Continued = $false
    try { Compose @('--profile','operations','build','server','web','tools'); $Continued = $true }
    catch { $Failure = $_.Exception.Message }
    Assert (!$Continued) 'Continued after a failed native process.'
    Assert ($Failure -like 'docker compose --profile operations build server web tools failed (exit 23).*') 'Lost the Docker operation or native exit status.'
    $Passed++; Write-Host 'PASS A native failure names the Compose operation, preserves the exit status and stops later work'

    if ($env:OS -eq 'Windows_NT') {
        # This is a real powershell.exe launch on Windows CI, not Start-Process mocking.
        $LauncherDirectory = Join-Path $TestRoot 'launcher with spaces/scripts'
        New-Item -ItemType Directory -Path $LauncherDirectory -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $SourceRoot 'scripts/pilot-menu.ps1') -Destination $LauncherDirectory
        [System.IO.File]::WriteAllText((Join-Path $LauncherDirectory 'pilot.ps1'), @'
param([string]$Action)
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'received-action.txt'), $Action)
[Console]::Out.WriteLine('Synthetic launcher child stdout.')
[Console]::Error.WriteLine('Synthetic launcher child stderr.')
exit 7
'@, $Utf8)
        $ExitCode = & {
            . (Join-Path $LauncherDirectory 'pilot-menu.ps1')
            Invoke-SkaoAction 'restart'
        }
        Assert ($ExitCode -is [int] -and $ExitCode -eq 7) 'Launcher mixed child output into its exit code or lost the failure.'
        Assert ((Get-Content -LiteralPath (Join-Path $LauncherDirectory 'received-action.txt') -Raw) -eq 'restart') 'Launcher did not run the requested action.'
        $Passed++; Write-Host 'PASS The real Windows child launches from a path containing spaces and returns only its exit code'

        # Exercise the batch wrapper without requesting UAC or touching the host.
        # Its input prompt must survive normal script completion and a parse error
        # that prevents any PowerShell cleanup/finally block from running.
        Copy-Item -LiteralPath (Join-Path $SourceRoot 'scripts/pilot-elevated.cmd') -Destination $LauncherDirectory
        foreach ($Case in @(
            @{ Script = 'param([string]$Action, [switch]$Elevated)'; ExitCode = 0 },
            @{ Script = 'param('; ExitCode = 1 }
        )) {
            [System.IO.File]::WriteAllText((Join-Path $LauncherDirectory 'pilot-menu.ps1'), $Case.Script, $Utf8)
            $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
            $StartInfo.FileName = 'cmd.exe'
            $StartInfo.Arguments = '/d /s /c ""{0}" setup-phone"' -f (Join-Path $LauncherDirectory 'pilot-elevated.cmd')
            $StartInfo.UseShellExecute = $false
            $StartInfo.CreateNoWindow = $true
            $StartInfo.RedirectStandardInput = $true
            $StartInfo.RedirectStandardOutput = $true
            $StartInfo.RedirectStandardError = $true
            $Child = [System.Diagnostics.Process]::Start($StartInfo)
            try {
                $ErrorOutput = $Child.StandardError.ReadToEndAsync()
                $Timer = [System.Diagnostics.Stopwatch]::StartNew()
                do {
                    $Line = $Child.StandardOutput.ReadLineAsync()
                    Assert ($Line.Wait([Math]::Max(1, 15000 - [int]$Timer.ElapsedMilliseconds))) 'Wrapper did not report the child result.'
                    $Text = $Line.Result
                    Assert ($null -ne $Text) 'Wrapper exited before reporting the child result.'
                } until ($Text -like 'Command exit code:*')
                Assert ($Text -like "Command exit code: $($Case.ExitCode).*") 'Wrapper lost the original command result.'
                Assert (!$Child.WaitForExit(250)) 'Administrator window closed without waiting for Enter.'
                $Child.StandardInput.WriteLine()
                $Child.StandardInput.Flush()
                Assert ($Child.WaitForExit(5000)) 'Wrapper did not exit after acknowledgement.'
                Assert ($Child.ExitCode -eq $Case.ExitCode) 'Input acknowledgement replaced the original exit code.'
                if ($Case.ExitCode -eq 1) { Assert ($ErrorOutput.Result -match 'ParserError') 'The startup error was not visible.' }
            } finally {
                if (!$Child.HasExited) { $Child.Kill(); $Child.WaitForExit() }
                $Child.Dispose()
            }
        }
        $Passed++; Write-Host 'PASS The administrator wrapper waits after success and startup failure, retaining the original exit code'
    } else {
        $Skipped += 2; Write-Host 'SKIP Real Windows launcher and administrator wrapper: require Windows'
    }
} finally {
    foreach ($Name in $EnvironmentNames) { [Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name], 'Process') }
    if (Test-Path -LiteralPath $TestRoot) { Remove-Item -LiteralPath $TestRoot -Recurse -Force }
}
Write-Host "$Passed process checks passed; $Skipped Windows-only checks skipped."
exit 0
