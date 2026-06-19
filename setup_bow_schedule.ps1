# setup_bow_schedule.ps1 — (re)install the BOW-Daily scheduled task. Idempotent.
#
# Fires ONCE per weekday at 11:30 Jakarta (laptop local time). By 11:30 Jakarta the most
# recent US session has closed (16:00 ET = ~03:00-04:00 Jakarta), so the daily bar is
# final and the BOW watchlist is ready late-morning. Plus AtLogon + on-unlock triggers
# and StartWhenAvailable for catch-up if the laptop was asleep at 11:30. The scanner
# (bow_scanner.mjs --scheduled) enforces once-per-US-day via .bow_done_<ET-date>, so
# catch-up never double-posts. Does NOT wake the machine.

$ErrorActionPreference = 'Stop'
$TaskName = 'BOW-Daily'
$repo = 'C:\Users\kevin\tradingview-mcp'
$vbs  = Join-Path $repo 'run_bow_hidden.vbs'
$me   = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $repo

$at  = '11:30AM'
$t1  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $at
$t2  = New-ScheduledTaskTrigger -AtLogOn -User $me
# on workstation unlock — catch-up when you open/unlock the laptop later that day
$cls = Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskSessionStateChangeTrigger
$t3 = New-CimInstance -CimClass $cls -ClientOnly
$t3.StateChange = 8        # TASK_SESSION_UNLOCK
$t3.UserId = $me
$t3.Enabled = $true

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# 1h limit: ~500 Yahoo fetches (~1-2 min) + up to 15 Benzinga catalyst lookups via claude -p.
# WakeToRun left FALSE on purpose: do not wake the laptop.

$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "removed existing task"
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1, $t2, $t3) -Settings $settings -Principal $principal `
  -Description 'Pluang Research Buy on Weakness (BOW) Scanner: once per weekday at 11:30 Jakarta (after US close) + logon/unlock catch-up, posts to #investment-research-hackathon. Scanner enforces once-per-US-day via .bow_done marker. Does not wake the machine.' | Out-Null
Write-Output "registered: $TaskName (weekdays 11:30 Jakarta)"
