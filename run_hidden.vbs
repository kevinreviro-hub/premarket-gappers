' run_hidden.vbs — launch the scheduler wrapper with NO console window.
' Used by the PremarketGappers scheduled task so bash doesn't flash a window
' on every poke. Waits for completion so Task Scheduler tracks the real result.
Option Explicit
Dim sh, cmd
Set sh = CreateObject("WScript.Shell")
cmd = """C:\REVIRO\PLUANG\2026\GITHUB\Git\usr\bin\bash.exe"" -l -c ""/c/Users/kevin/tradingview-mcp/run_gappers_scheduled.sh"""
' 0 = hidden window, True = wait for bash to finish
sh.Run cmd, 0, True
