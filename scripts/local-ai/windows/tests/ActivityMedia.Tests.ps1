#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Setup-ActivityMedia.ps1')
$script:Checks = 0
function Assert-MediaTrue { param($Value, [string]$Label) if (!$Value) { throw ('FAIL: ' + $Label) }; $script:Checks++ }
function Assert-MediaThrows {
    param([scriptblock]$Action, [string]$Pattern, [string]$Label)
    $message = $null; try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
    Assert-MediaTrue ($null -ne $message -and $message -like $Pattern) $Label
}
function Copy-MediaObject($Value) { return ($Value | ConvertTo-Json -Depth 12 | ConvertFrom-Json) }
function Get-MediaTree([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) { return '{}' }
    $values = [ordered]@{}
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Recurse -Force | Sort-Object FullName)) {
        $values[$item.FullName.Substring($Path.Length)] = if ($item.PSIsContainer) { '<directory>' } else { (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
    }
    return ($values | ConvertTo-Json -Compress)
}

$oldSystemRoot = $env:SystemRoot
if (!$env:SystemRoot) { $env:SystemRoot = [IO.Path]::GetTempPath() }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('skao-media-test-' + [Guid]::NewGuid().ToString('N'))
try {
    [void](New-Item -ItemType Directory -Path $fixture)
    $script:Context = [pscustomobject]@{ Root = (Join-Path $fixture 'worker'); ImageRoot = (Join-Path $fixture 'images');
        GatewayRoot = (Join-Path $fixture 'gateway'); Source = (Join-Path $fixture 'source'); Account = 'Synthetic\AI'; Sid = 'S-1-5-21-111' }
    [void](New-Item -ItemType Directory -Path $script:Context.Source)
    foreach ($name in @('activity_image_worker.py', 'activity_image_engine.py', 'run-activity-images.py', 'activity_image_layouts.py', 'Setup-Gateway.ps1', 'Setup-ActivityImages.ps1')) {
        [IO.File]::WriteAllText((Join-Path $script:Context.Source $name), ('# synthetic ' + $name))
    }
    $python = Join-Path $script:Context.ImageRoot 'runtime/ComfyUI_windows_portable/python_embeded/python.exe'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($python))
    [IO.File]::WriteAllText($python, 'synthetic executable')
    $sources = Get-SkaoActivityMediaSources -Context $script:Context
    Assert-MediaTrue ($sources.id -match '^[a-f0-9]{64}$' -and $sources.files.Count -eq 4) 'worker package pins exactly four companions'
    $receipt = Get-SkaoActivityMediaReceipt -Context $script:Context -Sources $sources
    $token = 'a' * 43
    $config = Get-SkaoActivityMediaConfiguration -Context $script:Context -Token $token
    Assert-MediaTrue (($config.PSObject.Properties.Name -join ',') -ceq 'version,token,imageRoot,workerRoot') 'worker configuration has only the supported fields'
    $launcher = Get-SkaoActivityMediaLauncher -Sources $sources
    Assert-MediaTrue ($launcher -match '\\python_embeded\\python.exe" -s ' -and $launcher -match '--config "%~dp0config.json"' -and $launcher -notmatch $token -and $launcher -notmatch 'main.py|--listen') 'launcher starts only the private controller without a command-line token or ComfyUI'
    Assert-SkaoActivityMediaObject -Actual (Copy-MediaObject $receipt) -Expected $receipt
    $script:Checks++
    foreach ($change in @(
        { $changed.version = 2 }, { $changed.version = '1' }, { $changed.token = 'b' * 43 },
        { $changed.imageRoot = 'other' }, { $changed.workerRoot = 'other' },
        { $changed | Add-Member NoteProperty extra 'unexpected' }
    )) {
        $changed = Copy-MediaObject $config; & $change
        Assert-MediaThrows { Assert-SkaoActivityMediaObject -Actual $changed -Expected $config } 'AI_MEDIA_CONFLICT:*' 'changed worker configuration is refused'
    }
    $status = [pscustomobject]@{ enabled = $true; available = $true; busy = $false; model = 'sd_xl_base_1.0.safetensors'; version = 1 }
    Assert-SkaoActivityMediaStatus $status; $script:Checks++
    $status.busy = $true; Assert-SkaoActivityMediaStatus $status; $script:Checks++
    foreach ($change in @(
        { $changed.version = '1' }, { $changed.version = $true }, { $changed.version = 2 },
        { $changed.enabled = $false }, { $changed.available = $false }, { $changed.available = 'True' },
        { $changed.busy = 'False' }, { $changed.model = 'other' }
    )) {
        $changed = Copy-MediaObject $status; & $change
        Assert-MediaThrows { Assert-SkaoActivityMediaStatus $changed } 'AI_MEDIA_STATUS:*' 'invalid worker status is refused'
    }
    $launcherPath = Join-Path $script:Context.Root 'Run-ActivityMedia.cmd'
    $script:Task = [pscustomobject]@{
        TaskPath = '\'; State = 'Running'
        Principal = [pscustomobject]@{ UserId = $script:Context.Sid; LogonType = 'Password'; RunLevel = 'Limited' }
        Actions = @([pscustomobject]@{ Execute = (Join-Path $env:SystemRoot 'System32/cmd.exe'); Arguments = ('/d /c ""{0}""' -f $launcherPath); WorkingDirectory = $script:Context.Root })
        Triggers = @([pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskBootTrigger' }; Delay = 'PT60S'; Enabled = $true })
        Settings = [pscustomobject]@{ Priority = 7; MultipleInstances = 'IgnoreNew'; RestartCount = 3; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S'; Enabled = $true; DisallowStartIfOnBatteries = $false; StopIfGoingOnBatteries = $false }
    }
    Assert-SkaoActivityMediaTask -Task $script:Task -Context $script:Context; $script:Checks++
    $minuteTask = Copy-MediaObject $script:Task; $minuteTask.Triggers[0].Delay = 'PT1M'
    Assert-SkaoActivityMediaTask -Task $minuteTask -Context $script:Context; $script:Checks++
    foreach ($change in @(
        { $changed.Principal.UserId = 'S-1-5-21-999' }, { $changed.Principal.LogonType = 'Interactive' },
        { $changed.Principal.RunLevel = 'Highest' }, { $changed.Actions[0].Execute = 'other.exe' },
        { $changed.Actions[0].Arguments = '/c arbitrary' }, { $changed.Actions[0].WorkingDirectory = 'other' },
        { $changed.Triggers[0].Delay = 'PT0S' }, { $changed.Triggers[0].Enabled = $false },
        { $changed.Settings.Priority = 4 }, { $changed.Settings.MultipleInstances = 'Parallel' },
        { $changed.Settings.RestartCount = 0 }, { $changed.Settings.RestartInterval = 'PT2M' },
        { $changed.Settings.ExecutionTimeLimit = 'PT1H' }, { $changed.Settings.Enabled = $false },
        { $changed.Settings.DisallowStartIfOnBatteries = $true }, { $changed.Settings.StopIfGoingOnBatteries = $true },
        { $changed.State = 'Disabled' }
    )) {
        $changed = Copy-MediaObject $script:Task; & $change
        Assert-MediaThrows { Assert-SkaoActivityMediaTask -Task $changed -Context $script:Context } 'AI_MEDIA_TASK_CONFLICT:*' 'foreign or weakened task definition is preserved and refused'
    }

    # Production raw-rule validator with synthetic Windows filter objects.
    $script:Rule = [pscustomobject]@{ Enabled = 'True'; Direction = 'Inbound'; Action = 'Block'; Profile = 'Any' }
    $script:Address = [pscustomobject]@{ LocalAddress = 'Any'; RemoteAddress = 'Any' }
    $script:Port = [pscustomobject]@{ Protocol = 'TCP'; LocalPort = '11435'; RemotePort = 'Any' }
    $script:App = [pscustomobject]@{ Program = 'Any'; Package = 'Any' }
    $script:Service = [pscustomobject]@{ Service = 'Any' }
    $script:Interface = [pscustomobject]@{ InterfaceAlias = 'Any' }
    $script:InterfaceType = [pscustomobject]@{ InterfaceType = 'Any' }
    $script:Security = [pscustomobject]@{ Authentication = 'NotRequired'; Encryption = 'NotRequired'; OverrideBlockRules = 'False'; LocalUser = 'Any'; RemoteUser = 'Any'; RemoteMachine = 'Any' }
    function Get-NetFirewallRule { [CmdletBinding()]param($PolicyStore, $Name) return $script:Rule }
    function Get-NetFirewallAddressFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:Address } }
    function Get-NetFirewallPortFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:Port } }
    function Get-NetFirewallApplicationFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:App } }
    function Get-NetFirewallServiceFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:Service } }
    function Get-NetFirewallInterfaceFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:Interface } }
    function Get-NetFirewallInterfaceTypeFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:InterfaceType } }
    function Get-NetFirewallSecurityFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { $script:Security } }
    Assert-SkaoActivityMediaRawRule -Name 'synthetic' -Port '11435'; $script:Checks++
