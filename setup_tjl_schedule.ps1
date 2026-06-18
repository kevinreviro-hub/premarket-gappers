# setup_tjl_schedule.ps1 — (re)install the TJL-Daily scheduled task. Idempotent.
#
# Fires HOURLY 21:00-03:00 Jakarta on weekdays (21:00 + every 1h x6) = the full US
# RTH session 10:00-16:00 ET in summer (EDT). Plus AtLogon + on-unlock triggers and
# StartWhenAvailable for catch-up if the laptop was asleep at an hour's fire time.
# The scanner (tjl_scanner.mjs --scheduled) is the source of truth: it enforces
# weekday + 10:00-16:00 ET gate + once-per-HOUR, and only posts to Slack on an
# actual scan (gate-skips are silent). Does NOT wake the machine. (In winter/EST
# the 21:00 Jkt slot = 09:00 ET premarket and simply gate-skips.)

$ErrorActionPreference = 'Stop'
$TaskName = 'TJL-Daily'
$repo = 'C:\Users\kevin\tradingview-mcp'
$vbs  = Join-Path $repo 'run_tjl_hidden.vbs'
$me   = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $repo

$at  = '9:00PM'
$t1  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $at
$rep = (New-ScheduledTaskTrigger -Once -At $at `
        -RepetitionInterval (New-TimeSpan -Hours 1) `
        -RepetitionDuration (New-TimeSpan -Hours 6)).Repetition   # 21:00 + hourly x6 => 21,22,23,00,01,02,03
$t1.Repetition = $rep
$t2 = New-ScheduledTaskTrigger -AtLogOn -User $me
# on workstation unlock — catch-up when you open/unlock the laptop later that morning
$cls = Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskSessionStateChangeTrigger
$t3 = New-CimInstance -CimClass $cls -ClientOnly
$t3.StateChange = 8        # TASK_SESSION_UNLOCK
$t3.UserId = $me
$t3.Enabled = $true

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# 2h limit: brute-force scan of all ~976 Pluang tickers runs ~1-1.5h.
# WakeToRun left FALSE on purpose: do not wake the laptop.

$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "removed existing task"
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1, $t2, $t3) -Settings $settings -Principal $principal `
  -Description 'Pluang Research Long Scanner: HOURLY 21:00-03:00 Jakarta (=10:00-16:00 ET, US open..close) weekdays + logon/unlock catch-up, posts to #investment-research-hackathon. Scanner enforces weekday + 10:00-16:00 ET gate + once/hour. Does not wake the machine.' | Out-Null
Write-Output "registered: $TaskName"
