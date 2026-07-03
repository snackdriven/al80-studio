// M0 spike: prove native transport. Open the AL80 0xFF60/0x61 interface with node-hid, push a
// clock via the existing protocol.js, and read the device's ACK echoes to confirm delivery
// eyes-free (byte6=0x55, same signal we verified over WebHID). Clock is the smallest/safest write.
import HID from 'node-hid';
import * as proto from '../src/protocol.js';

const info = HID.devices().find(
  (d) => d.vendorId === 0x28e9 && d.productId === 0x30af && d.usagePage === 0xff60 && d.usage === 0x61,
);
if (!info) { console.log('FAIL: no 0xFF60/0x61 interface enumerated'); process.exit(2); }

let dev;
try { dev = new HID.HID(info.path); }
catch (e) { console.log('FAIL: could not OPEN interface:', e.message); console.log('(likely still held by the browser/vendor app — the single-opener rule)'); process.exit(3); }
console.log('OPENED', info.path);

const echoes = [];
dev.on('data', (buf) => echoes.push(Array.from(buf.subarray(0, 16))));
dev.on('error', (e) => console.log('read error:', e.message));

// node-hid write on Windows: prepend the reportId (0 for unnumbered) to the report body.
const write = (pkt, bodyLen) => dev.write([0x00, ...Array.from(pkt.subarray(0, bodyLen))]);

async function pushClock(bodyLen) {
  echoes.length = 0;
  const packets = proto.clockFromDate(new Date(), true);
  let written = 0, err = null;
  for (const p of packets) {
    try { write(p, bodyLen); written++; }
    catch (e) { err = e.message; break; }
  }
  await new Promise((r) => setTimeout(r, 400));
  return { bodyLen, written, total: packets.length, err, echoes: echoes.length, acks: echoes.filter((e) => e[6] === 0x55).length };
}

const r64 = await pushClock(64);
console.log('body=64:', JSON.stringify(r64));
let best = r64;
if (r64.echoes === 0 && !r64.err) { const r63 = await pushClock(63); console.log('body=63:', JSON.stringify(r63)); if (r63.echoes > best.echoes) best = r63; }

if (best.echoes > 0) {
  console.log('\nSUCCESS — native transport works. body length', best.bodyLen, ', echoes', best.echoes, ', ACKs(0x55)', best.acks);
  console.log('sample echo:', (echoes[0] || []).map((x) => x.toString(16).padStart(2, '0')).join(' '));
  console.log('VERDICT: GO NATIVE.');
} else if (best.err) {
  console.log('\nWRITE FAILED:', best.err, '\nVERDICT: investigate write length / reportId, or fall back to kiosk.');
} else {
  console.log('\nWrote', best.written, 'packets but got NO echoes. Writes may be one-way here.');
  console.log('VERDICT: transport partially works (blind writes) — check the LCD for a clock; native still viable without the echo channel.');
}
dev.close();
process.exit(best.echoes > 0 ? 0 : 1);
