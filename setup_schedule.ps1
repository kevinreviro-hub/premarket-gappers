# setup_schedule.ps1 — (re)install the PremarketGappers scheduled task.
# Idempotent: unregisters any existing task with the same name first.
# No admin required (runs as the current user, only when logged on).
#
# Timing: the scan must run at NY 08:30 (premarket), catch-up allowed until
# NY 09:30. This laptop is Jakarta (UTC+7) and does NOT observe DST, while New
# York does, so NY 08:30 lands at:
#     19:30 Jakarta during US EDT (Mar-Nov)
#     20:30 Jakarta during US EST (Nov-Mar)
# We fire at 19:25 Jakarta and repeat every 15 min for 2h15m (until 21:40) so a
# poke always lands inside the NY 08:30-09:30 window in either DST regime. The
# bash wrapper (run_gappers_scheduled.sh) is the source of truth: it computes
# real NY time via Python zoneinfo and enforces weekday + window + once/day.

$ErrorActionPreference = 'Stop'

$TaskName = 'PremarketGappers'
$repoWin  = 'C:\Users\kevin\tradingview-mcp'
$vbs      = Join-Path $repoWin 'run_hidden.vbs'
$me       = "$env:USERDOMAIN\$env:USERNAME"

# Action: wscript -> hidden vbs -> bash wrapper (no console flash)
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' `
  -Argument "`"$vbs`"" -WorkingDirectory $repoWin

# Trigger 1: weekdays at 7:25 PM Jakarta, repeating to cover the NY window
$at  = '7:25PM'
$t1  = New-ScheduledTaskTrigger -Weekly `
  -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $at
$rep = (New-ScheduledTaskTrigger -Once -At $at `
  -RepetitionInterval (New-TimeSpan -Minutes 15) `
  -RepetitionDuration (New-TimeSpan -Hours 2 -Minutes 15)).Repetition
$t1.Repetition = $rep

# Trigger 2: on logon (catches opening the laptop mid-window)
$t2 = New-ScheduledTaskTrigger -AtLogOn -User $me

# Settings: catch-up after a missed (asleep) start, never wake the machine,
# laptop-friendly battery behavior, one instance at a time, 15-min cap.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# (WakeToRun is left FALSE on purpose: do not wake the laptop.)

$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "removed existing task"
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1,$t2) `
  -Settings $settings -Principal $principal `
  -Description 'Premarket gappers scan. Fires ~NY 08:30 (Jakarta evening); guarded wrapper enforces NY 08:30-09:30 weekday window, once/day, catch-up on wake/logon. Does not wake the machine.' | Out-Null

Write-Output "registered: $TaskName"
