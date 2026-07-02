# AL80 Studio — UX/IA Audit & Redesign

Design deliverable only. No code changes proposed here are implemented.

Scope: the single-page WebHID control panel (`index.html`, `styles.css`, `src/ui.js`) that
replaces YUNZII's vendor site for controlling the AL80 keyboard's LCD.

---

## 1. Audit — what's wrong with the 5-tab IA

The current shell is a header (Connect + status dot + a permanent "close other apps" warning)
over a flat 5-tab bar: **Clock · Image · GIF · View · Shortcuts**. The tabs are siblings, styled
identically, and imply they're five variations of one job. They aren't. There are three problems
underneath, and they compound.

### 1a. The tab bar mixes two unrelated jobs

Four tabs (Clock, Image, GIF, View) are **live device control** — they send HID packets and are
gated behind Connect (`.device-action` disabled until `connected`). The fifth, **Shortcuts**, is
an **offline file generator**: it imports/exports VIA keymap JSON and never touches the device
(`setupShortcutsTab` has no `hid.send` call, no `.device-action` elements). Sitting it in the same
bar tells the user it's part of the same flow and implies it needs Connect. It doesn't. Someone who
just wants to export a keymap has to look at a greyed-out Connect button and a "close VIA" warning
that are irrelevant to them. This is the single biggest IA smell.

### 1b. "View" is device *state* dressed up as a *task*

The LCD shows exactly one thing at a time — clock, picture, or GIF — and the device has a "current
view." That's a **mode**, not a task. But the current view is exposed as a tab you click into, and
worse, it's the *only* place the mode is represented. Two failures fall out of this:

- **The current view is invisible everywhere else.** Nothing in the header or panels tells you what
  the LCD is showing right now. You send an image, tab over to Clock, and you have no idea whether
  the screen is still on your picture or something else.
- **The View tab is now half-redundant.** After the recent patch, `#imageSend` and `#gifSend`
  auto-switch the view on send (`buildView(VIEW.PICTURE)` at the end of the image send, same for
  GIF). So "switch to picture" now happens in two places: automatically on upload, and manually in
  the View tab. The View tab's *unique* remaining jobs are narrow: switch back to Homepage/clock,
  re-show a stored picture/GIF without re-uploading, and the "Clear stored data" danger zone. That's
  not enough to justify a top-level tab, and burying "clear picture" three tabs away from the picture
  editor is the wrong place for it.

Also worth being honest about: the app is **write-only** to the device. Nothing in the code reads
device state back — `hid` only sends. So any "current view" indicator can only reflect *the last
view this app pushed*, and on a fresh connect it's genuinely unknown. The redesign should say
"last set" rather than pretend it's polling the keyboard.

### 1c. Image / GIF / View are conceptually tangled

"Put an image on the screen" is the primary task, and until the auto-switch patch it silently failed
half the time — you'd upload, see nothing change, and not know that displaying was a separate step in
a different tab. The patch fixed the behavior but the IA still reflects the old broken mental model:
uploading (Image) and displaying (View) are still presented as separate destinations. The vocabulary
adds to it — the tab is called **Image** but the device view it feeds is called **Picture**
(`VIEW.PICTURE`, `viewPicture`, "Clear picture"). Same object, two names.

### 1d. Smaller friction

- **The "close yunzii-game.com / VIA" warning is permanent.** It's a one-time, pre-connect concern
  (single opener at a time), but it eats a full band of vertical space forever, even after you've
  connected successfully.
- **Disabled device buttons don't explain themselves.** They just go to 45% opacity. A first-timer
  sees a greyed-out "Send to device" with no hint that Connect is the unlock.
- **Clock sync has no ambient signal.** Turn on "Keep synced (every 60s)," tab away, and there's
  nothing telling you it's still running.
- **The primary CTA is buried.** In the Image tab, "Send to device" sits at the bottom of a stack of
  five sliders, with the preview parked off to the right. The thing you came to do is the least
  prominent element on screen.

---

## 2. Proposed information architecture

Split the app along the seam that already exists in the code: **live device control** vs. **offline
file tool**. Then make the device's current view an ambient status instead of a tab.

```
AL80 Studio
├─ LCD            ← live device control (everything gated on Connect)
│   ├─ [Now Showing bar]  ← ambient state, always visible: Clock | Picture | GIF
│   ├─ Clock      ← set time/date, keep synced
│   ├─ Picture    ← was "Image": upload + adjust + Send & show + Clear stored picture
│   └─ GIF        ← upload + fps + Send & show + Clear stored GIF
└─ Keymap         ← was "Shortcuts": offline VIA JSON tool, no device, no Connect
```

**Why two top-level sections, not five tabs**

