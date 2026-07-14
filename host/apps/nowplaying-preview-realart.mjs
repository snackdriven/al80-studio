// Device-free preview proving REAL Spotify album art renders on the now-playing screen. Decodes an
// actual i.scdn.co cover JPEG -> 96x96 RGB (lib/art.js) -> feeds it as state.artRGB into the real
// render(), pushes the frame through the REAL protocol.js packet builders, reassembles via the mock
// transport (same as the device), asserts the reassembly equals the canonical row-major frame, and
// writes the preview PNG.
//
//   node host/apps/nowplaying-preview-realart.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { MockTransport } from '../transport-mock.js';
import { render } from './nowplaying.js';
import { decodeToRGB96, ART_RGB_BYTES, dominantColor } from '../lib/art.js';
import { buildImageTransfer, WIDTH, HEIGHT } from '../../src/protocol.js';
import { encodePNG, rgb565ToRGB } from '../lib/png.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Write a canonical (row-major) RGB565 frame to a PNG at integer zoom — the real visible layout. */
function savePNG(path, fb, scale = 3) {
  const { rgb, width, height } = rgb565ToRGB(fb, WIDTH, HEIGHT, scale);
  writeFileSync(path, encodePNG(width, height, rgb));
}

const samples = [
  { jpg: 'cover-daftpunk-ram.jpg', out: 'nowplaying-preview-realart-live.png',
    title: 'Get Lucky', artist: 'Daft Punk', progress: 0.34, paused: false, elapsedMs: 129000, durationMs: 369000 },
  { jpg: 'cover-drake-scorpion.jpg', out: 'nowplaying-preview-realart-live-2.png',
    title: "God's Plan", artist: 'Drake', progress: 0.61, paused: false, elapsedMs: 200000, durationMs: 199000 },
];

console.log('AL80 now-playing — REAL album art preview (no device)\n');
const available = samples.filter((s) => existsSync(join(HERE, s.jpg)));
if (!available.length) {
  console.log('No local cover JPEGs found. Put sample JPGs next to this script to run the real-art preview.');
  process.exit(0);
}
let allOk = true;
for (const s of available) {
  const jpegBuf = readFileSync(join(HERE, s.jpg));
  const artRGB = decodeToRGB96(jpegBuf);
  if (artRGB.length !== ART_RGB_BYTES) throw new Error(`bad artRGB length ${artRGB.length}, want ${ART_RGB_BYTES}`);

  const state = { title: s.title, artist: s.artist, artRGB, progress: s.progress, paused: s.paused, elapsedMs: s.elapsedMs, durationMs: s.durationMs };
  const fb = render(state);

  const mock = new MockTransport();               // fresh panel -> full transfer
  const packets = buildImageTransfer(fb);
  mock.send(packets);
  const ok = Buffer.compare(Buffer.from(mock.frame()), Buffer.from(fb)) === 0;
  savePNG(join(HERE, s.out), fb, 3);              // PNG from the row-major frame = the visible layout
  allOk = allOk && ok && mock.stats.badChecksums === 0;
  const { hue, sat } = dominantColor(artRGB);
  console.log(`  ${(s.artist + ' — ' + s.title).padEnd(28)} decoded ${artRGB.length}B  ${packets.length} pkts  wire ${ok ? 'OK' : 'MISMATCH ***'}  chk ${mock.stats.badChecksums === 0 ? 'ok' : 'BAD'}  accent hue ${hue.toFixed(0)}° sat ${sat.toFixed(2)}  -> ${s.out}`);
}
console.log('\n' + (allOk ? 'ALL OK — real cover decoded, rendered at 96x96, dominant color extracted, protocol validated device-free.' : '*** FAILURES ***'));
process.exit(allOk ? 0 : 1);
