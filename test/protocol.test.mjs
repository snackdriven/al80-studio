// Offline protocol tests — no hardware. Known-good vectors from the verified captures,
// plus an optional cross-check against the sibling al80-lcd raw capture if present.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  yne, ga, build, announce, finish, rgb565BE, buildImageTransfer, buildClock, clockFromDate,
  buildView, VIEW, FRAME_BYTES, BLOCK_COUNT, toHex,
  buildDeletePicture, buildNextPicture, buildClearPicture, buildClearAllPictures,
  buildMainPageGif, buildMainPageImage, MP_FRAME_BYTES, MP_MAX_FRAMES,
  buildGifPage, buildStartupAnimation, GP_FRAME_BYTES, SA_FRAME_BYTES,
  buildLightBrightness, buildLightEffect, buildLightSpeed, buildLightColor, buildLightSave, buildLightGet,
  buildLightColorLive, transposeToColMajor,
  buildVialRGBMode, buildVialRGBSave, buildVialRGB, buildVialRGBColorLive, VIALRGB_EFFECT,
  buildBarColor, buildBarSave, buildBarGet, AP_BAR,
  buildKeymapGet, buildKeymapSet, buildEncoderSet, buildSwitchMatrixState, buildViaLayerCount,
  buildMacroSetBuffer, VIA_CMD,
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

// The custom firmware (al80.c al80_screen_send_u8) emits homepage status widgets — conn/os/lock/
// battery — as `A5 5A <op> 00 01 <crcHi> <crcLo> <val>`. This locks that byte layout to the proven
// announce() encoder so a protocol change can't silently diverge from the firmware. See KB §D10.
ok('firmware status-packet bytes match announce(op,0,1) + value', () => {
  for (const [op, val] of [[0x06, 77], [0x07, 0], [0x01, 0], [0x02, 0], [0x03, 1], [0x04, 0], [0x05, 0]]) {
    const rpt = announce(op, 0, 0x01);
    const modulePayload = Array.from(rpt.slice(7, 7 + rpt[3])); // exactly what the fw forwards (yne stripped)
    const crc = ga([op, 0, 0x01]);
    assert.deepEqual(modulePayload, [0xa5, 0x5a, op, 0, 0x01, crc[0], crc[1]], `op 0x${op.toString(16)}`);
    const fwPacket = [...modulePayload, val]; // firmware's full 8-byte write
    assert.equal(fwPacket.length, 8);
    assert.equal(fwPacket[7], val);
  }
});

