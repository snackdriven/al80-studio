# AL80 Studio

A WebHID control panel for the **YUNZII AL80** keyboard — an open replacement for
yunzii-game.com, built on the reverse-engineered HID protocol. Drive the **LCD** (12-hour
clock, stills, GIFs, a picture slideshow), recolor the **RGB** (built-in effects plus
multi-color software effects and saved palettes), and edit the **keymap** live (a VIA-style
editor). All client-side — no vendor site, no account.

**Live:** https://snackdriven.github.io/al80-studio/ · Requires **Chrome or Edge** (WebHID).

> Protocol, captures, and the full write-up live in the sibling `al80-lcd` repo
> (`AL80_KNOWLEDGE_BASE.md`). This repo is the app.

## Use it

1. Plug the AL80 in (wired). **Close the YUNZII web app and VIA** — only one program can hold
   the keyboard's HID interface at a time.
2. Open the site, click **Connect**, pick the AL80.
3. Three sections:
   - **LCD** — Clock (12/24hr + auto-resync), Picture (fit / brightness / contrast / saturation
     / grayscale / dither, to the main or picture page), GIF (frames + FPS), Slideshow (up to 16
     stills, auto-cycle). Everything is editable and previewable offline; only *Send* needs the
     device.
   - **Keymap** — a live VIA editor. Read and write keys in real time, or edit the factory
     layout offline and import/export VIA JSON. Layers, the encoder, and a switch-matrix key
     tester. Arrow keys move between tabs/layers; the keycode picker is a proper modal.
   - **Lighting** — one color (built-in on-board effects), two colors (software strobe / cycle /
     breathe), or two-to-six (saved palettes). The multi-color modes stream from the browser and
     stop on disconnect.

A small Node host under `host/` pushes **Spotify now-playing** (cover art + track) to the LCD
over the same protocol — see `host/nowplaying-run.mjs`.

## How it works

One HID protocol over interface `0xFF60` (VID `0x28E9` / PID `0x30AF`): `0x40` announce →
`0x41` data → `0x42` finish, 64-byte reports, a 16-bit additive checksum, CRC16-MODBUS
announces, RGB565 **big-endian, row-major** pixels. The picture page is **96×160**, the main
page 96×64. See the knowledge base for byte-level detail.

- `src/protocol.js` — pure builder for every op. **No DOM/HID; unit-tested offline** against the
  real captures. The opcode whitelist makes firmware/DFU commands impossible by construction.
- `src/hid.js` — WebHID transport (connect / send / disconnect).
- `src/image.js`, `src/gif.js` — canvas fit/bake → RGB565; GIF frames via `ImageDecoder`.
- `src/keymap.js` — the AL80 matrix/layout, the factory default layer, VIA keycode ⇄ number,
  and keymap JSON import/export. **Unit-tested offline.**
- `src/ui.js` + `index.html` + `styles.css` — the UI. Vanilla ES modules, **no build step**.

## Develop

    npm test                      # offline protocol + keymap tests (no hardware)
    python -m http.server 8137    # then open http://localhost:8137 (WebHID needs https/localhost)

`lab.html` (linked in the footer) is a scratch page for picture-page banding experiments.

## Status & caveats

- **Solid:** clock, still image (main + picture page), view switching, RGB lighting, and the
  live keymap editor — verified byte-for-byte against captures and confirmed on-device.
- **Picture display:** committing a still needs a short settle after the setup packet (the
  `PK_ADD_PIC` commit) and **no** trailing view-toggle, or the frame lands in scratch and the old
  picture stays. GIF is partly source-derived; confirm on-device.
- **Encoder direction:** fixed 2026-07-04. The array is `[ccw, cw]` (index 0 = counter-clockwise)
  per VIA/QMK — confirmed on-device (knob right = volume up = cw = the factory array's index 1).
  Earlier builds read index 0 as cw, so the offline label and exported JSON had the two directions
  swapped.
- **Safety:** the builder only ever emits `0x40/0x41/0x42` (+ status). It cannot send the
  `0xB0–0xB7` bootloader/DFU commands.
