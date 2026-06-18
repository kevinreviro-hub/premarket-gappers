# setup_tjl_schedule.ps1 — (re)install the TJL-Daily scheduled task. Idempotent.
#
# Fires 9:00 PM Jakarta (= 10:00 AM ET, US open) on weekdays, then repeats every
# 15 min for 6h30m so a poke lands across the NY 10:00-15:30 ET window in BOTH
# DST regimes (EDT 21:00-02:30 Jkt, EST 22:00-03:30 Jkt) — survives DST untouched.
# Plus an AtLogon trigger + StartWhenAvailable for catch-up if the laptop was
# asleep at fire time. The scanner (tjl_scanner.mjs --scheduled) is the source of
# truth: it enforces weekday + 10:00-15:30 ET gate + once-per-day, and only posts
# to Slack on an actual scan (gate-skips are silent). Does NOT wake the machine.

$ErrorActionPreference = 'Stop'
$TaskName = 'TJL-Daily'
$repo = 'C:\Users\kevin\tradingview-mcp'
$vbs  = Join-Path $repo 'run_tjl_hidden.vbs'
$me   = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $repo

$at  = '9:00PM'
$t1  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $at
$rep = (New-ScheduledTaskTrigger -Once -At $at `
        -RepetitionInterval (New-TimeSpan -Minutes 15) `
        -RepetitionDuration (New-TimeSpan -Hours 6 -Minutes 30)).Repetition
$t1.Repetition = $rep
$t2 = New-ScheduledTaskTrigger -AtLogOn -User $me

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# WakeToRun left FALSE on purpose: do not wake the laptop.

$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "removed existing task"
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1, $t2) -Settings $settings -Principal $principal `
  -Description 'TJL Long scanner: 21:00 Jakarta (=10:00 ET open) weekdays, repeats through RTH for catch-up, posts to #investment-research-hackathon. Scanner enforces weekday + 10:00-15:30 ET gate + once/day. Does not wake the machine.' | Out-Null
Write-Output "registered: $TaskName"