# Windows reports unrestricted package filters as null on the AI laptop.
$script:App.Package = $null
Assert-SkaoActivityMediaRawRule -Name 'synthetic' -Port '11435'
Assert-MediaTrue $true 'native null package filter accepted'
$script:Port.LocalPort = '8188'
Assert-SkaoActivityMediaRawRule -Name 'synthetic' -Port '8188'
Assert-MediaTrue $true 'native null package accepted for second raw image port'
$script:Port.LocalPort = '11435'

foreach ($invalidPackage in @('', ' ', 'S-1-15-2-12345', 'S-1-0-0', 'S-1-15-2-1', 0, $false, @('Any'), @('Any', 'other'), [pscustomobject]@{ Value = 'Any' })) {
    $script:App.Package = $invalidPackage
    Assert-MediaThrows { Assert-SkaoActivityMediaRawRule -Name 'synthetic' -Port '11435' } 'AI_MEDIA_FIREWALL:*' 'malformed or restricted package filter refused'
}
$script:App = [pscustomobject]@{ Program = $script:App.Program }
Assert-MediaThrows { Assert-SkaoActivityMediaRawRule -Name 'synthetic' -Port '11435' } 'AI_MEDIA_FIREWALL:*' 'missing package property refused'
$script:App | Add-Member NoteProperty Package 'Any'
Assert-SkaoActivityMediaRawRule -Name 'synthetic' -Port '11435'
Assert-MediaTrue $true 'literal Any package filter remains accepted'

    foreach ($field in @(
        @('Rule','Enabled','False'), @('Rule','Action','Allow'), @('Rule','Profile','Private'), @('Rule','Direction','Outbound'),
        @('Address','LocalAddress','127.0.0.1'), @('Address','RemoteAddress','LocalSubnet'),
        @('Port','Protocol','UDP'), @('Port','LocalPort','8443'), @('Port','RemotePort','443'),
        @('App','Program','other.exe'), @('App','Package','other'), @('Service','Service','other'),
        @('Interface','InterfaceAlias','other'), @('InterfaceType','InterfaceType','Wireless'),
        @('Security','Authentication','Required'), @('Security','OverrideBlockRules','True'), @('Security','RemoteUser','other')
    )) {
        $object = Get-Variable -Name $field[0] -Scope Script -ValueOnly; $old = $object.($field[1]); $object.($field[1]) = $field[2]
        Assert-MediaThrows { Assert-SkaoActivityMediaRawRule -Name 'synthetic' -Port '11435' } 'AI_MEDIA_FIREWALL:*' 'weakened raw-port firewall rule is refused'
        $object.($field[1]) = $old
    }

    # Fresh/adoption flow uses real private files/metadata and mocks only native Windows boundaries.
    $script:ChildCalls = @(); $script:TaskPresent = $false; $script:RulesPresent = $false
    $script:RootAclWrites = 0; $script:Registrations = 0; $script:Starts = 0; $script:Readiness = 0; $script:RuleWrites = 0
    $script:WorkerReady = $true
    function Get-SkaoActivityMediaContext { return $script:Context }
    function Assert-SkaoActivityMediaAcl { param($Path, $Sid, [switch]$Protected) }
    function Set-SkaoActivityMediaRootAcl { param($Path, $Sid) $script:RootAclWrites++ }
    function Assert-SkaoActivityMediaAdministrator { }
    function Get-SkaoActivityMediaToken { param($Context) return ('a' * 43) }
    function Invoke-SkaoActivityMediaChild {
        param($Script, $Options)
        $script:ChildCalls += [pscustomobject]@{ Name = [IO.Path]::GetFileName($Script); Options = $Options.Clone() }
    }
    function Get-ScheduledTask {
        [CmdletBinding()]param($TaskName, $TaskPath)
        if ($script:TaskPresent) { return $script:Task }
    }
    function Register-SkaoActivityMediaTask { param($Context) $script:Registrations++; $script:TaskPresent = $true; $script:Task.State = 'Ready' }
    function Start-ScheduledTask { [CmdletBinding()]param($TaskName, $TaskPath) $script:Starts++; $script:Task.State = 'Running' }
    function Get-NetFirewallRule {
        [CmdletBinding()]param($PolicyStore, $Name)
        if ($script:RulesPresent) { return [pscustomobject]@{ Name = $Name } }
    }
    function Assert-SkaoActivityMediaRawRule { param($Name, $Port) }
    function Ensure-SkaoActivityMediaRawRules {
        param([switch]$Check)
        if (!$script:RulesPresent) {
            if ($Check) { throw 'AI_MEDIA_FIREWALL: synthetic missing rules' }
            $script:RuleWrites++; $script:RulesPresent = $true
        }
    }
    function Wait-SkaoActivityMediaReady {
        param($Token, [switch]$Check)
        $script:Readiness++
        if (!$script:WorkerReady) { throw 'AI_MEDIA_STATUS: synthetic worker unavailable' }
    }
    Assert-MediaThrows { Invoke-SkaoActivityMediaSetup -Check } 'AI_MEDIA_MISSING:*' 'check does not create missing worker state'
    Assert-MediaTrue (!(Test-Path -LiteralPath $script:Context.Root) -and $script:Registrations -eq 0 -and $script:RuleWrites -eq 0 -and $script:Starts -eq 0) 'check creates no files task rules or process'
    Invoke-SkaoActivityMediaSetup | Out-Null
    Assert-MediaTrue ($script:Registrations -eq 1 -and $script:Starts -eq 1 -and $script:RootAclWrites -eq 1 -and $script:RuleWrites -eq 1) 'fresh setup creates only its managed root task and raw blocks'
    Assert-MediaTrue ((Test-Path -LiteralPath (Join-Path $script:Context.Root 'jobs')) -and (Test-Path -LiteralPath (Join-Path $script:Context.Root 'logs'))) 'fresh setup prepares separate private worker state'
    Assert-MediaTrue ($script:ChildCalls[-1].Name -ceq 'Setup-Gateway.ps1' -and $script:ChildCalls[-1].Options.ActivityImages -eq $true -and !$script:ChildCalls[-1].Options.Check) 'gateway routes are enabled only after worker setup/readiness'
    $before = Get-MediaTree $script:Context.Root
    $script:ChildCalls = @()
    Invoke-SkaoActivityMediaSetup -Check | Out-Null
    Invoke-SkaoActivityMediaSetup | Out-Null
    Assert-MediaTrue ((Get-MediaTree $script:Context.Root) -ceq $before) 'check and adoption preserve every worker file'
    Assert-MediaTrue ($script:Registrations -eq 1 -and $script:Starts -eq 1 -and $script:RootAclWrites -eq 1 -and $script:RuleWrites -eq 1) 'adoption asks no password and rewrites no task ACL or firewall rule'
    $imageChecks = @($script:ChildCalls | Where-Object { $_.Name -ceq 'Setup-ActivityImages.ps1' })
    Assert-MediaTrue ($imageChecks.Count -eq 2 -and $imageChecks[0].Options.Check -eq $true -and $imageChecks[0].Options.CompareSDXL -eq $true -and !$imageChecks[0].Options.TestGeneration) 'image prerequisites are checked without installation or inference'
    $gatewayChecks = @($script:ChildCalls | Where-Object { $_.Name -ceq 'Setup-Gateway.ps1' -and $_.Options.ActivityImages -eq $true })
    Assert-MediaTrue ($gatewayChecks[0].Options.Check -eq $true) 'check verifies image routes without requesting gateway migration'
    $script:Task.State = 'Ready'
    $startsBeforeRestart = $script:Starts
    Assert-MediaThrows { Invoke-SkaoActivityMediaSetup -Check } 'AI_MEDIA_NOT_RUNNING:*' 'check leaves a stopped task stopped'
    Assert-MediaTrue ($script:Starts -eq $startsBeforeRestart) 'check starts no task'
    Invoke-SkaoActivityMediaSetup | Out-Null
    Assert-MediaTrue ($script:Starts -eq $startsBeforeRestart + 1 -and $script:Registrations -eq 1) 'normal setup starts a validated task without replacing credentials'
    $script:WorkerReady = $false; $script:ChildCalls = @()
    Assert-MediaThrows { Invoke-SkaoActivityMediaSetup } 'AI_MEDIA_STATUS:*' 'worker readiness failure stops setup'
    Assert-MediaTrue (@($script:ChildCalls | Where-Object { $_.Options.ActivityImages -eq $true }).Count -eq 0) 'unready worker never changes gateway routes'
    Assert-MediaTrue ((Get-MediaTree $script:Context.Root) -ceq $before) 'readiness failure preserves all installed worker state'
    $script:WorkerReady = $true
    $configPath = Join-Path $script:Context.Root 'config.json'
    $configBytes = [IO.File]::ReadAllBytes($configPath)
    $changedConfig = Read-SkaoActivityMediaJson $configPath; $changedConfig.token = 'b' * 43
    [IO.File]::WriteAllText($configPath, ($changedConfig | ConvertTo-Json))
    $foreign = Get-MediaTree $script:Context.Root
    Assert-MediaThrows { Invoke-SkaoActivityMediaSetup } 'AI_MEDIA_CONFLICT:*' 'foreign worker configuration is never overwritten'
    Assert-MediaTrue ((Get-MediaTree $script:Context.Root) -ceq $foreign) 'foreign worker token remains untouched'
    [IO.File]::WriteAllBytes($configPath, $configBytes)
    $workerPath = Join-Path $script:Context.Root ('code/' + $sources.id + '/activity_image_worker.py')
    [IO.File]::AppendAllText($workerPath, 'unexpected')
    $foreign = Get-MediaTree $script:Context.Root
    Assert-MediaThrows { Invoke-SkaoActivityMediaSetup -Check } 'AI_MEDIA_CONFLICT:*' 'changed worker code is not adopted'
    Assert-MediaTrue ((Get-MediaTree $script:Context.Root) -ceq $foreign) 'changed worker code is preserved'
    [IO.File]::WriteAllText($workerPath, '# synthetic activity_image_worker.py')
    [IO.File]::AppendAllText((Join-Path $script:Context.Source 'activity_image_engine.py'), 'updated package')
    $foreign = Get-MediaTree $script:Context.Root
    Assert-MediaThrows { Invoke-SkaoActivityMediaSetup } 'AI_MEDIA_CONFLICT:*' 'new package identity requires an explicit reviewed migration'
    Assert-MediaTrue ((Get-MediaTree $script:Context.Root) -ceq $foreign) 'package drift preserves the installed worker'
}
finally {
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
    if ($null -eq $oldSystemRoot) { Remove-Item Env:SystemRoot -ErrorAction SilentlyContinue } else { $env:SystemRoot = $oldSystemRoot }
}
Write-Output ('PASS: ' + $script:Checks + ' managed activity media setup checks (synthetic fixtures; no native Windows deployment)')
