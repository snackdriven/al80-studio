# al80-host

Always-on host for the AL80 LCD. Drives the keyboard's screen from Node (no browser), with a
pluggable app model, a preemptive alert scheduler, and a local intake endpoint. Reuses
`../src/protocol.js` verbatim. Plan + rationale: `al80-lcd/research/al80-always-on-host-SPARC.md`
and `al80-nowplaying-webhooks-SPARC.md`.

## Run
```
npm install                 # node-hid (prebuilt) + (later) @napi-rs/canvas
node cycle-run.mjs          # the always-on host: rotates clock/weather/now-playing, accepts alerts
node cycle-run.mjs --only=nowplaying   # single-panel debug (also: --only=weather, --only=clock)
```
`cycle-run.mjs` owns the `0xFF60/0x61` interface — close any browser tab / vendor app first (single
opener: ONE always-on host, not one process per panel). `daemon.js` was the M1 prototype for the
loop/reconnect/scheduler/intake pattern; that's folded into `cycle-run.mjs` now and daemon.js is
deprecated (kept for reference, nothing launches it).

**Panel auto-cycle, always-on (recommended):** `node cycle-run.mjs --live` is the superset — ONE
process owns the screen and rotates now-playing / weather / clock on a dwell timer, dropping panels
with no data, jumping to now-playing on a track change, and preempting to an alert card. See "Panel
cycler" below.

**Single-panel debug launchers:** `node nowplaying-run.mjs --live` / `node weather-run.mjs --live`
drive the LCD with just one panel — handy for isolating a data source, but they can't run at the
same time as each other or `cycle-run.mjs` (single opener — see `device.js`). Same reconnect-on-
unplug behavior as the cycler. To have the always-on host start at logon and run hidden, see
`autostart/README.md`.

## Panel cycler (`cycle.js` + `cycle-run.mjs`)
`cycle-run.mjs` is the launcher: it owns the one `Device`, builds the configured panels, wires the
alert scheduler + `control/local-hook.js` intake, and drives `cycle.js`'s `tick(now)` on a timer.
`cycle.js` is the FSM: a pure(ish) step function that owns the `committed` invariant ("our card is
the displayed picture slot") and every transition (picture<->picture delete-before-add, home<->
picture, alert preemption/resume). All device I/O lives inside `tick()`/its callees — panels never
touch `dev`.
```
node cycle-run.mjs                  MOCK now-playing + MOCK weather + real screen
node cycle-run.mjs --live           real Spotify + real Open-Meteo + real screen
node cycle-run.mjs --live --sync    also tint the RGB to the on-screen panel's accent color
node cycle-run.mjs --mock-device    dry run, no hardware (logs packet counts)
node cycle-run.mjs --mode=roundrobin   fixed rotation, no smart rules (debug/demo)
```
Config is env (all optional): `CYCLE_PANELS=nowplaying,weather,clock` `CYCLE_MODE=smart|roundrobin`
`CYCLE_DWELL_MS=15000` (floored 8000) `CYCLE_DWELL_NOWPLAYING=30000` `CYCLE_NP_FOCUS_ON_CHANGE=1`
`CYCLE_WEATHER_STALE_MS=2400000` `CYCLE_TICK_MS=500` `CYCLE_SYNC_RGB=0` `CYCLE_ALERT_PORT=7333` —
plus the unchanged `SPOTIFY_*` / `WEATHER_*` read by the panels themselves.

Panels (`panels/nowplaying.js`, `panels/weather.js`, `panels/clock.js`) each poll their own data
source on their OWN cadence (Spotify 5s, weather 10min, clock never — native home page), decoupled
from the cycler's dwell; the dwell only chooses which cached frame to display next. A panel's
`jumpTo(panelId)` on the cycler forces an immediate switch (used by the hotkey-panel-switch feature)
— alerts still preempt it.

## Develop without the device
```
node demo.js                    # clock sequence -> validated -> PNGs in out/
node --test                     # every device-free test (scheduler, roundtrip, cycle FSM, weather, nowplaying)
node test/cycle.test.mjs        # the panel-rotation FSM alone: transitions, ring net-zero, skip/focus/alert/reopen, frame correctness
```
The mock transport (and the cycle FSM's `RecordingDevice`) reassemble real packets into a
framebuffer and write PNGs, so app layout AND the rotation logic are built and tested with no
hardware.

## Alerts
`cycle-run.mjs` listens on `http://127.0.0.1:7333`:
```
curl -XPOST 127.0.0.1:7333/alert -d '{"title":"SITE DOWN","body":"snackdriven.com","level":"error"}'
curl -XPOST 127.0.0.1:7333/ack           # dismiss the top sticky alert
curl 127.0.0.1:7333/status
```
Levels: `info` `warn` `error` `ok`. `error`/`warn` are sticky by default (ack to clear); others
auto-expire. Internet-origin webhooks arrive via ntfy (see the SPARC doc); local/terminal events
POST here directly.

## Claude-needs-you notifier
`hooks/al80-notify.mjs` fires a "Claude needs you" card when Claude Code needs attention. Register it
in `~/.claude/settings.json`:
```json
{ "hooks": { "Notification": [{ "hooks": [{ "type": "command",
  "command": "node C:/Users/bette/al80-studio/host/hooks/al80-notify.mjs" }] }] } }
```
It POSTs to the local daemon and always exits 0 fast — a stopped daemon never blocks Claude.

## Layout
```
protocol      ../src/protocol.js        (shared with the browser app)
transport     device.js  (node-hid, real, anti-banding)   transport-mock.js  (reassemble->PNG)
device.js     the single-opener Device — every real HID write, ACK-gated + settle-timed
cycle.js      the panel-rotation FSM: tick(now), showPanel, jumpTo, the `committed` invariant
cycle-run.mjs the always-on launcher: owns Device+Scheduler+local-hook, drives cycle.js on a timer
panels        panels/nowplaying.js  panels/weather.js  panels/clock.js  (Panel interface: poll/available/stale/render)
apps          apps/clock.js  apps/alert.js  apps/nowplaying.js  apps/weather.js  (pure render, no I/O)
lib           lib/render.js  lib/font.js  lib/diff.js  lib/scheduler.js  lib/png.js  lib/spotify.js  lib/weather.js  lib/art.js
control       control/local-hook.js  (127.0.0.1 intake)
hooks         hooks/al80-notify.mjs  (Claude Code hook)
nowplaying-run.mjs / weather-run.mjs   thin single-panel debug launchers over panels/ (Phase 0)
daemon.js / transport-hid.js           deprecated (folded into cycle-run.mjs); reference only
test/recording-device.js   device-free Device stand-in for cycle.test.mjs (ops[] + MockTransport + fault injection)
```
