' run_bow_hidden.vbs — launch the scheduled BOW scan with NO console window.
' Used by the BOW-Daily scheduled task so node doesn't flash a window.
Set sh = CreateObject("WScript.Shell")
' 0 = hidden, True = wait for completion (so Task Scheduler tracks the run)
sh.Run """C:\Users\kevin\tradingview-mcp\run_bow_scheduled.cmd""", 0, True
