# Picture-page won't display the fresh frame — debug log

Live log of hypotheses (Occam's-first), what's tested, what's ruled out. Update as we learn.

## The bug
`device.js` (native/node-hid) writes a 96×160 picture-page frame — announce(0x10) → setup →
549 data blocks → finish → buildView(PICTURE). **All 549 blocks ACK (549/549, 0 fell back, ~1.1s).**
But the screen keeps showing an OLD picture, not the fresh frame. Earlier in the session the
**browser** (WebHID) DID render fresh picture-page frames on screen (lab.html solids F/A showed;
photos rendered sideways/banded). So the pixels reach a buffer — they just don't get displayed.

## Established facts
- Write acks perfectly (549/549, 1.1s) → the module receives + confirms every block.
- **Main page displays fine via node-hid** — the spike's clock showed on screen. So node-hid CAN
  trigger a display; this is picture-page-specific.
- **Picture page displays fine via WebHID** (browser, earlier this session).
- ⇒ The gap is specifically **node-hid + picture-page = no display.**
- SEND_LEN = 64 in the browser (hid.js) AND 64 in node (device.js) → identical report length.
- Same `buildImageTransfer` builder for both.
- Not slideshow (user confirmed the stuck image isn't cycling — it's frozen).
- The view actually changes (manual main→ software picture toggle happened) but still shows old.

## Hypotheses (simplest first)

### H1 — My later changes broke the display in BOTH paths (browser too)  [UNTESTED — highest value]
The EARLY browser (before all my picture-path churn: column-major, ack-gating, retry,
homepage-reset, revert) showed fresh pictures. Any of those may have broken the display trigger
for the browser as well. If a fresh photo via the CURRENT browser ALSO shows old, then I broke it
in both and the fix is a bisect back to the early-working send — NOT a node-vs-browser difference.
**Test: browser Picture tab → fresh photo → fresh or old?** (one data point resolves a lot.)

### H2 — SEND_LEN report-length mismatch (63 vs 64)  [RULED OUT]
Both send 64-byte reports. Not it.

### H3 — Node omits the view-switch the browser sends  [MOSTLY RULED OUT]
Node already sent buildView(PICTURE) after the write (same as browser) and it still showed old.
So it's not a missing view switch by itself.

### H4 — Timing: node switches the view before the module commits the 30KB buffer  [TESTING]
node-hid writes are fast/synchronous; WebHID's sendReport awaits the browser HID stack (more
latency per block). Node may fire buildView(PICTURE) before the module finishes committing the
picture, so the view reads the pre-commit (old) buffer. Browser's slower cadence gives commit time.
**Fix under test:** settle ~300ms between the write's finish() and buildView(PICTURE), and match the
browser exactly (plain buildView(PICTURE), no home toggle).

### H5 — node-hid vs WebHID write semantics for a 549-block burst  [SUSPECT]
`dev.write([0x00, ...64])` (node-hid) vs `sendReport(0, 64)` (WebHID). node-hid works for the
main-page clock, so not fundamentally broken; but a rapid 549-block burst might expose a node-hid
buffering/reorder quirk the module tolerates (acks) yet stores wrong. Hard to test without a capture.

### H6 — A "commit / show slot" opcode we never send  [RE IN PROGRESS]
The picture page may store to a SLOT and need an explicit "display slot N / refresh" command that
neither buildView(0x0d) nor finish() provides — one the vendor app sends after the pixels. Needs
RIPPLE.bin RE of the picture-display state machine. (subagent dispatched)

### H7 — The browser primes the display via its connect sequence  [UNTESTED, low odds]
Browser sets views on connect (buildView HOMEPAGE, setNowShowing) + a clock. Node just opens +
writes. Cheap to replicate if H4/H6 don't pan out.

## Log
- SEND_LEN checked → 64 both → H2 ruled out.
- Dispatched firmware RE for the display/commit trigger (H6).
- Applied H4 (settle before view switch, match browser).
- **DECISIVE (user, on-device):** the stock firmware ships with Fn+0/9/8 = switch to gif/main/picture
  views, and pressing the physical Fn+picture key WORKS — it displays the picture page. But it shows
  the OLD picture, NOT our freshly-written now-playing frame. So:
  - **H4 (timing) RULED OUT** — a correct, human-timed view switch still shows the old frame.
  - **H3/view-command RULED OUT** — the real view-switch (the keycode path) fires and still shows old.
  - **H6 CONFIRMED as the direction:** our write (549/549 acked) lands in a buffer/SLOT that the
    picture view does not display. It's a write-TARGET problem — the announce(0x10) write goes to a
    different slot than the one the picture view (0x0d) reads. Need: how the write-slot and the
    display-slot relate, and how to target the displayed one (a picture-index byte? a specific slot?).
    This is exactly what the firmware-RE subagent is tracing.
  - Note: Fn+9 = main page displays reliably → the 96×64 main page is a proven fallback surface for
    now-playing if the picture-slot targeting turns out to be vendor-only.
