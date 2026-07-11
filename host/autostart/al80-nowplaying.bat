@echo off
REM Visible launcher for the AL80 always-on host — use this to see logs / debug.
REM (The hidden autostart uses run-nowplaying.vbs, which now targets cycle-run.mjs too.)
cd /d "%~dp0.."
echo Starting AL80 cycle host (Ctrl-C to stop)...
node cycle-run.mjs --live
echo.
echo Host exited. Press any key to close.
pause >nul
