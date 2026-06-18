# toast.ps1 — show a transient Windows desktop notification (balloon tip).
# Used as the no-Slack fallback by run_gappers_scheduled.sh. Works on all
# Windows editions (incl. Home); NotifyIcon balloon avoids AppID/toast registration.
param(
  [Parameter(Mandatory = $true)][string]$Message,
  [string]$Title = "Premarket Gappers"
)
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $ni = New-Object System.Windows.Forms.NotifyIcon
  $ni.Icon = [System.Drawing.SystemIcons]::Information
  $ni.Visible = $true
  $ni.BalloonTipTitle = $Title
  $ni.BalloonTipText = $Message
  $ni.ShowBalloonTip(10000)
  Start-Sleep -Seconds 6
  $ni.Dispose()
} catch {
  exit 1
}
