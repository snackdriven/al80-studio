@echo off
REM Visible launcher for the AL80 now-playing bridge — use this to see logs / debug.
REM (The hidden autostart uses run-nowplaying.vbs instead.)
cd /d "%~dp0.."
echo Starting AL80 now-playing bridge (Ctrl-C to stop)...
node nowplaying-run.mjs --live
echo.
echo Bridge exited. Press any key to close.
pause >nul
