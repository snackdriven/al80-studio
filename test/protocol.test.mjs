// Offline protocol tests — no hardware. Known-good vectors from the verified captures,
// plus an optional cross-check against the sibling al80-lcd raw capture if present.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  yne, ga, build, announce, finish, rgb565BE, buildImageTransfer, buildClock, clockFromDate,
  buildView, VIEW, FRAME_BYTES, BLOCK_COUNT, toHex,
  buildMainPageGif, buildMainPageImage, MP_FRAME_BYTES, MP_MAX_FRAMES,
} from '../src/protocol.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };
const hex = (arr) => Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join(' ');

console.log('AL80 Studio protocol tests\n');

ok('yne is a little-endian 16-bit additive sum', () => {
  assert.deepEqual(yne([0x41, 0x03, 0x10, 0x20]), [0x74, 0x00]);
  // homepage announce logical bytes sum to 339 = 0x0153 -> [0x53, 0x01]
  assert.deepEqual(yne([0x40, 0, 0, 7, 0, 0, 0, 0xa5, 0x5a, 0x0b, 0, 0, 0x02, 0x00]), [0x53, 0x01]);
});

ok('ga = CRC16-MODBUS, big-endian, matches every known announce CRC', () => {
  assert.deepEqual(ga([0x09, 0, 0x03]), [0xc3, 0xe1]); // time
  assert.deepEqual(ga([0x0a, 0, 0x04]), [0x01, 0x50]); // date
  assert.deepEqual(ga([0x10, 0, 0x01]), [0xc5, 0xb1]); // image
  assert.deepEqual(ga([0x0b, 0, 0x00]), [0x02, 0x00]); // homepage
});

ok('build enforces the opcode whitelist (DFU impossible)', () => {
  assert.throws(() => build(0xb1, []), /whitelist/); // toBootLoader must never build
  assert.throws(() => build(0xb4, []), /whitelist/);
});

ok('rgb565 big-endian: red = F8 00, green = 07 E0, blue = 00 1F', () => {
  assert.deepEqual(Array.from(rgb565BE([255, 0, 0, 255])), [0xf8, 0x00]);
  assert.deepEqual(Array.from(rgb565BE([0, 255, 0, 255])), [0x07, 0xe0]);
  assert.deepEqual(Array.from(rgb565BE([0, 0, 255, 255])), [0x00, 0x1f]);
});

ok('image announce is byte-identical to the captured one', () => {
  const a = buildImageTransfer(new Uint8Array(FRAME_BYTES))[0];
  assert.equal(hex(a).startsWith('40 00 00 08 cf 02 00 a5 5a 10 00 01 c5 b1 01'), true, hex(a));
});

ok('still-image transfer = announce + setup + 548 data + finish; setup matches capture', () => {
  const pkts = buildImageTransfer(new Uint8Array(FRAME_BYTES));
  assert.equal(pkts.length, 1 + 1 + BLOCK_COUNT + 1); // 551 (announce, setup, 548, finish)
  assert.equal(hex(pkts[1]).startsWith('41 00 00 07 21 03 00 a5 5a 0c 78 00 c3 93'), true, hex(pkts[1]));
  const data = pkts.slice(2, -1);
  assert.equal(data.length, 548);
  data.forEach((p, k) => {
    assert.equal(p[0], 0x41);
    assert.equal(p[3], 0x38); // 56
    assert.equal(p[1] | (p[2] << 8), k * 56); // offset little-endian
  });
  assert.equal((data.at(-1)[1] | (data.at(-1)[2] << 8)), 30632);
  assert.equal(hex(pkts.at(-1)).startsWith('42 00 00 38 7a'), true); // finish
  // every checksum recomputes
  for (const p of data) {
    const body = [...p]; const c4 = body[4], c5 = body[5]; body[4] = 0; body[5] = 0;
    assert.deepEqual(yne(body), [c4, c5]);
  }
});

ok('clock time announce is byte-identical to the shipped clock tooling', () => {
  const p = buildClock({ h: 15, m: 47, s: 9, year: 26, month: 7, day: 2, dow: 4 }, true);
  assert.equal(hex(p[0]).startsWith('40 00 00 07 f6 02 00 a5 5a 09 00 03 c3 e1'), true, hex(p[0]));
  // 12hr: 15 -> 3; time data packet payload starts at byte 7
  assert.equal(p[1][7], 3);
  assert.equal(p[1][3], 0x03); // subcmd/len
  // sent 3x -> 18 packets
  assert.equal(p.length, 18);
});

