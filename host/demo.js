// Device-free demo: render a sequence of clock frames, send each through the real protocol.js
// builders (full transfer or region update, chosen by the diff), let the mock transport reassemble
// them like the device would, and ASSERT the reassembly equals the intended frame. Saves PNGs.
//
//   node host/demo.js   (or: npm --prefix host run demo)
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { MockTransport } from './transport-mock.js';
import { renderClock } from './apps/clock.js';
import { diffRegion } from './lib/diff.js';
import { buildImageTransfer, buildImageRegion, BLOCK, BLOCK_COUNT } from '../src/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const mock = new MockTransport();
let prev = null;

function tick(date, label, file) {
  const fb = renderClock(date);
  const d = diffRegion(prev, fb);
  let kind, packets = [];
  if (!d.changed) {
    kind = 'no change (skip)';
  } else if (d.full) {
    packets = buildImageTransfer(fb);
    kind = `FULL  (${packets.length} pkts, ${BLOCK_COUNT} blocks)`;
  } else {
    packets = buildImageRegion(fb, d.start, d.end);
    kind = `region ${String(d.blocks).padStart(3)} blocks (${packets.length} pkts, ~${d.blocks * BLOCK}B vs ${BLOCK_COUNT * BLOCK}B full)`;
  }
  if (packets.length) mock.send(packets);
  prev = fb;
  const ok = Buffer.compare(Buffer.from(mock.frame()), Buffer.from(fb)) === 0;
  mock.savePNG(join(OUT, file));
  console.log(`  ${label.padEnd(20)} -> ${kind.padEnd(52)} reassembly ${ok ? 'OK' : 'MISMATCH ***'}`);
  return ok;
}

console.log('AL80 host — mock clock demo (no device)\n');
let allOk = true;
const T = (h, m, s) => new Date(2026, 6, 2, h, m, s); // Thu Jul 02 2026, local time
allOk = tick(T(14, 9, 42), 'first frame', 'clock-1-full.png') && allOk;
allOk = tick(T(14, 9, 43), '+1 second', 'clock-2-sec.png') && allOk;
allOk = tick(T(14, 9, 43), 'same second', 'clock-3-same.png') && allOk;
allOk = tick(T(14, 10, 0), 'minute rollover', 'clock-4-min.png') && allOk;
allOk = tick(T(15, 0, 0), 'hour rollover', 'clock-5-hour.png') && allOk;

console.log('\nstats:', JSON.stringify(mock.stats));
const pass = allOk && mock.stats.badChecksums === 0;
console.log(
  mock.stats.badChecksums ? `bad checksums: ${mock.stats.badChecksums} *** BUILDER BUG ***` : 'checksums: all valid',
);
console.log('\nPNGs written to', OUT);
console.log(pass ? 'ALL OK — protocol builders + region diff validated device-free.' : '*** FAILURES ***');
process.exit(pass ? 0 : 1);
