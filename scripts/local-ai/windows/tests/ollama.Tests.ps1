#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Setup-Ollama.ps1')
$script:TestCount = 0
function Assert-True { param($Value, [string]$Label) if (!$Value) { throw ('FAIL: ' + $Label) }; $script:TestCount++ }
function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern, [string]$Label)
    $errorText = $null
    try { & $Action | Out-Null } catch { $errorText = $_.Exception.Message }
    Assert-True ($null -ne $errorText -and $errorText -like $Pattern) $Label
}

$launcher = Get-SkaoOllamaLauncher
Assert-True ($launcher -match 'OLLAMA_HOST=127\.0\.0\.1:11434') 'launcher binds loopback'
Assert-True ($launcher -match 'OLLAMA_KEEP_ALIVE=0') 'launcher releases idle model'
Assert-True ($launcher -match 'OLLAMA_NO_CLOUD=1') 'launcher disables cloud'
Assert-True ($launcher -match 'OLLAMA_NUM_PARALLEL=1') 'launcher runs one request at a time'
Assert-True ((ConvertTo-SkaoNormalizedCommand $launcher) -ceq (ConvertTo-SkaoNormalizedCommand ($launcher.Replace("`n", "`r`n") + "`r`n"))) 'known LF and CRLF launcher compatibility'
Assert-True ($script:SkaoOllamaArchiveHash -ceq '7afa38624fa62ee5d8293422d0ab084c1bb4603134c7f4dafce11a033b57cc19') 'archive pin retained'

# These metadata tests exercise the production validators without contacting a model.
$script:MetadataVersion = '0.40.13'
$script:CloudValue = $true
$script:ModelDigest = $script:SkaoOllamaDigest
$script:PresentModel = $true
$script:RemoteHost = $null
$script:Completion = $true
$script:ApiCalls = New-Object System.Collections.Generic.List[string]
function Invoke-SkaoOllamaJson {
    param([string]$Path, $Body, [int]$TimeoutSeconds)
    $script:ApiCalls.Add($Path)
    switch ($Path) {
        '/api/version' { return [pscustomobject]@{version=$script:MetadataVersion} }
        '/api/status' { return [pscustomobject]@{cloud=[pscustomobject]@{disabled=$script:CloudValue}} }
        '/api/tags' {
            if (!$script:PresentModel) { return [pscustomobject]@{models=@()} }
            return [pscustomobject]@{models=@([pscustomobject]@{name=$script:SkaoOllamaModel;digest=$script:ModelDigest;remote_host=$script:RemoteHost})}
        }
        '/api/show' {
            Assert-True ($Body.model -ceq $script:SkaoOllamaModel) 'show selects exact expected model'
            $capabilities = @('embedding'); if ($script:Completion) { $capabilities = @('completion') }
            return [pscustomobject]@{capabilities=$capabilities;remote_host=$script:RemoteHost}
        }
        default { throw 'Unexpected generation or API request during metadata test.' }
    }
}
Assert-SkaoOllamaMetadata
Assert-True (Get-SkaoOllamaInstalledModel) 'local pinned metadata accepted'
$script:MetadataVersion = 'other'
Assert-Throws { Assert-SkaoOllamaMetadata } 'AI_VERSION_CONFLICT:*' 'different version refused'
$script:MetadataVersion = '0.40.13'
foreach ($value in @($false, 'True', 1, $null)) {
    $script:CloudValue = $value
    Assert-Throws { Assert-SkaoOllamaMetadata } 'AI_CLOUD_ENABLED:*' 'cloud-disabled must be actual JSON true'
}
$script:CloudValue = $true
$script:ModelDigest = 'unexpected'
Assert-Throws { Get-SkaoOllamaInstalledModel } 'AI_MODEL_CONFLICT:*' 'wrong tag digest refused'
$script:ModelDigest = $script:SkaoOllamaDigest
$script:RemoteHost = 'cloud.invalid'
Assert-Throws { Get-SkaoOllamaInstalledModel } 'AI_MODEL_CONFLICT:*' 'remote model refused'
$script:RemoteHost = $null
$script:Completion = $false
Assert-Throws { Get-SkaoOllamaInstalledModel } 'AI_MODEL_CONFLICT:*' 'noncompletion model refused'
$script:Completion = $true
$script:PresentModel = $false
Assert-True (!(Get-SkaoOllamaInstalledModel)) 'missing model distinguishable without pulling'
$script:PresentModel = $true
Assert-True (@($script:ApiCalls | Where-Object { $_ -in @('/api/generate','/api/ps') }).Count -eq 0) 'metadata checks never infer or load'

