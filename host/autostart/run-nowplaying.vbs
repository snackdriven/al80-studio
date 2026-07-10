' Launch the AL80 now-playing bridge with NO console window.
' Runs:  node <host>\nowplaying-run.mjs --live   from the host/ directory.
' Used by install-task.ps1 (Task Scheduler) and works as a shell:startup shortcut too.
Option Explicit
Dim fso, sh, scriptDir, hostDir, nodeArgs
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName) ' ...\host\autostart
hostDir   = fso.GetParentFolderName(scriptDir)              ' ...\host
sh.CurrentDirectory = hostDir

' --live drives real Spotify; drop it (or pass no args) to run the mock track for a smoke test.
nodeArgs = "node """ & hostDir & "\nowplaying-run.mjs"" --live"

' 0 = hidden window, False = don't wait. Node keeps running headless after this script exits.
sh.Run nodeArgs, 0, False
