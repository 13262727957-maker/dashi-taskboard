param(
  [switch]$RemoveRunner
)

$ErrorActionPreference = "SilentlyContinue"
$TaskName = "Dashi Taskboard Server"
Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*windows-taskboard-broker.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
if ($RemoveRunner) {
  Remove-Item (Join-Path $PSScriptRoot "..\.data\windows-taskboard-server.cmd") -Force
}
Write-Output "Removed: $TaskName"
