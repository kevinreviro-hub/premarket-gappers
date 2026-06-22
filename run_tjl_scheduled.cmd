@echo off
rem Scheduled TJL scan (once-per-hour guarded). Invoked hidden by run_tjl_hidden.vbs.
cd /d "C:\Users\kevin\tradingview-mcp"
rem TJL reads the live TradingView chart over CDP, so make sure the app is up on 9222 first.
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\kevin\tradingview-mcp\ensure_tv_cdp.ps1" >> tjl_scan.log 2>&1
"C:\REVIRO\PLUANG\2026\APPS\NODE JS\node.exe" tjl_scanner.mjs --scheduled >> tjl_scan.log 2>&1
