# Running the now-playing bridge without a browser

`nowplaying-run.mjs` already drives the LCD from Node — no `al80-studio` tab, no browser at all.
These launchers just let it start on its own so you never open a terminal either.

## One-time: Spotify creds

Live mode needs a refresh token in `host/.env`. Do this once:

```
node ../spotify-auth.mjs <your-spotify-client-id>
```

Approve in the browser it opens; it writes `host/.env` (gitignored). After that the browser is
never needed again. Test with no creds using mock mode: `node ../nowplaying-run.mjs`.

## Launchers

- `run-nowplaying.vbs` — starts `node nowplaying-run.mjs --live` with **no window** (headless).
- `al80-nowplaying.bat` — same, but **visible** so you can watch logs / debug.

Double-click either to run right now. The bridge reconnects on its own if the keyboard is
unplugged or the machine sleeps, so it survives being left running.

## Start it automatically at logon (optional — your call)

Pick one. Both are things **you** run once; nothing here self-installs.

**A. Startup folder (simplest).** Press `Win+R`, type `shell:startup`, Enter, and drop a shortcut
to `run-nowplaying.vbs` in that folder. It launches hidden every logon.

**B. Task Scheduler (restarts if it dies).** Run in PowerShell, adjusting the path to where you
cloned the repo:

```powershell
$vbs = "C:\Users\bette\al80-studio\host\autostart\run-nowplaying.vbs"
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'AL80 Now-Playing' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'AL80 LCD Spotify now-playing, headless.' -Force
```

Remove it later with `Unregister-ScheduledTask -TaskName 'AL80 Now-Playing'`.

## Notes

- Single opener: close the `al80-studio` tab / usevia before running — one app owns the raw-HID
  interface at a time.
- If the Spotify refresh token is ever revoked, the bridge exits (a restart won't fix a dead
  token). Re-auth with `node ../spotify-auth.mjs <client-id>`.
