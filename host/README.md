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

**Spotify now-playing, always-on:** `node nowplaying-run.mjs --live` drives the LCD with album art
straight from Node — no browser tab needed. It reconnects on unplug/sleep on its own. To have it
start at logon and run hidden, see `autostart/README.md`.

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
panel-request.js  hotkey->panel HOST reader/router (see below)
daemon.js     loop + reconnect + echo watchdog + scheduler + intake
```

## Hotkey → panel (host half)
`device.js` decodes an inbound `0x4B` report (unsolicited keyboard→host raw-HID, sent by the
firmware half of `research/al80-hotkey-panel-switch-SPARC.md` on a bound key's press-edge — not built
yet as of this doc) and re-emits it as a `'panelRequest'` event. `panel-request.js` exports
`wirePanelRequests(dev, cycler, opts)`: subscribe once after `dev.open()`, and it debounces/coalesces
a burst of requests to the LAST id (default 250ms) before routing to `cycler.jumpTo(name, now)` /
`cycler.togglePaused()` / `cycler.step(now)` — the `cycler` interface the (also unmerged)
`al80-lcd-panel-auto-cycle-SPARC.md` specifies. `cycle-run.mjs` will call
`wirePanelRequests(dev, cyc)` once both features land; until then this module is wired and tested
(`test/panel-request.test.mjs`) against a mock cycler, doing nothing on a real board because no
firmware key emits `0x4B` yet.
