# Running the always-on host

The end-to-end setup for `cycle-run.mjs` — the Node host that rotates now-playing / weather /
clock on the LCD, hosts the alert intake, and reconnects on its own. No browser, no reflash: this
runs over the existing firmware. For the launcher/autostart details see `autostart/README.md`.

Run it on the machine the AL80 is plugged into. Node 18+.

## 1. Install

    cd host
    npm install            # node-hid (prebuilt, no build tools needed)

## 2. Creds → host/.env

Spotify first, because `spotify-auth.mjs` **overwrites** `host/.env` when it writes the tokens.

    node spotify-auth.mjs <your-spotify-client-id>

Approve in the browser it opens. It writes `host/.env` with `SPOTIFY_CLIENT_ID` +
`SPOTIFY_REFRESH_TOKEN`. Client id comes from https://developer.spotify.com/dashboard.

Then add weather (and any cycle tuning) to that same `host/.env` — see `.env.example` for every
key and its default. Weather defaults to Detroit and needs no key, so the minimum is just the two
Spotify lines. Skipping Spotify is fine too: now-playing just drops out, weather + clock still run.

## 3. Smoke-test with no hardware

    node cycle-run.mjs --mock-device        # logs the rotation, opens no device
    node cycle-run.mjs --mock-device --only=weather   # one panel, for isolating a data source

## 4. Go live

Only one program can hold the keyboard at a time — close the YUNZII web app and VIA first.

    node cycle-run.mjs --live               # real Spotify + Open-Meteo + real screen
    node cycle-run.mjs --live --sync        # also tint the RGB to the on-screen panel's color

Unplug/replug and sleep/wake recover on their own.

## 5. Start it at logon (optional)

`autostart/run-nowplaying.vbs` launches `cycle-run.mjs --live` headless (no window);
`al80-nowplaying.bat` is the same but visible for watching logs. Double-click either to run now, or
drop the `.vbs` in `shell:startup` to have it start with Windows. Only that one launcher's target
changed — no scheduled task is registered.

## Alerts

While it's running, preempt the rotation with an alert card:

    curl -XPOST 127.0.0.1:7333/alert -d "{\"title\":\"SITE DOWN\",\"body\":\"snackdriven.com\",\"level\":\"error\"}"
    curl -XPOST 127.0.0.1:7333/ack     # dismiss the top sticky alert

`error`/`warn` stick until acked; `info`/`ok` auto-expire.

## What this does NOT set up

Hotkey→panel switching and per-key audio-reactive RGB need a firmware build with the matching
handlers, which isn't flashed yet — their host code is present but inert until then. Everything in
this runbook works on the firmware already on the board.
