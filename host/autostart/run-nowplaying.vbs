' Launch the AL80 always-on host with NO console window.
' Runs:  node <host>\cycle-run.mjs --live   from the host/ directory.
' cycle-run.mjs is the superset host (rotates clock/weather/now-playing + hosts alert intake) —
' see "Autostart unification" in research/al80-buildout-flow-and-overnight-plan.md. This is the
' ONE always-on host; nowplaying-run.mjs / weather-run.mjs remain as --only=<panel> debug launchers.
' Used by install-task.ps1 (Task Scheduler) and works as a shell:startup shortcut too.
Option Explicit
Dim fso, sh, scriptDir, hostDir, nodeArgs
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName) ' ...\host\autostart
hostDir   = fso.GetParentFolderName(scriptDir)              ' ...\host
sh.CurrentDirectory = hostDir

' --live drives real Spotify + real Open-Meteo; drop it (or pass no args) to run mock data for a
' smoke test.
nodeArgs = "node """ & hostDir & "\cycle-run.mjs"" --live"

' 0 = hidden window, False = don't wait. Node keeps running headless after this script exits.
sh.Run nodeArgs, 0, False
