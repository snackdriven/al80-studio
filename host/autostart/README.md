# Running the always-on host without a browser

`cycle-run.mjs` already drives the LCD from Node — no `al80-studio` tab, no browser at all. It's
the **single opener**: one always-on host that rotates clock / weather / now-playing and hosts the
local alert intake (127.0.0.1:7333), instead of separate single-panel scripts fighting over the
keyboard. These launchers just let it start on its own so you never open a terminal either.

## One-time: Spotify creds

Live mode needs a refresh token in `host/.env`. Do this once:

```
node ../spotify-auth.mjs <your-spotify-client-id>
```

Approve in the browser it opens; it writes `host/.env` (gitignored). After that the browser is
never needed again. Test with no creds using mock mode: `node ../cycle-run.mjs`.

## Launchers

- `run-nowplaying.vbs` — starts `node cycle-run.mjs --live` with **no window** (headless). (Name is
  historical — from before autostart unification, when it only launched the now-playing panel.)
- `al80-nowplaying.bat` — same, but **visible** so you can watch logs / debug.

Double-click either to run right now. The host reconnects on its own if the keyboard is unplugged
or the machine sleeps, so it survives being left running.

## Debugging a single panel

`nowplaying-run.mjs` and `weather-run.mjs` still exist as single-panel debug launchers — they're
equivalent to `cycle-run.mjs --only=nowplaying` / `--only=weather` for watching one panel's logs in
isolation without the rotation getting in the way. They are NOT what autostart launches anymore.
`daemon.js` / `transport-hid.js` are deprecated (their always-on-loop + alert-intake role folded
into `cycle-run.mjs`) — nothing launches them; they're kept for reference only.

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
  -Settings $settings -Description 'AL80 LCD cycle host (clock/weather/now-playing), headless.' -Force
```

Remove it later with `Unregister-ScheduledTask -TaskName 'AL80 Now-Playing'`.

## Notes

- Single opener: close the `al80-studio` tab / usevia before running — one app owns the raw-HID
  interface at a time.
- If the Spotify refresh token is ever revoked, the bridge exits (a restart won't fix a dead
  token). Re-auth with `node ../spotify-auth.mjs <client-id>`.
