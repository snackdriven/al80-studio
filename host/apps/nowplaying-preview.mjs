// Device-free preview for the now-playing app. Renders sample states, pushes each through the
// REAL protocol.js builders, lets the mock transport reassemble them like the panel would, asserts
// the reassembly matches the intended frame (proving buildImageTransfer's packet stream is valid),
// and writes preview PNGs next to this file.
//
//   node host/apps/nowplaying-preview.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MockTransport } from '../transport-mock.js';
import { render } from './nowplaying.js';
import { buildImageTransfer } from '../../src/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// A fake 96x96 album-art buffer (soft two-axis gradient) to exercise the real-art blit path — this
// is exactly the shape host/lib/art-cache.js will hand in once JPEG decode exists.
function fakeArt() {
  const buf = new Uint8Array(96 * 96 * 3);
  for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
    const i = (y * 96 + x) * 3;
    buf[i] = 30 + x * 2;           // R ramps across
    buf[i + 1] = 40 + y;           // G ramps down
    buf[i + 2] = 120 - (x + y);    // B falls off
  }
  return buf;
}

const samples = [
  { file: 'nowplaying-preview-1-short.png', label: 'short title + placeholder art',
    state: { title: 'Redbone', artist: 'Childish Gambino', progress: 0.42, paused: false, elapsedMs: 132000, durationMs: 327000 } },
  { file: 'nowplaying-preview-2-long.png', label: 'very long title (ellipsized)',
    state: { title: 'Everything In Its Right Place (Live From The Basement Extended Reprise)', artist: 'Radiohead', progress: 0.08, paused: false, elapsedMs: 20000, durationMs: 251000 } },
  { file: 'nowplaying-preview-3-paused.png', label: 'paused state',
    state: { title: 'Nights', artist: 'Frank Ocean', progress: 0.73, paused: true, elapsedMs: 227000, durationMs: 307000 } },
  { file: 'nowplaying-preview-4-realart.png', label: 'real-art blit path (fake 96x96 RGB)',
    state: { title: 'Real Art Path', artist: 'Decoded JPEG', artRGB: fakeArt(), progress: 0.55, paused: false } },
];

console.log('AL80 now-playing preview (no device)\n');
let allOk = true;
for (const s of samples) {
  const mock = new MockTransport();     // fresh panel per sample -> forces a full transfer
  const fb = render(s.state);
  const packets = buildImageTransfer(fb);
  mock.send(packets);
  const ok = Buffer.compare(Buffer.from(mock.frame()), Buffer.from(fb)) === 0;
  mock.savePNG(join(HERE, s.file), 3);
  allOk = allOk && ok && mock.stats.badChecksums === 0;
  console.log(`  ${s.label.padEnd(38)} ${packets.length} pkts  reassembly ${ok ? 'OK' : 'MISMATCH ***'}  chk ${mock.stats.badChecksums === 0 ? 'ok' : 'BAD'}  -> ${s.file}`);
}
console.log('\n' + (allOk ? 'ALL OK — layout rendered + protocol packet stream validated device-free.' : '*** FAILURES ***'));
process.exit(allOk ? 0 : 1);
