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

**Always-on, no browser:** `node cycle-run.mjs --live` drives the LCD straight from Node with real
Spotify + real Open-Meteo — no browser tab needed. It reconnects on unplug/sleep on its own. To have
it start at logon and run hidden, see `autostart/README.md`. `nowplaying-run.mjs` / `weather-run.mjs`
still exist as thin single-panel debug launchers (equivalent to `cycle-run.mjs --only=<panel>`).

## Develop without the device
```
node demo.js                    # clock sequence -> validated -> PNGs in out/
node test/scheduler.test.mjs    # preemption logic + alert cards -> PNGs in out/
node test/roundtrip.test.mjs    # protocol builders reassemble byte-exact
```
The mock transport reassembles real packets into a framebuffer and writes PNGs, so app layout is
built and tested with no hardware.

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
apps          apps/clock.js  apps/weather.js  apps/nowplaying.js  apps/alert.js
lib           lib/render.js  lib/font.js  lib/diff.js  lib/scheduler.js  lib/png.js  lib/spotify.js  lib/weather.js  lib/art.js
control       control/local-hook.js  (127.0.0.1 intake)
hooks         hooks/al80-notify.mjs  (Claude Code hook)
cycle-run.mjs     the always-on host: loop + reconnect + scheduler + intake + panel rotation
nowplaying-run.mjs / weather-run.mjs   --only=<panel>-equivalent single-panel debug launchers
daemon.js / transport-hid.js           deprecated (folded into cycle-run.mjs); reference only
```
