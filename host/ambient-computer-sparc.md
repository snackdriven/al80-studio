# Ambient Computer — SPARC design (AL80 daemon)

Turn the AL80 (screen + RGB, on ripple firmware) into an ambient display driven by your
digital context: music, calendar, notifications, infra status. A local background daemon
owns the keyboard and shows the most relevant thing right now, with gentle lighting.

Status: design only. Nothing built. The now-playing render + art/spotify scaffolds already
exist in `host/`; this is the frame they slot into.

---

## S — Specification

**What it is.** A daemon on the Windows machine the keyboard is plugged into. It holds the
HID connection, renders 96×160 frames to the LCD, and sets the global RGB — driven by a set
of toggleable sources and a scene-priority policy.

**Goals**
- The screen shows the right thing without being asked: now-playing while music's on, the
  next meeting as it approaches, a notification card when something lands, a clock otherwise.
- The RGB reflects state gently: synced to album art, a soft pulse on events. Never startling.
- Runs unattended for a full workday — survives unplug, token expiry, network blips, crashes —
  and needs no browser open.

**Non-goals (YAGNI)**
- Not replacing al80-studio's interactive tools; those stay for one-off pushes + config.
- Not per-key RGB (that's custom QMK; ripple is global-color only).
- Not a plugin marketplace. A fixed source/scene set to start.
- Not multi-keyboard, not cross-machine HID.

**User stories**
- While I work, the keyboard shows what's playing and glows its color.
- Ten minutes before a meeting, the screen shows it.
- When CI finishes or a message arrives: a soft card + gentle pulse, auto-dismissed.
- Idle → a clean clock.
- I can pause the daemon, grab the keyboard with al80-studio, then resume.

**Constraints**
- **Single HID opener** — only one app can hold the connection. Daemon vs al80-studio vs
  usevia conflict. This is the crux (see Refinement).
- Runs on Windows (HID is local). Node + node-hid.
- LCD needs pacing; RGB is global (ripple/VIA channel).
- "Never startling" — gentle transitions, calm defaults, quiet hours, at-desk confirm for
  anything attention-grabbing.
- Sources optional: Spotify (OAuth), Google Calendar (OAuth), ntfy (subscribe), Uptime
  Kuma/seedbox (HTTP).

**Success criteria**
- 8+ hours unattended, no crash, no manual reconnect.
- Music → now-playing within ~2s; meeting card at T-10min; notification within ~2s then
  auto-dismiss.
- RGB transitions smooth (no flashes). Config changes apply without a restart.
- Pause/resume hands HID to al80-studio cleanly.

**Edge cases**: unplug mid-run; token expiry; two scenes contend; network down; both daemon
and al80-studio launched at once.

---

## P — Pseudocode

**Main loop (event-driven, not a busy poll)**
```
init: load config; open HID (retry); start renderer; start sources; start engine
sources emit → Store.update()
Store change → Engine.reevaluate()  (debounced)
Engine picks active scene by priority; computes rgb intent
Compositor: diff scene frame vs last; if changed, enqueue (coalesced)
Writer: drain queue, paced/ACK-gated; apply RGB with a fade
HID error → mark disconnected → reconnect loop
```

**Scene priority policy**
```
pickScene(store):
  if store.notification.active && !expired: return Notification   # transient, top priority
  if store.calendar.next && minutesUntil(next) < 10: return Meeting
  if store.spotify.playing: return NowPlaying
  return Idle (clock / rotating widgets)
# transient scenes auto-expire after N s → reevaluate
# min dwell time per scene (~3s) to stop flicker, except Notification
```

**RGB intent**
```
rgbIntent(scene, store):
  NowPlaying   -> dominantColor(albumArt)      # synced
  Notification -> softBreathe(scene.color)     # slow, brightness-capped
  else         -> config.calmDefault (or off)
# every change = fade ~400ms, capped brightness, never a strobe
```

**Writer with pacing (the reliability core)**
```
enqueue(frame): queue = [frame]        # coalesce: only latest frame matters
drain:
  f = queue.pop()
  announce; setup
  for block in chunks(transposeToColMajor(f), 56):
     write(block); awaitAck() or delay()   # ACK-gate on 0x55/0x0F if the module answers
  finish
  on error -> reconnect()
```

**Reconnect**
```
on error/unplug: close; setDisconnected
  loop: open(0x28E9,0x30AF, usagePage 0xFF60); if ok: re-init module, resume; else backoff
```

**Config hot-reload**: watch file → validate → apply diff (start/stop sources, update policy)
without restart.

---

## A — Architecture

Modules, each with one job and a clean boundary:

1. **`device.js` — the sole HID owner.** Opens the AL80 on usage page 0xFF60 (node-hid).
   Exposes `sendFrame(frame)`, `setRGB({effect,color,brightness,speed})`, `onDisconnect`.
   Owns pacing + reconnect + the column-major transpose. Reuses al80-studio's `protocol.js`
   builders (share as a local package, don't fork).

2. **`render/` — pure state→frame.** Scenes: `nowplaying.js` (exists), `clock.js`,
   `meeting.js`, `notification.js`, `idle.js`. Uses `@napi-rs/canvas` for text/layout, then
   → RGB565. `art.js` = album-art decode + downscale + dominant color. Pure and testable:
   state in, 96×160 frame out, no I/O.

3. **`sources/` — event producers.** `spotify.js` (OAuth + poll now-playing), `calendar.js`
   (next event), `ntfy.js` (subscribe topic), `status.js` (Uptime Kuma/seedbox). Each
   toggleable + isolated: one failing never takes down the others.

4. **`store.js` — central observable state.** `{spotify, calendar, notifications[], status,
   config}`. Sources write; Engine reads. Tiny event-emitter.

5. **`engine.js` — the policy brain.** On any Store change, pick the active scene, manage
   transient expiry + min-dwell, hand the Compositor the frame source + RGB intent. Debounced.

6. **`compositor.js`** — takes the active scene's frame + rgb intent, diffs vs last (skip
   no-ops), drives `device.js` with pacing + RGB fades.

7. **`control.js` — local API (127.0.0.1 only).** pause/resume (release/re-acquire HID),
   get/set config, push a manual frame/scene, status. This is how al80-studio (or a config
   page) talks to the daemon without fighting for HID.

8. **Supervisor** — runs it as an auto-restarting background process. Start: pm2 or a
   Task-Scheduler .bat. Polish: a systray app with status + pause/resume.

**Data flow**
```
[Sources] → [Store] → [Engine] → scene+rgb → [Compositor] → diff+pace → [device.js] → HID → AL80
                                       ↑
[control.js] ← al80-studio / config UI ┘   (pause/resume, config, manual push)
```

**Tech**: Node (matches host/); node-hid; @napi-rs/canvas (no native-build pain); config in
`~/.al80/config.json` + chokidar hot-reload; control API on built-in http; pm2 → tray later.

**al80-studio relationship**: stays as-is for direct use when the daemon's paused. End-state
(v2): al80-studio's send buttons POST to the control API instead of WebHID, so it becomes the
daemon's config+preview UI and the single-opener conflict disappears.

---

## R — Refinement (the hard parts)

1. **Single-opener conflict (the crux).** v1: daemon owns HID; al80-studio shows "daemon
   running — pause to use directly"; control API exposes pause/resume (close/reopen the HID
   handle). v2: al80-studio talks to the control API, no direct HID, both coexist. Ship v1
   pause/resume first — simple, unblocks everything.

