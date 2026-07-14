# AGENTS.md

## Project Shape

This repo is the public browser app and Node host for the YUNZII AL80. It drives
the LCD, RGB lighting, VIA-style keymap editor, now-playing/weather cards, and
the always-on local host. The protocol research and canonical byte-level notes
live in the sibling `al80-lcd` repo.

Start with these files:

- `README.md` - app overview, current status, and main development commands.
- `src/protocol.js` - shared pure protocol builders. No DOM, no HID, unit-tested.
- `src/hid.js` - WebHID transport for the browser app.
- `src/ui.js`, `index.html`, `styles.css` - vanilla browser UI, no build step.
- `test/` - root browser/protocol/keymap/music/weather tests.
- `host/README.md` and `host/RUNBOOK.md` - always-on Node host entry points.
- `host/cycle-run.mjs` and `host/cycle.js` - current host launcher and rotation FSM.
- `host/device.js` - real node-hid device path, ACK-gated and settle-timed.
- `wiki/` - rendered public wiki output copied from `al80-lcd/wiki/site`.

If repo docs and code comments disagree about protocol details, trust
`al80-lcd/AL80_KNOWLEDGE_BASE.md`, then root `README.md`, then tests/current
builders. Known trap: stale comments may still mention the old column-major or
`112x137` theory. Current picture page is `96x160`, RGB565 big-endian,
row-major, with a 32-byte tail block.

## Safety Rules

- Do not emit HID bootloader/DFU commands `0xB0` through `0xB7`.
- Keep protocol changes inside the opcode whitelist in `src/protocol.js`.
- The keyboard raw-HID interface is single-opener. Close the app tab, VIA,
  YUNZII software, and the Node host before running another live device path.
- Hardware sends must stay explicit. Dry-run/mock-device tests are not the same
  as proving the physical keyboard rendered correctly.
- Do not commit `host/.env`, Spotify tokens, local auth files, or generated host
  `out/` images.

## Commands

Root tests:

```bash
npm test
```

Run the browser app locally:

```bash
python -m http.server 8137
# open http://localhost:8137
```

Host setup and tests:

```bash
cd host
npm install
npm test
node cycle-run.mjs --mock-device
node cycle-run.mjs --live
node cycle-run.mjs --live --sync
node cycle-run.mjs --only=nowplaying --mock-device
```

Spotify auth for live now-playing:

```bash
cd host
node spotify-auth.mjs <spotify-client-id>
```

Run `spotify-auth.mjs` before hand-editing `host/.env`; it overwrites that file
when it writes the refresh token. Weather defaults to Detroit and needs no key.

## Working Rules

- Check `git status --short --branch` before edits. This repo often has local
  host experiments, cover art, and daemon work in flight.
- Stage files by name. Avoid broad `git add .`; `wiki/`, host previews, cover
  art, and generated files can sit next to source changes.
- `daemon.js`, `transport-hid.js`, and the old single-panel launchers are
  reference/debug paths unless the task explicitly targets them. The current
  always-on host is `cycle-run.mjs`.
- `wiki/` is rendered output from `al80-lcd`; do not hand-edit it for source
  docs changes. Edit `al80-lcd/wiki/` and deploy from there.
- For protocol changes, run `npm test` from repo root. If packet shape changes,
  add or update a known vector in `test/protocol.test.mjs`.
- For host logic changes, run `cd host && npm test`, plus the narrow test file
  for the touched area when useful.
- For frontend UI changes, serve the app locally and exercise the workflow in a
  browser at `1920x1080` before calling it done.
- For live host/device changes, run a mock-device check first, then say plainly
  whether the physical keyboard was tested.
- Do not add AI/Codex attribution to commits, docs, release notes, or PR text.