# Main-flow tests use actual fixture files and fail on any mutation for adopted installs.
$script:FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('skao-ollama-test-' + [Guid]::NewGuid().ToString('N'))
$script:Starts = 0; $script:Pulls = 0; $script:TaskState = 'Running'; $script:ModelInstalled = $true
$script:TaskPresent = $true; $script:TaskValid = $true
try {
    [void](New-Item -ItemType Directory -Path $script:FixtureRoot)
    [void](New-Item -ItemType Directory -Path (Join-Path $script:FixtureRoot 'ollama-v0.40.13'))
    [void](New-Item -ItemType Directory -Path (Join-Path $script:FixtureRoot 'models'))
    [IO.File]::WriteAllText((Join-Path $script:FixtureRoot 'Run-Ollama.cmd'), $launcher)
    [IO.File]::WriteAllText((Join-Path $script:FixtureRoot 'ollama-v0.40.13\ollama.exe'), 'synthetic executable')
    $before = @{}; Get-ChildItem -LiteralPath $script:FixtureRoot -Recurse -File | ForEach-Object { $before[$_.FullName] = [IO.File]::ReadAllBytes($_.FullName) }
    function Get-SkaoOllamaContext { return [pscustomobject]@{Sid='S-1-5-21-111';Account='Synthetic';Root=$script:FixtureRoot} }
    function Get-ScheduledTask {
        param($TaskName, $TaskPath, $ErrorAction)
        if ($script:TaskPresent) { return [pscustomobject]@{State=$script:TaskState} }
    }
    function Assert-SkaoOllamaAcl { param($Path,$Sid,[switch]$Protected) }
    function Assert-SkaoOllamaTaskDefinition { param($Task,$Launcher,$Sid) if (!$script:TaskValid) { throw 'AI_TASK_CONFLICT: Synthetic mismatch' } }
    function Assert-SkaoOllamaMetadata { }
    function Wait-SkaoOllamaReady { }
    function Get-SkaoOllamaInstalledModel { return $script:ModelInstalled }
    function Start-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction) $script:Starts++; $script:TaskState='Running' }
    function Invoke-SkaoOllamaPull { param($Executable) $script:Pulls++; $script:ModelInstalled=$true }
    function Set-SkaoNewOllamaDirectoryAcl { throw 'Unexpected ACL rewrite' }
    function Install-SkaoOllamaRuntime { throw 'Unexpected install/download' }
    function Register-SkaoOllamaTask { throw 'Unexpected password prompt or task registration' }
    function Test-SkaoOllamaGeneration { throw 'Unexpected inference' }
    Invoke-SkaoOllamaSetup -Check | Out-Null
    Invoke-SkaoOllamaSetup | Out-Null
    Assert-True ($script:Starts -eq 0 -and $script:Pulls -eq 0) 'known running manual install adopted without start/download'
    foreach ($file in $before.Keys) {
        Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($file)) -ceq [Convert]::ToBase64String($before[$file])) 'existing file bytes preserved'
    }
    $script:TaskState = 'Ready'
    Assert-Throws { Invoke-SkaoOllamaSetup -Check } 'AI_NOT_RUNNING:*' 'check leaves stopped task stopped'
    Assert-True ($script:Starts -eq 0) 'check did not start task'
    Invoke-SkaoOllamaSetup | Out-Null
    Assert-True ($script:Starts -eq 1) 'normal setup starts existing valid stopped task'
    $script:ModelInstalled = $false
    Assert-Throws { Invoke-SkaoOllamaSetup -Check } 'AI_MODEL_MISSING:*' 'check leaves absent model absent'
    Assert-True ($script:Pulls -eq 0) 'check does not pull model'
    Invoke-SkaoOllamaSetup | Out-Null
    Assert-True ($script:Pulls -eq 1) 'normal setup pulls only missing model'
    $script:TaskValid = $false
    Assert-Throws { Invoke-SkaoOllamaSetup } 'AI_TASK_CONFLICT:*' 'foreign task definition refused'
    $script:TaskValid = $true
    [IO.File]::AppendAllText((Join-Path $script:FixtureRoot 'Run-Ollama.cmd'), "`nset OLLAMA_HOST=0.0.0.0:11434")
    Assert-Throws { Invoke-SkaoOllamaSetup } 'AI_LAUNCHER_CONFLICT:*' 'modified launcher preserved and refused'
    [IO.File]::WriteAllText((Join-Path $script:FixtureRoot 'Run-Ollama.cmd'), $launcher)
    $script:TaskPresent = $false
    Assert-Throws { Invoke-SkaoOllamaSetup -Check } 'AI_NOT_CONFIGURED:*' 'check does not create absent task'
    foreach ($option in @('TestGeneration','ArchivePath')) {
        if ($option -eq 'TestGeneration') { Assert-Throws { Invoke-SkaoOllamaSetup -Check -TestGeneration } 'AI_ARGUMENTS:*' 'check rejects inference' }
        else { Assert-Throws { Invoke-SkaoOllamaSetup -Check -ArchivePath 'synthetic.zip' } 'AI_ARGUMENTS:*' 'check rejects installer archive' }
    }
}
finally { Remove-Item -LiteralPath $script:FixtureRoot -Recurse -Force }
Write-Output ('PASS: ' + $script:TestCount + ' Ollama setup checks')