2. **Pacing — don't overrun the module.** Reuse the researched flow-control: init → 50ms →
   ready-poll → 56-byte chunks. Prefer ACK-gating on the module's 0x55/0x0F byte (like
   lab.html's sendAckGated) over blind delays — robust against USART's lack of flow control,
   and it's the same mechanism that prevents the dropped-byte banding.

3. **Frame rate — don't spam the keyboard.** The screen isn't 60fps. Send only on content
   change. The now-playing progress bar is a small region → redraw just that (region update)
   at ~1fps, not the whole frame. Coalesce the queue. Keeps typing responsive (avoids the
   single-thread stutter the module is prone to). Caveat: region updates + column-major don't
   compose trivially (a row-major byte range scatters across column-major) — v1 may just
   full-frame redraw at ~1fps for the bar; compute the true column-major region only if needed.

4. **RGB gentleness.** Every change fades (interp hue/brightness ~400ms), brightness-capped,
   never a vendor strobe unprompted. Dominant-color picks a pleasant saturated tone; near-black
   / near-white art falls back to the calm default. Notification = a slow breathe, not a flash.
   Global quiet-hours / do-not-disturb.

5. **Reconnection.** Detect unplug (write error or a device-change watch) → retry-open with
   backoff (cap ~5s) → re-announce the module on reconnect. Never crash; surface via control API.

