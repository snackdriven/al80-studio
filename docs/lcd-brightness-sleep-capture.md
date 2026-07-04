# Capture playbook: LCD brightness + screen sleep-timeout

**Goal:** recover the `A5 5A` opcode(s) for LCD **brightness** and **screen sleep-timeout** by
sniffing the vendor's Windows *Screen Software* while it changes them, so we can add
`buildLcdBrightness()` / `buildLcdSleep()` to `protocol.js` and surface a Brightness slider +
Sleep dropdown in the LCD section.

## Why a capture (not just docs)

The vendor doesn't publish the protocol, and these features live in the **A5 5A LCD protocol we
already speak** (not VIA — the AL80's VIA surface is keymap + RGB only). We already know the
framing and opcode table:

```
A5 5A | TYPE(1) | LEN(2, big-endian) | CRC16(2, MODBUS over TYPE+LEN) | DATA…
PK_* opcodes: 0x0b GO_HOME · 0x0c ADD_PIC · 0x0d TOGGLE_PIC · 0x0e DEL_PIC
              0x0f GO_GIF · 0x10 GUI_EVENT · 0x12 GIF_NUM · 0x13 GIF_FRAME
```

Brightness and sleep are almost certainly **new TYPE bytes** we haven't captured. One sniff gets
them.

## What you need

- The AL80, wired. **Close al80-studio and VIA** first (one opener).
- The vendor **Screen Software** (Windows) — the LCD control app (yunzii.com/pages/manuals, or
  the mega.nz link in the AL80 manual).
- **Wireshark + USBPcap** (USBPcap is an optional component in the Wireshark installer). USBPcap
  is a *kernel* USB capture, so it sees the traffic even though the vendor app owns the HID
  interface — you don't have to share the interface.

## Capture

1. Plug in the AL80. Start Wireshark and capture on the **USBPcapN** interface carrying the AL80
   (identify it by unplug/replug, or filter by VID `0x28E9` / PID `0x30AF`).
2. Open the vendor Screen Software; let it idle ~5s (baseline).
3. **Brightness:** drag the slider to distinct values with a pause between each — min, ~25%,
   ~50%, ~75%, max. Note the value + rough timestamp for each pause.
4. **Sleep-timeout:** set the sleep/timeout to each option, pausing between.
5. Stop and save the `.pcapng`.

## Analysis

1. Filter to HOST→device OUT reports on the AL80 (`usb.capdata` present; the 64-byte reports).
2. Inside each report payload, find frames starting `a5 5a`. The vendor uses the *same* raw-HID
   wrapper (`0x40` announce / `0x41` data / `0x42` finish) we do.
3. **Diff by value:** line up the frames sent at each brightness step. The byte(s) that move
   monotonically with the slider = the value; the constant byte just before = the **TYPE
   (opcode)**. Repeat for sleep-timeout.
4. Cross-check the TYPE against the PK_* table above — it'll be a new ordinal (likely `0x11`,
   `0x14`+, or similar).
5. Confirm the CRC follows CRC-16/MODBUS over TYPE+LEN (our convention), so we can rebuild it.

## Bring back (for each of brightness + sleep)

- The full frame bytes at 2–3 values.
- The TYPE (opcode) byte.
- Which byte(s) carry the value, and the range (e.g. brightness 0–255? 0–100?).
- Whether it's a one-shot `0x40` announce or needs `0x41` data + `0x42` finish.

With that: `buildLcdBrightness(v)` / `buildLcdSleep(sec)` (opcode-whitelisted), a Brightness
slider + Sleep dropdown in the LCD section, and a protocol test vector. ~30 min of build.

## While you're capturing — two freebies

- **Battery %:** watch for a device→host report carrying a plausible battery byte (the OLED shows
  charge, so the MCU has it — open question whether it's host-queryable over wired). If one
  appears, note it.
- **Encoder direction:** turn the knob right — does the volume go **up**? (See the encoder caveat
  in the README / the keymap notes. If right = down, the CW/CCW array order is confirmed backwards
  and gets a one-commit fix.)

## Fallbacks

- **Logic analyzer** on the USART3 line to the display module (see the `al80-lcd` logic-analyzer
  plan) — sees the module side directly; more invasive.
- If USBPcap won't isolate the interface: **Device Monitoring Studio** (Windows), or `usbmon` +
  Wireshark on Linux with the vendor app in a Windows VM.
