' run_tjl_hidden.vbs — launch the scheduled TJL scan with NO console window.
' Used by the TJL-Daily scheduled task so node doesn't flash a window on every poke.
Set sh = CreateObject("WScript.Shell")
' 0 = hidden, True = wait for completion (so Task Scheduler tracks the run)
sh.Run """C:\Users\kevin\tradingview-mcp\run_tjl_scheduled.cmd""", 0, True
