# AL80 Studio

A WebHID control panel for the **YUNZII AL80** keyboard's LCD — an open replacement for
yunzii-game.com, built on the fully reverse-engineered HID protocol. Set a **12-hour clock**
(the vendor won't), push any **image** or **GIF**, switch **views**, and build **keymap
shortcuts** — all client-side, no vendor site, no account.

**Live:** https://snackdriven.github.io/al80-studio/ · Requires **Chrome or Edge** (WebHID).

> Protocol, captures, and the full write-up live in the sibling `al80-lcd` repo
> (`AL80_KNOWLEDGE_BASE.md`). This repo is the app.

## Use it

1. Plug the AL80 in (wired). **Close the yunzii-game.com tab and VIA** — only one program can
   hold the LCD interface at a time.
2. Open the site, click **Connect**, pick the AL80.
3. Tabs: **Clock** (12/24hr + auto-resync) · **Image** (fit/brightness/grayscale/dither → send)
   · **GIF** (frames + FPS, *experimental*) · **View** (switch/clear) · **Shortcuts** (preset
   library → export VIA keymap JSON to load in usevia.app).

## How it works

Everything is one HID protocol over interface `0xFF60` (VID `0x28E9` / PID `0x30AF`):
`0x40` announce → `0x41` data → `0x42` finish, 64-byte reports, a 16-bit additive checksum,
CRC16-MODBUS announces, RGB565 big-endian pixels (112×137). See the knowledge base for the
byte-level detail.

- `src/protocol.js` — pure builder for every op. **No DOM/HID; unit-tested offline** against
  the real captures. The opcode whitelist makes firmware/DFU commands impossible by construction.
- `src/hid.js` — WebHID transport (connect / send / disconnect).
- `src/image.js`, `src/gif.js` — canvas fit/bake → RGB565; GIF frames via `ImageDecoder`.
- `src/keymap.js` — preset library + VIA keymap JSON import/export.
- `src/ui.js` + `index.html` + `styles.css` — the tabbed UI. Vanilla ES modules, **no build**.

## Develop

    npm test                      # offline protocol tests (no hardware)
    python -m http.server 8137    # then open http://localhost:8137 (WebHID needs https/localhost)

## Status & caveats

- **Solid:** clock, still image, view/clear, shortcuts — the protocol core is verified
  byte-for-byte against captures.
- **Experimental:** GIF. The source-derived wire path differs from what our capture showed;
  confirm on-device. The still-image path is the proven one.
- **On-device unknown:** WebHID `sendReport` here uses 64 bytes (MDN-correct); if a firmware rev
  needs 63, flip `SEND_LEN` in `hid.js`. Test the clock first — it's the smallest safe transfer.
- **Safety:** the builder only ever emits `0x40/0x41/0x42` (+ status). It cannot send the
  `0xB0–0xB7` bootloader/DFU commands.