6. **Secrets.** Spotify refresh token, Google creds stored locally, outside the synced tree
   (per the "credentials stay local" rule). Refresh proactively; on failure degrade + quiet error.

7. **Priority thrash.** Debounce + min-dwell so a brief music pause doesn't flip to clock and
   back. High-priority notifications can still preempt.

8. **Seedbox role.** It can't drive local HID, but it's a perfect always-on event *producer*:
   host the ntfy topic, run countdown/reminder logic, aggregate CI + Uptime-Kuma status, and
   push to the local daemon (which subscribes). Seedbox = producer, local daemon = consumer +
   renderer. Uses infra that already exists.

9. **Failure isolation.** Each source in its own try/catch; a dead source never kills the
   daemon or its siblings. The renderer must never throw into the write loop (bad art →
   fallback tile).

10. **Testing without hardware.** Renderer is pure → PNG snapshot tests (like the existing
    now-playing previews). Engine policy is pure → unit-test priority + dwell. Device layer is
    the only hardware-bound part → mock it for everything else.

---

## C — Completion

**Phasing (each phase independently useful):**
- **Phase 0 — foundation / de-risk.** `device.js`: node-hid open + paced/ACK-gated frame send
  + RGB set + reconnect, reusing protocol.js. Prove: push a static frame + set a color from
  Node, unattended, survive replug. Riskiest bit (node-hid on Windows + does the module ACK?) —
  settle it first.
- **Phase 1 — now-playing daemon.** Spotify source + now-playing render + minimal engine
  (now-playing vs clock) + album-art color sync. Standalone useful; the flagged biggest-bang.
- **Phase 2 — scenes + policy.** clock/idle, meeting (calendar), notification (ntfy) + the
  priority engine + transient auto-dismiss + gentle pulses.
- **Phase 3 — control + config.** Control API (pause/resume, hot-reload) + a config UI (adapt
  al80-studio or a small page). Pause/resume ends the coexistence problem.
- **Phase 4 — supervision + polish.** Tray app (status, pause/resume), auto-start, quiet hours,
  the seedbox event relay.

**Testing**: pure renderer → PNG snapshots; pure engine → unit tests; device layer → on-hardware
smoke + a mock; an 8h soak for leaks/disconnects.

**Done looks like**: auto-starts on login; shows now-playing + syncs color while music plays;
surfaces meetings + notifications gently; falls back to a clock; survives unplug / token expiry /
network blips for a full workday; pauses cleanly to hand off to al80-studio.

**Risks / open questions**
- node-hid reliability on Windows for this device — de-risk in Phase 0.
- Does ripple's module answer the 0x55/0x0F ACK, enabling ACK-gated pacing? — test in Phase 0.
- Region-update + column-major composition (the progress bar) — may full-frame redraw in v1.
- One-time Spotify / Calendar auth UX.

**First move**: Phase 0 is a ~1-file spike (`device.js` + a static-frame push from Node). It
answers the two riskiest unknowns (node-hid on Windows, module ACK) before any of the pretty
stuff is built. If that spike works, Phase 1 (now-playing) is a straight line.
