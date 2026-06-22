# ensure_tv_cdp.ps1 — make sure TradingView Desktop is up on CDP port 9222 before the
# TJL scan runs. If CDP already answers, do nothing. Otherwise (re)launch TradingView
# with --remote-debugging-port=9222 and wait up to ~40s for CDP to come up.
# TJL runs 21:00-03:00 Jakarta (late night) so a relaunch is non-disruptive.
$ErrorActionPreference = 'SilentlyContinue'
$port = 9222
function Up { try { $r = Invoke-WebRequest "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 3; return ($r.StatusCode -eq 200) } catch { return $false } }

if (Up) { Write-Output "$(Get-Date -Format s) | CDP already up"; exit 0 }

$exe = Resolve-Path "C:\Program Files\WindowsApps\TradingView.Desktop_*_x64__*\TradingView.exe" -ErrorAction SilentlyContinue | Select-Object -Last 1 -ExpandProperty Path
if (-not $exe) { $exe = "C:\Program Files\WindowsApps\TradingView.Desktop_3.2.0.7916_x64__n534cwy3pjxzj\TradingView.exe" }
if (-not (Test-Path $exe)) { Write-Output "$(Get-Date -Format s) | TradingView.exe not found at $exe"; exit 1 }

Get-Process TradingView -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process $exe -ArgumentList "--remote-debugging-port=$port"
for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Seconds 2; if (Up) { Write-Output "$(Get-Date -Format s) | CDP up after ~$(($i+1)*2)s"; exit 0 } }
Write-Output "$(Get-Date -Format s) | CDP did NOT come up in ~40s"; exit 1
