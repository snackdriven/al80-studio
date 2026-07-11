# AL80 Studio

A browser control panel for the **YUNZII AL80**, built on the reverse-engineered HID protocol. An open replacement for yunzii-game.com: drive the **LCD** (12-hour clock, stills, GIFs, a slideshow), recolor the **RGB**, and edit the **keymap** live. All client-side. No vendor site, no account.

**Live:** https://snackdriven.github.io/al80-studio/ (needs Chrome or Edge for WebHID).
**Docs:** the protocol, firmware, and a flashing walkthrough are in the [wiki](https://snackdriven.github.io/al80-studio/wiki/).

> The full write-up and captures live in the sibling `al80-lcd` repo. This one's the app.

## Use it

1. Plug the AL80 in (wired). Close the YUNZII web app and VIA first, only one program can hold the keyboard's HID interface at a time.
2. Open the site, hit **Connect**, pick the AL80.
3. Three sections:
   - **LCD** — clock (12/24hr + auto-resync), picture (fit / brightness / contrast / saturation / grayscale / dither, to the main or picture page), GIF, slideshow, plus live **now-playing** and **weather** cards. Everything's editable and previewable offline; only *Send* needs the device.
   - **Keymap** — a live VIA editor. Read and write keys in real time, or edit the factory layout offline and import/export VIA JSON. Layers, the encoder, a switch-matrix key tester.
   - **Lighting** — pick an RGB effect, color, brightness, speed. On the custom firmware this speaks **VialRGB**: the full effect list (cyclics, reactive, splash), an independently-colored side LED bar, and saved palettes. Software strobe/cycle/breathe stream from the browser and stop on disconnect. Opt-in **music mode** captures system audio and drives one color + brightness off the beat, save-less, on both stock and custom firmware.

A Node host under `host/` drives the LCD on its own, no browser tab. The always-on process (`host/cycle-run.mjs`) rotates **Spotify now-playing** (cover art + track), a **weather** card (Open-Meteo, no key), and the **clock**, and preempts to an alert card when something POSTs its local intake. It reconnects on unplug and can start at logon. `nowplaying-run.mjs` / `weather-run.mjs` are single-panel debug launchers over the same code. See `host/README.md`.

## How it works

One HID protocol over `0xFF60` (VID `0x28E9` / PID `0x30AF`): `0x40` announce, `0x41` data, `0x42` finish. 64-byte reports, a 16-bit additive checksum, CRC16-MODBUS announces, RGB565 **big-endian, row-major** pixels. Picture page 96×160, main page 96×64. Byte-level detail's in the wiki.

- `src/protocol.js` — pure builder for every op. No DOM/HID, unit-tested offline against real captures. The opcode whitelist makes DFU commands impossible by construction.
- `src/hid.js` — WebHID transport (connect / send / disconnect).
- `src/image.js`, `src/gif.js` — canvas → RGB565; GIF frames via `ImageDecoder`.
- `src/keymap.js` — the matrix/layout, the factory layer, VIA keycode ⇄ number, JSON import/export. Unit-tested.
- `src/ui.js` + `index.html` + `styles.css` — vanilla ES modules, no build step.

## Develop

    cd host && npm install        # once, for the host tests (node-hid)
    npm test                      # protocol, keymap, host + lighting tests, no hardware
    python -m http.server 8137    # then open http://localhost:8137

## Status & caveats

- **Solid:** clock, still image (both pages), view switching, RGB lighting, and the live keymap editor. Verified byte-for-byte against captures and confirmed on-device.
- **Picture commit:** a still needs a short settle after the setup packet and no trailing view-toggle, or the frame lands in scratch and the old picture stays.
- **Encoder direction:** the array is `[ccw, cw]` per VIA/QMK. Earlier builds read index 0 as cw and had the two directions swapped; fixed.
- **Safety:** the builder only ever emits `0x40/0x41/0x42` (+ status). It can't send the `0xB0–0xB7` bootloader/DFU commands.
