#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Setup-Ollama.ps1')
$script:Checks = 0
function Assert-True { param($Value,$Label) if (!$Value) { throw ('FAIL: '+$Label) }; $script:Checks++ }
function Assert-Throws { param([scriptblock]$Body,[string]$Prefix) $message=$null; try { & $Body | Out-Null } catch { $message=$_.Exception.Message }; Assert-True ($message -like ($Prefix+'*')) 'unexpected definition refused' }
function Resolve-SkaoTaskSid { param([string]$Identity) return $Identity }
$originalSystemRoot = $env:SystemRoot
if (!$env:SystemRoot) { $env:SystemRoot = '/synthetic/windows' }
try {
    $launcher = Join-Path ([IO.Path]::GetTempPath()) 'Synthetic-AI\Run-Ollama.cmd'
    $sid='S-1-5-21-111'
    function New-TaskFixture {
        return [pscustomobject]@{
            TaskPath='\'; State='Running'
            Principal=[pscustomobject]@{UserId=$sid;LogonType='Password';RunLevel='Limited'}
            Actions=@([pscustomobject]@{Execute=(Join-Path $env:SystemRoot 'System32\cmd.exe');Arguments=('/d /c "'+$launcher+'"')})
            Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskBootTrigger'};Delay='PT30S';Enabled=$true})
            Settings=[pscustomobject]@{Priority=7;MultipleInstances='IgnoreNew';ExecutionTimeLimit='PT0S';RestartCount=3;RestartInterval='PT1M';DisallowStartIfOnBatteries=$false;StopIfGoingOnBatteries=$false}
        }
    }
    $task = New-TaskFixture
    Assert-SkaoOllamaTaskDefinition -Task $task -Launcher $launcher -Sid $sid
    Assert-True $true 'known manual task accepted'
    $task.Actions[0].Arguments='/d /s /c ""'+$launcher+'""'
    Assert-SkaoOllamaTaskDefinition -Task $task -Launcher $launcher -Sid $sid
    Assert-True $true 'saved quoting variant accepted'
    foreach ($case in @('Principal','Logon','RunLevel','Execute','Arguments','ExtraAction','ExtraTrigger','TriggerType','Delay','Priority','MultipleInstances','TimeLimit','Restart','Battery','Disabled')) {
        $task = New-TaskFixture
        switch ($case) {
            'Principal' { $task.Principal.UserId='S-1-5-21-222' }
            'Logon' { $task.Principal.LogonType='Interactive' }
            'RunLevel' { $task.Principal.RunLevel='Highest' }
            'Execute' { $task.Actions[0].Execute=Join-Path $env:SystemRoot 'System32\powershell.exe' }
            'Arguments' { $task.Actions[0].Arguments += ' & echo extra' }
            'ExtraAction' { $task.Actions += $task.Actions[0] }
            'ExtraTrigger' { $task.Triggers += $task.Triggers[0] }
            'TriggerType' { $task.Triggers[0].CimClass.CimClassName='MSFT_TaskLogonTrigger' }
            'Delay' { $task.Triggers[0].Delay='PT0S' }
            'Priority' { $task.Settings.Priority=4 }
            'MultipleInstances' { $task.Settings.MultipleInstances='Parallel' }
            'TimeLimit' { $task.Settings.ExecutionTimeLimit='PT1H' }
            'Restart' { $task.Settings.RestartCount=0 }
            'Battery' { $task.Settings.StopIfGoingOnBatteries=$true }
            'Disabled' { $task.State='Disabled' }
        }
        Assert-Throws { Assert-SkaoOllamaTaskDefinition -Task $task -Launcher $launcher -Sid $sid } 'AI_TASK_CONFLICT:'
    }

    # Synthetic generation is explicit; it inspects GPU residency then always
    # unloads this exact test model, including on incomplete/malformed output.
    $script:Mode = 'success'; $script:Unloads=0; $script:Requests=0
    function Invoke-SkaoOllamaJson {
        param([string]$Path,$Body,[int]$TimeoutSeconds)
        if ($Path -eq '/api/ps') {
            $vram=3180247121; if($script:Mode -eq 'cpu'){$vram=1024}
            return [pscustomobject]@{models=@([pscustomobject]@{name=$script:SkaoOllamaModel;size=3180247121;size_vram=$vram})}
        }
        if ($Path -ne '/api/generate' -or $Body.model -cne $script:SkaoOllamaModel) { throw 'Unexpected request or model' }
        if ($Body.keep_alive -eq 0) { $script:Unloads++; return [pscustomobject]@{done=$true} }
        $script:Requests++
        Assert-True ($Body.think -ceq $false -and $Body.stream -ceq $false -and $Body.keep_alive -eq 30 -and $Body.options.num_predict -eq 32 -and $Body.options.num_thread -eq 2) 'bounded non-thinking synthetic request'
        $answer='Local AI is ready.'; $finish='stop'
        if ($script:Mode -eq 'wrong') { $answer='Unexpected synthetic output' }
        if ($script:Mode -eq 'length') { $finish='length' }
        return [pscustomobject]@{response=$answer;done_reason=$finish}
    }
    $result=Test-SkaoOllamaGeneration
    Assert-True ($result.Answer -ceq 'Local AI is ready.' -and $result.GPUBytes -eq $result.ModelBytes) 'synthetic GPU result'
    Assert-True ($script:Unloads -eq 1) 'successful synthetic test unloads'
    foreach($mode in @('wrong','length','cpu')) {
        $script:Mode=$mode
        $prefix='AI_GENERATION:'; if($mode -eq 'cpu'){$prefix='AI_GPU:'}
        Assert-Throws { Test-SkaoOllamaGeneration } $prefix
    }
    Assert-True ($script:Requests -eq 4 -and $script:Unloads -eq 4) 'every failed test unloads only its own model'
}
finally { $env:SystemRoot = $originalSystemRoot }
Write-Output ('PASS: '+$script:Checks+' Ollama task/generation checks')
