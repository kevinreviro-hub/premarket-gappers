@echo off
rem Scheduled TJL scan (once-per-day guarded). Invoked hidden by run_tjl_hidden.vbs.
cd /d "C:\Users\kevin\tradingview-mcp"
"C:\REVIRO\PLUANG\2026\APPS\NODE JS\node.exe" tjl_scanner.mjs --scheduled >> tjl_scan.log 2>&1
