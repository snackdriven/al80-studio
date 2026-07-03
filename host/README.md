# al80-host

Always-on host for the AL80 LCD. Drives the keyboard's screen from Node (no browser), with a
pluggable app model, a preemptive alert scheduler, and a local intake endpoint. Reuses
`../src/protocol.js` verbatim. Plan + rationale: `al80-lcd/research/al80-always-on-host-SPARC.md`
and `al80-nowplaying-webhooks-SPARC.md`.

## Run
```
npm install                 # node-hid (prebuilt) + (later) @napi-rs/canvas
node daemon.js              # connect, drive the clock, accept alerts (Ctrl-C to stop)
node daemon.js 8000         # run for 8s (bounded, for testing)
```
The daemon owns the `0xFF60/0x61` interface — close any browser tab / vendor app first (single opener).

## Develop without the device
```
node demo.js                    # clock sequence -> validated -> PNGs in out/
node test/scheduler.test.mjs    # preemption logic + alert cards -> PNGs in out/
node test/roundtrip.test.mjs    # protocol builders reassemble byte-exact
```
The mock transport reassembles real packets into a framebuffer and writes PNGs, so app layout is
built and tested with no hardware.

## Alerts
The daemon listens on `http://127.0.0.1:7333`:
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
transport     transport-hid.js  (node-hid, real)   transport-mock.js  (reassemble->PNG)
apps          apps/clock.js  apps/alert.js
lib           lib/render.js  lib/font.js  lib/diff.js  lib/scheduler.js  lib/png.js
control       control/local-hook.js  (127.0.0.1 intake)
hooks         hooks/al80-notify.mjs  (Claude Code hook)
daemon.js     loop + reconnect + echo watchdog + scheduler + intake
```
