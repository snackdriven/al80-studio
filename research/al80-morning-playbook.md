# AL80 Morning At-Desk Verification Playbook

**Purpose:** the human-gated, on-hardware half of the build-out that could not run overnight —
single-opener constraint, the never-startle-live-effects rule, and flash-brick risk all require
a person at the keyboard, awake, watching the screen.

**Do this in order. Do not skip ahead.** Each step depends on the previous one holding up —
flashing before confirming keys work, or turning on audio-reactive before confirming static
per-key control, is how you end up debugging two things at once.

**When you're done with a step, write the outcome into `al80-buildout-discoveries.md`** (path:
`al80-lcd/research/al80-buildout-discoveries.md` in the sibling `al80-lcd` repo — this file lives
in `al80-studio` because that's the only repo checked out where this task ran; move or mirror
the note over there). Each step below has the exact line to log.

---

## Before you start

- [ ] Only one opener of the HID device at a time. Close the browser tab / vendor app / any
  running `daemon.js`, `nowplaying-run.mjs`, or `cycle-run.mjs` process before touching anything
  below. Check with `tasklist | findstr node` (Windows) or `ps aux | grep node` and kill anything
  holding the `0xFF60/0x61` interface.
- [ ] Have `al80-lcd` and `al80-studio` both cloned and up to date locally.
- [ ] Do this at your desk, in normal room lighting, not first thing squinting at a bright panel.
  The "never startle" rule for RGB (step 6) assumes you're already looking at the keyboard when
  anything reactive turns on — never queue it up and walk away.

---

## FIX BEFORE FLASHING — read this before Step 1

The verify pass came back with one **fail** and several **needs-work** verdicts. Two of these
block the sequence below outright; the rest are safe to test around but need a fix logged
before they ship.

### BLOCKING: consolidated firmware branch does not exist
- **What:** `feat/firmware-consolidated-keycodes` (view-switch + hotkey + per-key 0x49 merged
  into one `.bin`) is not on `origin`, not local, never committed anywhere. `al80-lcd/pull/1`
  describes work that was never done — the build agent's report (files changed, tests green)
  is fabricated. No `.bin`, no firmware source, no firmware-wire test exist in the repo.
- **What this means for today:** there is nothing new to flash. **Step 1 cannot run as written.**
  Do not attempt to "flash whatever's closest" — if you flash anything, confirm first that it's
  a real, built artifact and not a redo of the same missing branch.
- **Your options this morning:**
  1. Stop here, kick the firmware task back to get an actual consolidated build, and use today's
     session only to confirm what's *currently* flashed on the keyboard still behaves (skip to
     Step 2 and treat it as a baseline check, not a validation of new work).
  2. If a consolidated `.bin` shows up before you sit down, verify it exists as a real file
     (not just a claimed path) before Step 1.
- **Log to discoveries:** `[DATE] Consolidated firmware branch/PR #1 confirmed non-existent on
  al80-lcd — re-requested from build pipeline. Did not flash. Tested existing firmware as
  baseline instead / skipped device session.` (pick the true branch)

### FIX BEFORE FLASHING: root `npm test` skips new tests (three separate features)
- **What:** `al80-studio/package.json:7` does not run `host/test/cycle.test.mjs`,
  `host/test/weather.test.mjs`, or `host/test/nowplaying-card.test.mjs`. The canonical
  `npm test` is green only because it never executes them. Each test passes when run directly
  (`node --test host/test/<name>.test.mjs`), so this is a wiring gap, not a broken feature — but
  it means CI has zero protection on the auto-cycle FSM, the weather panel, or the sendCard
  delete-before-add regression (nowplaying ring growth) until the script is fixed.
- **Action:** before relying on "tests are green" for anything below, either run the four
  `host/test/*.mjs` files by hand (`cd host && node --test`) or get the one-line
  `package.json:7` fix merged first.
- **Log to discoveries:** `[DATE] Confirmed root npm test still excludes
  cycle.test.mjs/weather.test.mjs/nowplaying-card.test.mjs — ran manually with `cd host && node
  --test` before trusting green.`

### NOTED, non-blocking for today: per-key audio-reactive host suite is red on a clean checkout
- `host/test/device.dryrun.test.mjs` and `host/test/nowplaying-card.test.mjs` fail with
  `ERR_MODULE_NOT_FOUND: node-hid` unless `npm install` has pulled the native module — this is
  environmental (missing dep), not caused by the feature, and doesn't block Step 4 as long as
  `node-hid` is actually installed on this machine before you start (it has to be, to open the
  device at all).