ok('buildStartupAnimation (mode 0) yields valid 64-byte reports', () => {
  const packets = buildStartupAnimation([new Uint8Array(SA_FRAME_BYTES)], 30);
  assert.ok(packets.length > 0);
  assert.ok(packets.every((p) => p.length === 64));
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

ok('transposeToColMajor maps row-major pixel (x,y) to column-major slot x*h+y', () => {
  // tiny 2x3 frame; tag each pixel's 2 bytes so we can trace placement
  const w = 2, h = 3, frame = new Uint8Array(w * h * 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 2; frame[o] = x; frame[o + 1] = y; }
  const t = transposeToColMajor(frame, w, h);
  assert.equal(t.length, frame.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dst = (x * h + y) * 2;
    assert.equal(t[dst], x); assert.equal(t[dst + 1], y);
  }
  // a solid frame is transpose-invariant (why solids never revealed the banding)
  const solid = new Uint8Array(w * h * 2).fill(0xf8);
  assert.deepEqual(Array.from(transposeToColMajor(solid, w, h)), Array.from(solid));
});

ok('VIA keymap builders emit the standard command layout, padded to 64', () => {
  // set_keycode 0x05: [cmd, layer, row, col, kc_hi, kc_lo]
  const set = buildKeymapSet(0, 2, 3, 0x0004);
  assert.equal(set.length, 64);
  assert.deepEqual(Array.from(set.subarray(0, 6)), [0x05, 0x00, 0x02, 0x03, 0x00, 0x04]);
  assert.equal(set.subarray(6).every((b) => b === 0), true); // rest padded
  // get_keycode 0x04
  assert.deepEqual(Array.from(buildKeymapGet(1, 5, 6).subarray(0, 4)), [0x04, 0x01, 0x05, 0x06]);
  // encoder 0x15 (the knob): [cmd, layer, idx, cw?1:0, kc_hi, kc_lo] — KC_MUTE = 0x00A5
  assert.deepEqual(Array.from(buildEncoderSet(0, 0, true, 0x00a5).subarray(0, 6)), [0x15, 0x00, 0x00, 0x01, 0x00, 0xa5]);
  assert.deepEqual(Array.from(buildEncoderSet(0, 0, false, 0x00a5).subarray(0, 6)), [0x15, 0x00, 0x00, 0x00, 0x00, 0xa5]);
  // switch-matrix-state key tester = get_keyboard_value 0x02 with sub-id 0x03
  assert.deepEqual(Array.from(buildSwitchMatrixState().subarray(0, 2)), [0x02, 0x03]);
  assert.deepEqual(Array.from(buildViaLayerCount().subarray(0, 1)), [0x11]);
  // macro set_buffer 0x0f: [cmd, off_hi, off_lo, len, ...data]
  assert.deepEqual(Array.from(buildMacroSetBuffer(0x0102, [0x41, 0x42]).subarray(0, 6)), [0x0f, 0x01, 0x02, 0x02, 0x41, 0x42]);
  // the eeprom-reset / bootloader ids are NOT in our keymap command set
  assert.equal([VIA_CMD.DYN_SET_KEYCODE, VIA_CMD.DYN_GET_ENCODER].includes(0x0a), false);
});

ok('image announce is byte-identical to the captured one', () => {
  const a = buildImageTransfer(new Uint8Array(FRAME_BYTES))[0];
  assert.equal(hex(a).startsWith('40 00 00 08 cf 02 00 a5 5a 10 00 01 c5 b1 01'), true, hex(a));
});

ok('still-image transfer (96x160) = announce + setup + 548x56 + 1x32 tail + finish', () => {
  const pkts = buildImageTransfer(new Uint8Array(FRAME_BYTES));
  assert.equal(pkts.length, 1 + 1 + BLOCK_COUNT + 1); // 552 (announce, setup, 549 data, finish)
  assert.equal(hex(pkts[1]).startsWith('41 00 00 07 21 03 00 a5 5a 0c 78 00 c3 93'), true, hex(pkts[1]));
  const data = pkts.slice(2, -1);
  assert.equal(data.length, BLOCK_COUNT); // 549
  data.forEach((p, k) => {
    assert.equal(p[0], 0x41);
    assert.equal(p[3], k < 548 ? 0x38 : 0x20); // 548 full 56-byte blocks + one 32-byte tail
    assert.equal(p[1] | (p[2] << 8), k * 56); // offset little-endian
  });
  assert.equal((data.at(-1)[1] | (data.at(-1)[2] << 8)), 30688); // tail block offset
  assert.equal(data.at(-1)[3], 0x20); // 32-byte tail
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

ok('buildDeletePicture = one 0x0e announce + a 0x42 finish (delete the shown slot)', () => {
  const p = buildDeletePicture();
  assert.equal(p.length, 2);
  assert.equal(p[0][0], 0x40);        // announce report
  assert.equal(p[0][9], 0x0e);        // PK_DEL_PIC type in the A5 5A payload
  assert.equal(p[1][0], 0x42);        // finish
  assert.equal(hex(p[1]).startsWith('42 00 00 38 7a'), true);
  // it's exactly one iteration of buildClearPicture's 16x loop
  const all = buildClearPicture();
  assert.deepEqual(Array.from(p[0]), Array.from(all[0]));
  assert.deepEqual(Array.from(p[1]), Array.from(all[1]));
});

ok('buildNextPicture equals buildView(0x0d) (advance the picture ring)', () => {
  assert.deepEqual(buildNextPicture().map((r) => Array.from(r)), buildView(VIEW.PICTURE).map((r) => Array.from(r)));
  assert.equal(VIEW.PICTURE, 0x0d);
});

ok('buildClearAllPictures is the buildClearPicture alias (all 16 slots)', () => {
  assert.equal(buildClearAllPictures, buildClearPicture);
  assert.equal(buildClearAllPictures().length, 32); // 16 x (announce + finish)
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

ok('GIF page (mode 1, 96x160 banked) control packets are byte-identical to the live capture', () => {
  const p = buildGifPage([new Uint8Array(GP_FRAME_BYTES), new Uint8Array(GP_FRAME_BYTES)], 30);
  assert.equal(hex(p[0]).startsWith('40 00 00 09 b1 01 00 a5 5a 12 00 02 04 50 01 00'), true, hex(p[0])); // announce mode 1
  assert.equal(hex(p[1]).startsWith('41 00 00 09 24 02 00 a5 5a 13 00 02 c4 01 01 00'), true, hex(p[1])); // setup19 mode 1
  assert.equal(hex(p[2]).startsWith('41 00 00 0a 94 01 00 a5 5a 10 00 03 04 30 02 01'), true, hex(p[2])); // header [02, mode=1]
  assert.equal(hex(p[3]).startsWith('41 00 00 07 98 02 00 a5 5a 11 78 00 c5 03'), true, hex(p[3])); // length 0x7800 = 96x160
  // 2 frames * (2 setup + 30 banks * 19 blocks) + 2 head + 3 tail
  assert.equal(p.length, 2 + 2 * (2 + 30 * 19) + 3);
});

ok('per-frame header is [0x02, mode]: main=02,02  gif-page=02,01  startup=02,00', () => {
  assert.equal(buildMainPageGif([new Uint8Array(MP_FRAME_BYTES)], 30)[2][15], 2);
  assert.equal(buildGifPage([new Uint8Array(GP_FRAME_BYTES)], 30)[2][15], 1);
  assert.equal(buildStartupAnimation([new Uint8Array(SA_FRAME_BYTES)], 30)[2][15], 0);
});

ok('per-frame header carries the FRAME INDEX (byte 16) — frame N header checksum = base + N', () => {
  const p = buildMainPageGif([new Uint8Array(MP_FRAME_BYTES), new Uint8Array(MP_FRAME_BYTES)], 10);
  const hdrs = p.filter((x) => x[0] === 0x41 && x[7] === 0xa5 && x[8] === 0x5a && x[9] === 0x10 && x[11] === 3);
  assert.equal(hdrs[0][16], 0); // frame 0 index
  assert.equal(hdrs[1][16], 1); // frame 1 index
  assert.equal(hdrs[0][4], 0x95); // capture checksums
  assert.equal(hdrs[1][4], 0x96);
});

// Optional: cross-check block structure against the real sibling capture, if present.
const cap = '../al80-lcd/research/image_capture/testpattern_capture_raw.json';
if (existsSync(cap)) {
  ok('block offsets match the real testpattern capture', () => {
    const recs = JSON.parse(readFileSync(cap, 'utf8'))
      .map((r) => r.hex.split(' ').map((x) => parseInt(x, 16)))
      .filter((b) => b[0] === 0x41 && (b[3] === 0x38 || b[3] === 0x20) && !(b[7] === 0xa5 && b[8] === 0x5a));
    const capOffsets = [...new Set(recs.map((b) => b[1] | (b[2] << 8)))].sort((a, b) => a - b);
    const mine = buildImageTransfer(new Uint8Array(FRAME_BYTES)).slice(2, -1).map((p) => p[1] | (p[2] << 8));
    assert.deepEqual(mine, capOffsets);
  });
} else {
  console.log('  (skipped sibling-capture cross-check — al80-lcd not adjacent)');
}

ok('RGB lighting builders match the live usevia capture (VIA RGB-matrix channel 3)', () => {
  const [b, save] = buildLightBrightness(0x50);
  assert.equal(hex(b).startsWith('07 03 01 50'), true, hex(b)); // set brightness
  assert.equal(hex(save).startsWith('09 03'), true, hex(save)); // id_custom_save
  assert.equal(b.length, 64); assert.equal(save.length, 64); // padded to the 64-byte report
  assert.equal(hex(buildLightEffect(0x12)[0]).startsWith('07 03 02 12'), true);
  assert.equal(hex(buildLightSpeed(0x5a)[0]).startsWith('07 03 03 5a'), true);
  assert.equal(hex(buildLightColor(0xc2, 0xd2)[0]).startsWith('07 03 04 c2 d2'), true); // hue+sat
  assert.equal(hex(buildLightGet(1)).startsWith('08 03 01'), true); // id_custom_get_value
  // clamps to 0..255, no negative/overflow leakage
  assert.equal(buildLightBrightness(999)[0][3], 0xff);
  assert.equal(buildLightBrightness(-5)[0][3], 0x00);
});

// VialRGB (custom vial-qmk firmware) — read from quantum/vialrgb.c: set_mode is
//   07 41 <effLo> <effHi> <speed> <hue> <sat> <val>  (effect id 16-bit LE); save is 09.
ok('VialRGB set_mode packs effect(16-bit LE) + speed + HSV; save is 0x09', () => {
  const m = buildVialRGBMode(VIALRGB_EFFECT.SOLID, { speed: 0x80, hue: 0x2a, sat: 0xff, val: 0xc8 });
  assert.equal(hex(m).startsWith('07 41 02 00 80 2a ff c8'), true); // SOLID=2 -> 02 00
  // 16-bit effect id, little-endian: PALETTE_CYCLE = 0x0100 -> 00 01
  assert.equal(hex(buildVialRGBMode(VIALRGB_EFFECT.PALETTE_CYCLE, {})).startsWith('07 41 00 01'), true);
  assert.deepEqual(Array.from(buildVialRGBSave().slice(0, 1)), [0x09]);
  // convenience helpers
  assert.equal(buildVialRGB(VIALRGB_EFFECT.OFF, {}).length, 2);          // [mode, save]
  assert.equal(hex(buildVialRGBColorLive(0x10, 0x20)).startsWith('07 41 02 00'), true); // solid, live
  // clamps
  assert.equal(buildVialRGBMode(2, { val: 999 })[7], 0xff);
});

ok('buildLightColorLive is a single save-less color report (for real-time animation)', () => {
  const r = buildLightColorLive(0, 255);
  assert.ok(r instanceof Uint8Array, 'returns one report, not an [set, save] pair');
  assert.equal(r.length, 64);                              // one 64-byte report
  assert.equal(hex(r).startsWith('07 03 04 00 ff'), true, hex(r)); // set color hue=0 sat=255, no 0x09 save
  // it must NOT carry a save: buildLightColor pairs a 09 03 save after the set; live has none.
  const paired = buildLightColor(0, 255);
  assert.equal(paired.length, 2);
  assert.equal(hex(paired[1]).startsWith('09 03'), true);  // the paired builder DOES save
  assert.deepEqual(Array.from(r), Array.from(paired[0]));   // live == the set half, sans save
});

// Side LED bar (custom firmware raw-HID 0x46/0x47/0x48) — must match al80.c's raw_hid_receive_kb:
//   SET  0x47: data[1]=hue data[2]=sat data[3]=val data[4]=independent
//   SAVE 0x48
ok('buildBarColor emits 47 <h> <s> <v> <independent>; buildBarSave emits 48', () => {
  const set = buildBarColor(0x2a, 0xc0, 0x80);
  assert.equal(hex(set).startsWith('47 2a c0 80 01'), true, hex(set)); // independent defaults to on -> 01
  assert.equal(set.length, 64);                                        // padded to the 64-byte report
  assert.equal(AP_BAR.SET, 0x47);

  // independent=false rides in data[4]
  const follow = buildBarColor(0x10, 0x20, 0x30, false);
  assert.equal(hex(follow).startsWith('47 10 20 30 00'), true, hex(follow));

  const save = buildBarSave();
  assert.equal(hex(save).startsWith('48'), true, hex(save));
  assert.equal(save.length, 64);
  assert.equal(AP_BAR.SAVE, 0x48);

  // GET is a bare 0x46 request; device replies on an inputreport
  assert.equal(hex(buildBarGet()).startsWith('46'), true);
  assert.equal(AP_BAR.GET, 0x46);

  // clamps to 0..255 like the other builders (no negative/overflow leakage into the report)
  assert.equal(buildBarColor(999, -5, 300)[1], 0xff);
  assert.equal(buildBarColor(999, -5, 300)[2], 0x00);
  assert.equal(buildBarColor(999, -5, 300)[3], 0xff);
});

console.log(`\n${pass} checks passed.`);
