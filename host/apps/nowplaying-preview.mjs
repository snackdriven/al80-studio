// Device-free preview for the now-playing app. Renders sample states (mock Spotify data + a real
// cover JPEG decoded through lib/art.js), writes each as a PNG so the LAYOUT is visible, and ALSO
// validates the real protocol.js packet stream: it pushes every frame through buildImageTransfer,
// lets the mock transport reassemble the packets exactly like the panel would, and asserts the
// reassembly equals the column-major WIRE form of the frame (buildImageTransfer transposes row-major
// -> column-major for the AttackShark scan order). The PNG is written from the canonical row-major
// frame — that's what the panel actually shows after its column-major scan un-does the transpose.
//
//   node host/apps/nowplaying-preview.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { MockTransport } from '../transport-mock.js';
import { render } from './nowplaying.js';
import { decodeToRGB96, ART_RGB_BYTES, dominantColor } from '../lib/art.js';
import { getNowPlayingMock } from '../lib/spotify.js';
import { buildImageTransfer, transposeToColMajor, WIDTH, HEIGHT, FRAME_BYTES } from '../../src/protocol.js';
import { encodePNG, rgb565ToRGB } from '../lib/png.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Write a canonical (row-major) RGB565 frame to a PNG at integer zoom — the real visible layout. */
function savePNG(path, fb, scale = 3) {
  const { rgb, width, height } = rgb565ToRGB(fb, WIDTH, HEIGHT, scale);
  writeFileSync(path, encodePNG(width, height, rgb));
}

/** Decode a cover JPEG next to this file into the 96x96 artRGB buffer render() blits. */
function coverArt(name) {
  const rgb = decodeToRGB96(readFileSync(join(HERE, name)));
  if (rgb.length !== ART_RGB_BYTES) throw new Error(`bad artRGB length ${rgb.length}, want ${ART_RGB_BYTES}`);
  return rgb;
}

// Base sample: a real mock track from spotify.getNowPlayingMock() (no creds, no network).
const mock = getNowPlayingMock();

const daftArt = coverArt('cover-daftpunk-ram.jpg');
const drakeArt = coverArt('cover-drake-scorpion.jpg');

const samples = [
  { file: 'nowplaying-preview-1-short.png', label: 'short title + placeholder art',
    state: { title: 'Redbone', artist: 'Childish Gambino', progress: 0.42, paused: false, elapsedMs: 132000, durationMs: 327000 } },
  { file: 'nowplaying-preview-2-long.png', label: 'very long title (ellipsized)',
    state: { title: 'Everything In Its Right Place (Live From The Basement Extended Reprise)', artist: 'Radiohead', progress: 0.08, paused: false, elapsedMs: 20000, durationMs: 251000 } },
  { file: 'nowplaying-preview-3-paused.png', label: 'paused state + placeholder art',
    state: { title: 'Nights', artist: 'Frank Ocean', progress: 0.73, paused: true, elapsedMs: 227000, durationMs: 307000 } },
  { file: 'nowplaying-preview-4-realart.png', label: 'mock track + REAL cover (Daft Punk)',
    state: { ...mock, artRGB: daftArt } },
  { file: 'nowplaying-preview-5-realart-drake.png', label: 'real cover (Drake) — accent from art',
    state: { title: "God's Plan", artist: 'Drake', artRGB: drakeArt, progress: 0.61, paused: false, elapsedMs: 121000, durationMs: 199000 } },
];

console.log('AL80 now-playing preview (no device)\n');
let allOk = true;
for (const s of samples) {
  const fb = render(s.state);
  if (fb.length !== FRAME_BYTES) { console.log(`  *** ${s.file}: frame is ${fb.length}B, want ${FRAME_BYTES}`); allOk = false; continue; }

  // protocol round-trip: reassembled packets must equal the column-major wire form of the frame.
  const mockT = new MockTransport();            // fresh panel -> forces a full transfer
  const packets = buildImageTransfer(fb);
  mockT.send(packets);
  const wire = transposeToColMajor(fb, WIDTH, HEIGHT);
  const ok = Buffer.compare(Buffer.from(mockT.frame()), Buffer.from(wire)) === 0;

  savePNG(join(HERE, s.file), fb, 3);           // PNG from the row-major frame = the visible layout
  allOk = allOk && ok && mockT.stats.badChecksums === 0;

  const art = s.state.artRGB ? dominantColor(s.state.artRGB) : null;
  const accentNote = art ? `accent hue ${art.hue.toFixed(0)}° sat ${art.sat.toFixed(2)}` : 'placeholder accent';
  console.log(`  ${s.label.padEnd(40)} ${packets.length} pkts  wire ${ok ? 'OK' : 'MISMATCH ***'}  chk ${mockT.stats.badChecksums === 0 ? 'ok' : 'BAD'}  ${accentNote}  -> ${s.file}`);
}
console.log('\n' + (allOk ? 'ALL OK — layout rendered (96x160, 30720B) + protocol packet stream validated device-free.' : '*** FAILURES ***'));
process.exit(allOk ? 0 : 1);