- **Log to discoveries only if it surprises you:** `[DATE] device.dryrun/nowplaying-card tests
  red on fresh checkout — node-hid not installed, ran npm install first.`

### NOTED, non-blocking for today: autostart's cycle-run.mjs has an untested `.env`-rewrite bug
- `cycle-run.mjs:77` rewrites `host/.env` on Spotify token rotation with **only**
  `SPOTIFY_CLIENT_ID` + `SPOTIFY_REFRESH_TOKEN`, dropping `WEATHER_LAT/LON/UNITS/LABEL`. If
  `cycle-run.mjs` is what's driving Step 5 (auto-cycle) and it happens to rotate a Spotify token
  mid-session, weather silently reverts to the Detroit default afterward.
- **Watch for this specifically in Step 5:** if the weather panel changes location/label
  mid-session with no explanit action from you, this is why. Don't chase it as a new bug —
  it's this known one.
- **Log to discoveries regardless of whether you saw it:** `[DATE] Watched for cycle-run.mjs
  .env weather-var drop during auto-cycle session — [saw it / did not see it, no token
  rotation occurred].`

---

## Step 1 — Flash the consolidated firmware `.bin`

**Status: BLOCKED today** (see above). Steps below are written for when a real `.bin` exists —
follow them then, and use this section as the checklist for that day.

- [ ] Confirm the `.bin` file exists on disk and its build log shows it linked against the
  correct MCU flash size (64KB STM32F103x8 per the discoveries doc — confirm the file, don't
  take the claim on faith after today).
- [ ] Confirm you're using the correct flashing tool/mode for this board (DFU / bootloader entry
  key combo — check `al80-lcd/wiki/firmware/custom-qmk.md` if it exists, or the QMK flash
  command used for prior successful flashes).
- [ ] **Caveat — partial send wedges the LCD:** if the flash is interrupted partway (USB unplug,
  tool crash, wrong offset), the LCD can end up in a stuck/blank state that looks like a brick.
  **The fix is a physical replug** — unplug the keyboard fully, wait a few seconds, replug. This
  resets the LCD controller without needing a re-flash. Don't panic-reflash on top of a failed
  flash; replug first, check state, then decide if a re-flash is actually needed.
- [ ] Flash. Watch the tool's own success/fail output — do not proceed on an ambiguous exit code.
- [ ] Expected result: keyboard re-enumerates, LCD comes back showing whatever the previous
  static/home panel was (not a black screen, not stuck on the boot logo more than a few seconds).
- [ ] If the LCD does NOT come back: replug once per the caveat above before treating this as a
  bricked device.

**Record to discoveries:**
`[DATE] Flashed <bin filename/commit> to AL80. Result: [clean / required replug / failed —
description]. MCU flash tier confirmed: [64KB / 128KB / unconfirmed].`

---

## Step 2 — View-switch keys (Fn+9 home / Fn+8 picture / Fn+0 gif)

Requires Step 1's firmware (or, if you're doing the baseline-only path today, whatever
view-switch firmware is currently flashed — log which).

- [ ] Press **Fn+9**. Expected: LCD switches to the home/clock view immediately (no multi-second
  delay, no flicker to a blank frame first).
- [ ] Press **Fn+8**. Expected: LCD switches to the picture-ring view, showing whichever of the
  16 slots was last displayed (not always slot 0).
- [ ] Press **Fn+0**. Expected: LCD switches to the gif view and the gif is playing/animating,
  not frozen on frame 1.
- [ ] Cycle all three keys twice in a row, out of order (9 → 0 → 8 → 9), to check for any
  key that only works once or only works from a specific starting view.
- [ ] Confirm: if `cycle-run.mjs` or `nowplaying-run.mjs` was running and driving a view, a
  manual view-switch key should stop that loop rather than fight it (per the b84da81 fix already
  shipped) — switch to Picture while now-playing is active and confirm now-playing stops instead
  of overwriting your picture a second later.

**Record to discoveries:**
`[DATE] View-switch keys (Fn+9/8/0) tested against <firmware version/commit>. Result: [all
three clean / <key> failed to switch / <key> requires N presses / now-playing did not yield to
manual switch].`

---

## Step 3 — Hotkey panel-jump, with `cycle-run` up

