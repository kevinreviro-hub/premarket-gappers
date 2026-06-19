@echo off
rem Scheduled BOW scan (once-per-US-day guarded). Invoked hidden by run_bow_hidden.vbs.
cd /d "C:\Users\kevin\tradingview-mcp"
"C:\REVIRO\PLUANG\2026\APPS\NODE JS\node.exe" bow_scanner.mjs --scheduled >> bow_scan.log 2>&1