- **LCD** and **Keymap** are different jobs with different prerequisites. Keymap needs no device, so
  it shouldn't live behind the same Connect gate or share the "close VIA" warning. Separating them
  means the greyed-out device chrome disappears entirely when you're just making a keymap file.
- Inside **LCD**, Clock / Picture / GIF are the three **content sources** you can prepare. They map
  1:1 to the three device views, so the sub-nav and the "Now Showing" states use the *same three
  labels*. One vocabulary, top to bottom.

**Why "Now Showing" is a bar, not a tab**

The LCD shows one thing at a time. That fact should be the most visible thing in the LCD section, not
a destination you click into. A persistent segmented control — `Clock | Picture | GIF` with the
active one highlighted — does three jobs the old View tab did, plus one it couldn't:

1. **Shows** the last-set view at all times (the ambient state that was missing).
2. **Switches** view on click (the View tab's main job), including "back to Clock/Homepage."
3. **Re-shows** a stored picture/GIF without re-uploading (click Picture even if you didn't just
   send one).
4. Makes the auto-switch-on-send *legible*: after you hit "Send & show," the user watches the bar
   flip to Picture, so the cause and effect are visible instead of silent.

**Where the View tab's other pieces go**

- Manual view switching → the Now Showing bar.
- **Clear stored picture** → into the **Picture** editor as a secondary/danger action (it belongs
  next to the thing it erases).
- **Clear stored GIF** → into the **GIF** editor, same reasoning.
- The View tab is then deleted. Nothing is lost.

**Where Connect + status live**

Stay in the header, but scoped to the **LCD** section (Keymap doesn't show it). The permanent warning
becomes contextual: show the "close yunzii-game.com / VIA" hint only while disconnected or after a
connect error, right next to the Connect button. Once connected, it's gone.

**Vocabulary changes**

- **Image → Picture** (match `VIEW.PICTURE` / "Clear picture" — one name for one object).
- **Shortcuts → Keymap** (it's a VIA keymap JSON tool, not shortcut recording; the current label
  oversells it, and the panel even admits "No live key-grid editor yet").
- **"Send to device" → "Send & show"** (names the two things the button actually does now: store the
  frame *and* switch the view).

---

## 3. ASCII wireframes

### 3a. Overall shell — disconnected, LCD section

The header owns Connect + status. The "close other apps" hint is contextual (shown here because
disconnected). Section nav (LCD / Keymap) is the top-level split. Device editors are gated with an
explicit reason, not just greyed out.

```
┌──────────────────────────────────────────────────────────────────────┐
│  AL80 Studio                                  ● Disconnected [Connect] │
│  YUNZII AL80 LCD control panel                                         │
│                                          ⚠ Close yunzii-game.com and   │
│                                            VIA first (one at a time).  │
├──────────────────────────────────────────────────────────────────────┤
│  [ LCD ]   Keymap                                                      │  ← top-level sections
├──────────────────────────────────────────────────────────────────────┤
│  NOW SHOWING (last set):   Clock  ·  Picture  ·  GIF        [unknown]  │  ← ambient state bar
│                            └─ greyed until connected ─────┘            │
├──────────────────────────────────────────────────────────────────────┤
│   Clock  |  Picture  |  GIF        ← LCD content sub-nav               │
│  ────────────────────────────────────────────────────────────────     │
│                                                                        │
│        ┌──────────────────────────────────────────────┐               │
│        │   Connect your AL80 to edit what's on the LCD │               │
│        │                  [ Connect ]                  │               │
│        └──────────────────────────────────────────────┘               │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

### 3b. LCD ▸ Picture — the primary task ("put an image on the screen"), connected

Connected, so the Now Showing bar is live and shows the last-set view. The primary CTA (**Send &
show**) is promoted next to the preview, not buried under the sliders. Progress bar has room for the
~2s / 550-packet send. "Clear stored picture" lives here now, as a quiet danger action.

```
┌──────────────────────────────────────────────────────────────────────┐
│  AL80 Studio                                   ● Connected [Disconnect]│
├──────────────────────────────────────────────────────────────────────┤
│  [ LCD ]   Keymap                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  NOW SHOWING (last set):   Clock  ·  [ PICTURE ]  ·  GIF               │  ← Picture highlighted
├──────────────────────────────────────────────────────────────────────┤
│   Clock  |  [ Picture ]  |  GIF                                        │
│  ────────────────────────────────────────────────────────────────     │
│                                                                        │
│   ┌───────────────────────────┐     ┌──────────────────────────┐      │
│   │  Drop an image here, or   │     │   Preview  112×137 (3×)   │      │
│   │      [ Choose file ]      │     │   ┌────────────────────┐  │      │
│   │  sunset.png               │     │   │                    │  │      │
│   └───────────────────────────┘     │   │   [ preview img ]  │  │      │
│                                      │   │                    │  │      │
│   Fit    [ Cover  ▼ ]                │   └────────────────────┘  │      │
│   Brightness  ------O------ 100%     │                           │      │
│   Contrast    ------O------ 100%     │   ┌──────────────────────┐  │      │
│   Saturation  ------O------ 100%     │   │   * Send & show      │  │  ← primary CTA, by preview
│   ☐ Grayscale   ☐ Dither             │   └──────────────────────┘  │      │
│                                      │   [████████░░░░] 62%  330/550 │   ← progress on send
│                                      │   Sending… image will show    │      │
│                                      └──────────────────────────┘      │
│                                                                        │
│  ─────────────────────────────────────────────────────────────────    │
│  Danger:  [ Clear stored picture ]   erases pictures on the keyboard   │
└──────────────────────────────────────────────────────────────────────┘
```

(The garbled slider fills above are just ASCII noise for the track — read them as range sliders at
100%.)

### 3c. Keymap — offline file tool, no device

Its own top-level section. No Connect, no status dot, no "close VIA" warning. A plain-language line
says it doesn't touch the keyboard, so nobody wonders why there's no device chrome.

```
┌──────────────────────────────────────────────────────────────────────┐
│  AL80 Studio                                                          │
├──────────────────────────────────────────────────────────────────────┤
│   LCD    [ Keymap ]                                                    │
├──────────────────────────────────────────────────────────────────────┤
│  Offline tool — builds a VIA keymap JSON file. Doesn't touch your      │
│  keyboard, so no connection needed.                                    │
│                                                                        │
│  [ Import keymap JSON ]   [ Export keymap JSON ]   Exported ✓          │
│                                                                        │
│  ┌───────────────────────┐   ┌────────────────────────────────────┐   │
│  │ Preset                │   │  Catalog                           │   │
│  │  [ Media ▸ Play  ▼ ]  │   │  Media                             │   │
│  │                       │   │   [Play KC_MPLY] [Next KC_MNXT] …   │   │
│  │  VIA keycode:         │   │  Navigation                        │   │
│  │   ┌───────────────┐   │   │   [Home KC_HOME] [End KC_END] …     │   │
│  │   │  KC_MPLY      │   │   │  Function                          │   │
│  │   └───────────────┘   │   │   [F1 KC_F1] [F2 KC_F2] …           │   │
│  └───────────────────────┘   └────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. Migration notes

### 4a. How the 5 tabs map onto the new structure

| Current tab | New home | Notes |
|-------------|----------|-------|
| **Clock** | LCD ▸ Clock | Unchanged behavior. "Send once" should also set view→clock so it shows. Keep-synced needs an ambient badge (see below). |
| **Image** | LCD ▸ **Picture** | Rename to match device vocabulary. "Send to device" → "Send & show." Promote CTA next to preview. |
| **GIF** | LCD ▸ GIF | Unchanged, keep the EXPERIMENTAL badge. "Send" → "Send & show." |
| **View** | **Deleted** | Switch → Now Showing bar. Clear picture → Picture editor. Clear GIF → GIF editor. Homepage/clock switch → the "Clock" segment in the bar. |
| **Shortcuts** | **Keymap** (top-level) | Pulled out of the device tab bar entirely. Rename. Add "offline, no device" line. |

### 4b. Top changes, prioritized

1. **Split Keymap out of the device tab bar into its own top-level section.** Highest clarity win for
   the least work — it's already codeless w.r.t. the device (no `.device-action`, no `hid.send`), so
   this is a nav/DOM reshuffle, not a logic change. Removes the false implication that keymap export
   needs Connect.

2. **Replace the View tab with a persistent "Now Showing" bar** (`Clock | Picture | GIF`, active
   one highlighted, click to switch). Reuse the existing `buildView` calls behind the segments. Track
   the last view the app set in a variable and reflect it in the bar; label it "last set" and show
   "unknown" on fresh connect, because the app can't read device state back. This makes the
   one-thing-at-a-time model visible and makes the auto-switch-on-send legible.

3. **Fold the View tab's clear actions into their editors and align vocabulary.** Move "Clear stored
   picture" into the Picture editor and "Clear stored GIF" into the GIF editor (each next to the
   thing it erases), then delete the View tab. Rename Image→Picture, Shortcuts→Keymap, and "Send to
   device"→"Send & show" so one object has one name everywhere.

4. *(Next)* **Make the "close other apps" warning contextual** — show it only while disconnected or
   after a connect error, beside the Connect button, instead of a permanent band.

5. *(Next)* **Explain the gate and surface running sync** — replace bare disabled buttons with a
   "Connect to enable" empty state in the LCD area, and add a small "Syncing • every 60s" badge in
   the Now Showing bar when clock sync is on, so it's visible after you tab away.