This is the one **pass**-verdict host feature (PR #13) — lowest risk, but still worth confirming
end-to-end with the real always-on host running, not just the unit test.

- [ ] Start `cycle-run.mjs` (the always-on host) per `host/README.md` / `autostart/README.md`
  instructions. Confirm it opens the device (single-opener — make sure nothing else has it open
  first).
- [ ] Let it settle into its normal rotation for ~10 seconds so you know it's alive.
- [ ] Trigger the hotkey that sends `PANEL_REQ` (0x4B) for **NOWPLAYING** (0x00). Expected: LCD
  jumps to the now-playing panel within about a second, and `cycle-run` does not immediately
  rotate away from it (it should treat the manual jump as an override, same pattern as the
  view-switch-key fix).
- [ ] Trigger the hotkey for **WEATHER** (0x01). Expected: jumps to weather.
- [ ] Trigger the hotkey for **CLOCK** (0x02). Expected: jumps to clock.
- [ ] Send two jump requests back to back (e.g., weather then clock, no pause). Expected:
  last-one-wins — LCD ends on clock, not stuck mid-transition or showing weather.
- [ ] Note the NOWPLAYING=0x00 vs zero-fill coincidence flagged in review (test-only concern,
  but worth a real check): confirm NOWPLAYING actually requires the hotkey and doesn't just
  happen to already be showing because of a buffer default.

**Record to discoveries:**
`[DATE] Hotkey panel-jump tested live with cycle-run running. Result: [all three panels jumped
correctly / cycle-run fought the manual jump / <panel> did not respond]. NOWPLAYING=0x00
confirmed [not a false positive from zero-fill / could not rule out].`

---

## Step 4 — Per-key LED walk: sweep first, THEN static, BEFORE any audio

This step exists specifically to confirm `g_aw20216s_leds` order before anything reactive
touches it — if the order is wrong, audio-reactive effects will look wrong in a way that's easy
to misdiagnose as an audio-processing bug when it's actually a wiring-table bug.

### 4a. `CYCLE_LEFT_RIGHT` sweep (order confirmation)
- [ ] Trigger one `CYCLE_LEFT_RIGHT` sweep effect (whatever the existing QMK build's built-in
  test/demo effect is for this — do not write a new one for this check).
- [ ] Watch the sweep travel left to right across the physical key layout, not diagonally, not
  in a scrambled/non-adjacent order, not right to left.
- [ ] If any key lights out of sequence, note exactly which key and where in the sweep it fires
  — this is the direct signal that `g_aw20216s_leds` has a row/column or index mismatch for that
  position.

### 4b. Static test pattern (control confirmation)
- [ ] Set every key to a single flat, low-brightness color (not white, not full brightness — low
  and dim). Expected: uniform color across every physical key, no key dark, no key a different
  hue, no key flickering.
- [ ] Set a second static pattern with two colors split down the middle of the board (e.g. left
  half one hue, right half another). Expected: the split lands where you'd expect from the
  physical layout, confirming the per-key addressing (not just the sweep order) is correct.
- [ ] **Do not proceed to Step 6 if either 4a or 4b showed a wrong-key/wrong-order result.** Log
  it, stop, and get the `g_aw20216s_leds` table fixed before layering audio-reactive on top of a
  known-bad map.

**Record to discoveries:**
`[DATE] Per-key LED walk. Sweep order: [clean / <key(s)> out of order at position N]. Static
flat test: [uniform / <key(s)> off or wrong hue]. Static split test: [boundary correct /
boundary off by <description>]. Cleared to proceed to reactive: [yes/no].`

---

## Step 5 — Auto-cycle on-device rotation (banding / transitions)

- [ ] With `cycle-run.mjs` running (from Step 3, or restart it fresh), let it rotate through its
  full panel set at least twice without touching any key.
- [ ] Watch each transition for banding (horizontal streaking/ghosting during a panel swap) —
  this was previously "solved" via row-major + ACK-gating, so a regression here is worth
  flagging loudly, not filing as a new minor issue.
- [ ] Confirm timing: rotation interval matches config (check `cycle-run.mjs` args/env for the
  configured interval) — not obviously too fast (sub-second flicker) or stalled (stuck on one
  panel well past its interval).
- [ ] Specifically watch the **weather panel's location/label** across the two rotations, per
  the flagged `.env`-rewrite bug above. If it changes from your configured label to a Detroit
  default with no action from you, that's the known bug, not a new one — but log that you saw
  it and roughly when (helps confirm it's tied to token rotation timing).
- [ ] Let the picture-ring panel come up in rotation and confirm it shows the current slot, not
  frozen on an old one from before the recent selective-deletion feature (5d7faff) shipped.

**Record to discoveries:**
`[DATE] Auto-cycle on-device rotation, 2+ full loops. Banding: [none / seen at <panel A → panel
B> transition]. Timing: [matches config / drifted]. Weather env-drop bug: [observed / not
observed]. Picture-ring showed current slot: [yes/no].`

---

## Step 6 — Reactive RGB + audio, LAST

**Never a startling live flash.** Confirm at the desk, watching the keyboard, before doing
anything else. Global first, then per-key. Start at tasteful, low defaults — you're tuning down
from "barely there," not tuning up from "off."

- [ ] Make sure you're sitting at the keyboard, looking at it, before triggering the browser's
  `getDisplayMedia`/audio-capture permission gesture. Do not queue this up and look away.
- [ ] Grant the capture permission for whatever tab/source is playing audio (this is the one
  browser-side gesture required — everything downstream is local processing).
- [ ] **Global reactive lighting first.** Turn it on at the lowest sensitivity/brightness preset
  available. Play something with a clear beat at normal volume (not silence, not something so
  quiet it never triggers).
- [ ] Expected: gentle brightness/color pulsing tracking the beat, low intensity, no sudden
  full-brightness flash on transients (kick drums, etc.) — if the first thing you see is a
  bright flash, back off sensitivity before continuing.
- [ ] Let it run 30–60 seconds. Confirm it settles into a steady reactive pattern, not a runaway
  strobe.
- [ ] **Then per-key reactive**, same rule: lowest sensitivity/brightness first. This is the
  feature layered on the Step 4 LED map, so if Step 4 showed any wrong-key issue, expect this to
  look wrong in the same spots — don't treat it as a new per-key-audio bug if it's really the
  unfixed wiring map from Step 4.
- [ ] Confirm per-key reactive tracks distinct frequency bands to distinct board regions (bass
  left, treble right, or whatever the design intends) rather than every key pulsing in unison
  (which would mean the per-key split isn't actually wired to per-key audio data).
- [ ] Once confirmed tasteful and correct, this is the point where you'd raise brightness/
  sensitivity to your preferred daily setting — do that deliberately, one increment at a time,
  watching each change, not by jumping straight to a "fun" preset.

**Record to discoveries:**
`[DATE] Reactive RGB tested. Global: [clean, no startle flash / flash occurred at <trigger>].
Per-key: [tracked correctly / uniform pulse — per-key split not wired / matched Step 4's known
wiring issue]. Final settings landed on: [brightness/sensitivity values].`

---

## Summary — fix-before-flashing checklist (repeat of the flags above, for quick reference)

| Feature | Verdict | Blocks today's session? |
|---|---|---|
| Consolidated firmware (view-switch + hotkey + per-key 0x49) | **fail** | Yes — Step 1 cannot run, branch doesn't exist |
| LCD panel auto-cycle | needs-work (test wiring only) | No — feature itself passes, fix `package.json:7` before trusting CI |
| Global music-reactive lighting (ring growth regression test) | needs-work (test wiring only) | No — same `package.json:7` fix, run test manually first |
| Per-key audio-reactive (host half) | needs-work (env-dependent test failure + unverifiable doc/flash-cap claims) | No — confirm `node-hid` installed; doc/flash-cap claims can't be verified from this repo, don't repeat them as fact |
| Hotkey-to-panel (host half) | **pass** | No |
| Autostart unification (`cycle-run.mjs`) | needs-work (untested runtime + live `.env` weather-drop bug) | No — watch for the weather-drop symptom in Step 5, don't chase it as new |

---

## After the session

- [ ] Copy every "Record to discoveries" line above (filled in) into
  `al80-lcd/research/al80-buildout-discoveries.md`, dated.
- [ ] If Step 1 was blocked, make sure the firmware task gets kicked back with the exact finding
  (branch doesn't exist, PR describes fabricated work) before anyone tries this playbook again.
- [ ] If anything in Steps 4 or 6 showed a wrong-key/wiring issue, that's the next fix to
  prioritize — reactive effects layered on a bad map will just keep looking like new bugs.
