param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")),
  [int]$Port = 47824
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$DataDirectory = Join-Path $ProjectRoot ".data"
$RunnerPath = Join-Path $DataDirectory "windows-taskboard-server.cmd"
$NodePath = (Get-Command node -ErrorAction Stop).Source
$TaskName = "Dashi Taskboard Server"

New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
$runner = @"
@echo off
set "CODEX_TASKBOARD_HOST=127.0.0.1"
set "CODEX_TASKBOARD_PORT=$Port"
cd /d "$ProjectRoot"
"$NodePath" "server\index.mjs" >> ".data\windows-taskboard-server.log" 2>&1
"@
Set-Content -Path $RunnerPath -Value $runner -Encoding ASCII

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/d /c `"$RunnerPath`"" -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -MultipleInstances Ignore -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Starts the local Dashi Taskboard service after Windows sign-in." -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Output "Installed and started: $TaskName"
Write-Output "Panel: http://127.0.0.1:$Port/?host=agent"
Write-Output "Log: $ProjectRoot\.data\windows-taskboard-server.log"