ok('date payload order = [YY, dayOfWeek, month, day]', () => {
  const p = buildClock({ h: 0, m: 0, s: 0, year: 26, month: 7, day: 2, dow: 4 }, false);
  const dateData = p[4];
  assert.deepEqual([dateData[7], dateData[8], dateData[9], dateData[10]], [26, 4, 7, 2]);
});

ok('view switch = homepage/picture/gif announce + finish', () => {
  assert.equal(buildView(VIEW.GIF).length, 2);
  assert.equal(buildView(VIEW.HOMEPAGE)[0][9], 0x0b);
  assert.equal(buildView(VIEW.PICTURE)[0][9], 0x0d);
  assert.equal(buildView(VIEW.GIF)[0][9], 0x0f);
});

ok('clockFromDate produces a valid 18-packet transfer', () => {
  const p = clockFromDate(new Date(2026, 6, 2, 15, 47, 9), true);
  assert.equal(p.length, 18);
});

ok('main-page GIF control packets are byte-identical to the live capture', () => {
  const f = new Uint8Array(MP_FRAME_BYTES);
  const p = buildMainPageGif([f, f], 4); // 2 frames, fps 4 (matches the capture's fps)
  assert.equal(hex(p[0]).startsWith('40 00 00 09 b2 01 00 a5 5a 12 00 02 04 50 02 00'), true, hex(p[0])); // announce mode2
  assert.equal(hex(p[1]).startsWith('41 00 00 09 25 02 00 a5 5a 13 00 02 c4 01 02 00'), true, hex(p[1])); // setup19
  assert.equal(hex(p[2]).startsWith('41 00 00 0a 95 01 00 a5 5a 10 00 03 04 30 02 02'), true, hex(p[2])); // per-frame header
  assert.equal(hex(p[3]).startsWith('41 00 00 07 82 02 00 a5 5a 11 30 00 c5 35'), true, hex(p[3])); // per-frame length (0x30)
  assert.equal(hex(p.at(-2)).startsWith('41 00 00 09 29 02 00 a5 5a 13 00 02 c4 01 02 04'), true, hex(p.at(-2))); // fps=4
  assert.equal(hex(p.at(-1)).startsWith('42 00 00 38 7a'), true); // finish
});

ok('main-page GIF structure: 12 banks/frame, offsets reset per 1024, 228 data blocks/frame', () => {
  const p = buildMainPageGif([new Uint8Array(MP_FRAME_BYTES), new Uint8Array(MP_FRAME_BYTES)], 30);
  assert.equal(p.length, 2 + 2 * (2 + 228) + 3); // 465
  const data = p.slice(4, 4 + 228); // first frame's data blocks
  assert.equal(data[0][1] | (data[0][2] << 8), 0);
  assert.equal(data[17][3], 0x38); // 18th block is 56 bytes
  assert.equal(data[18][1] | (data[18][2] << 8), 0x3f0); // 19th block at 0x3F0
  assert.equal(data[18][3], 0x10); // ...and is 16 bytes
  assert.equal(data[19][1] | (data[19][2] << 8), 0); // next bank resets to offset 0
});

ok('main-page: frame count in finish-18, fps clamped 1..60, 42-frame cap', () => {
  const f = new Uint8Array(MP_FRAME_BYTES);
  assert.equal(buildMainPageImage(f).at(-3)[15], 1); // still image = 1 frame
  const many = buildMainPageGif(Array.from({ length: 50 }, () => f), 999);
  assert.equal(many.at(-3)[15], MP_MAX_FRAMES); // count byte capped at 42
  assert.equal(many.at(-2)[15], 60); // fps clamped to 60
});

// Optional: cross-check block structure against the real sibling capture, if present.
const cap = '../al80-lcd/research/image_capture/testpattern_capture_raw.json';
if (existsSync(cap)) {
  ok('block offsets match the real testpattern capture', () => {
    const recs = JSON.parse(readFileSync(cap, 'utf8'))
      .map((r) => r.hex.split(' ').map((x) => parseInt(x, 16)))
      .filter((b) => b[0] === 0x41 && (b[3] === 0x38 || b[3] === 0x10) && !(b[7] === 0xa5 && b[8] === 0x5a));
    const capOffsets = [...new Set(recs.map((b) => b[1] | (b[2] << 8)))].sort((a, b) => a - b);
    const mine = buildImageTransfer(new Uint8Array(FRAME_BYTES)).slice(2, -1).map((p) => p[1] | (p[2] << 8));
    assert.deepEqual(mine, capOffsets);
  });
} else {
  console.log('  (skipped sibling-capture cross-check — al80-lcd not adjacent)');
}

console.log(`\n${pass} checks passed.`);
