// AL80 Studio — pure protocol layer. No DOM, no HID, no dependencies. Node-unit-testable.
// Every LCD operation is ONE builder. Opcodes are limited to 0x40/0x41/0x42 (+0x55 status);
// the DFU range 0xB0-0xB7 is never emitted by construction.
//
// Decoded and verified in the sibling al80-lcd repo (AL80_KNOWLEDGE_BASE.md sections 5-14):
//   bytes[4,5] = yne  = 16-bit additive checksum, little-endian
//   announce bytes[12,13] = ga = CRC16-MODBUS (init 0xFFFF, poly 0xA001), big-endian
//   picture page 96x160, RGB565 big-endian, 30,720 bytes = 548 x 56-byte blocks + 1 x 32-byte tail
// Where our capture and the site source disagreed, the capture wins (this file follows it).
// (The old "112x137/30688" was a misread: our first analysis dropped the 32-byte tail block, so
//  the last 16 pixels were missing and still images never rendered. Live capture proved 96x160.)

export const VID = 0x28e9;
export const PID = 0x30af;
export const USAGE_PAGE = 0xff60;
export const USAGE = 0x61;
export const WIDTH = 96;
export const HEIGHT = 160;
export const FRAME_BYTES = WIDTH * HEIGHT * 2; // 30720
export const BLOCK = 56;
export const BLOCK_COUNT = Math.ceil(FRAME_BYTES / BLOCK); // 549 (548 full 56-byte + 1 partial 32-byte)
const REPORT = 64;

/** 16-bit additive checksum of `bytes`, returned little-endian: [low, high]. (yne) */
export function yne(bytes) {
  let n = 0;
  for (const b of bytes) n += b;
  n &= 0xffff;
  return [n & 0xff, (n >> 8) & 0xff];
}

/** CRC16-MODBUS of `bytes` (init 0xFFFF, poly 0xA001), returned big-endian: [high, low]. (ga) */
export function ga(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return [(crc >> 8) & 0xff, crc & 0xff];
}

const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];

function padTo64(pkt) {
  const out = new Uint8Array(REPORT);
  out.set(pkt.slice(0, REPORT));
  return out;
}

/**
 * The one builder. Returns a 64-byte report body (Uint8Array).
 *   pkt = [op, offLo, offHi, (reqLen-7), 0, 0, 0, ...payload]  then bytes[4,5] = yne(pkt)
 * @param {number} op       opcode (0x40/0x41/0x42/0x55 only)
 * @param {number[]} payload
 * @param {number[]} offset [lo, hi] little-endian byte offset (data blocks); default [0,0]
 * @param {number} reqLen   controls byte[3] = reqLen-7; 63 for data/finish, 7+payload.len for announces
 */
export function build(op, payload = [], offset = [0, 0], reqLen = 63) {
  if (![0x40, 0x41, 0x42, 0x55].includes(op)) {
    throw new Error(`protocol.build: refusing opcode 0x${op.toString(16)} (whitelist 40/41/42/55)`);
  }
  const pkt = [op, offset[0] & 0xff, offset[1] & 0xff, (reqLen - 7) & 0xff, 0, 0, 0, ...payload];
  const c = yne(pkt);
  pkt[4] = c[0];
  pkt[5] = c[1];
  return padTo64(pkt);
}

/** 0x40 announce: A5 5A type flag subcmd crcHi crcLo ...extra. byte[3]=payload length. */
export function announce(type, flag, subcmd, extra = []) {
  const crc = ga([type, flag, subcmd]);
  const payload = [0xa5, 0x5a, type, flag, subcmd, crc[0], crc[1], ...extra];
  return build(0x40, payload, [0, 0], 7 + payload.length);
}

/** 0x42 finish — a constant (42 00 00 38 7A ...). */
export function finish() {
  return build(0x42, [], [0, 0], 63);
}

// ---- pixels -----------------------------------------------------------------

/** RGBA bytes (canvas getImageData) -> RGB565 big-endian Uint8Array (2 bytes/pixel). */
export function rgb565BE(rgba) {
  const out = new Uint8Array((rgba.length / 4) * 2);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 2) {
    const v = ((rgba[i] >> 3) << 11) | ((rgba[i + 1] >> 2) << 5) | (rgba[i + 2] >> 3);
    out[o] = (v >> 8) & 0xff;
    out[o + 1] = v & 0xff;
  }
  return out;
}

// ---- still image (capture-verified: announce + 548 data + finish; NO 0x0C length packet) ----

/**
 * The 0x41 setup/length descriptor the device needs BETWEEN the announce and the pixel data.
 * Captured verbatim for the 112x137 panel: A5 5A 0C 78 00 <crc>. The 0x78 is a fixed panel
 * param (recurs in still + GIF setup), so this is a constant for our resolution.
 * (Omitting it uploads pixels that never render — the bug that made images not display.)
 */
export function buildImageSetup() {
  const crc = ga([0x0c, 0x78, 0x00]);
  return build(0x41, [0xa5, 0x5a, 0x0c, 0x78, 0x00, crc[0], crc[1]], [0, 0], 14);
}

/**
 * Data blocks for a frame: sequential 56-byte blocks with a final PARTIAL block.
 * byte[3] carries each block's real length, so a 30,720-byte frame = 548x56 + 1x32 (the tail
 * block our old code dropped, which is why still images never rendered).
 */
function dataBlocks(frame) {
  const out = [];
  for (let off = 0; off < frame.length; off += BLOCK) {
    const chunk = frame.subarray(off, Math.min(off + BLOCK, frame.length));
    out.push(build(0x41, Array.from(chunk), le16(off), 7 + chunk.length));
  }
  return out;
}

/** Build the full still-image transfer (picture page, 96x160): announce -> setup -> 548x56 + 1x32 -> finish. */
export function buildImageTransfer(frame) {
  if (frame.length !== FRAME_BYTES) throw new Error(`frame must be ${FRAME_BYTES} bytes, got ${frame.length}`);
  return [announce(0x10, 0, 0x01, [0x01]), buildImageSetup(), ...dataBlocks(frame), finish()];
}

/**
 * Partial (region) update of the picture page: announce + setup + only the 56-byte data blocks
 * covering the byte range [startOff, endOff), + finish. The device writes by offset, so blocks we
 * don't send keep their previous pixels (proven on-device: a green frame + a partial red write left
 * the green intact). This is the real-time path — redraw only what changed. startOff snaps down to
 * a 56-byte block boundary. Flat/unpaced, like a still image.
 */
export function buildImageRegion(frame, startOff, endOff) {
  if (frame.length !== FRAME_BYTES) throw new Error(`frame must be ${FRAME_BYTES} bytes, got ${frame.length}`);
  const s = Math.max(0, startOff - (startOff % BLOCK));
  const e = Math.min(FRAME_BYTES, endOff);
  const packets = [announce(0x10, 0, 0x01, [0x01]), buildImageSetup()];
  for (let off = s; off < e; off += BLOCK) {
    const chunk = frame.subarray(off, Math.min(off + BLOCK, FRAME_BYTES));
    packets.push(build(0x41, Array.from(chunk), le16(off), 7 + chunk.length));
  }
  packets.push(finish());
  return packets;
}

// ---- clock + date (sent 3x; §5b/§5c/§5f) ------------------------------------

/**
 * @param {{h,m,s,year,month,day,dow}} t  year=2-digit, dow=1..7 (Sun=7), month=1..12
 * @param {boolean} is12hr
 */
export function buildClock(t, is12hr = true) {
  const hh = is12hr ? t.h % 12 || 12 : t.h;
  const one = [
    announce(0x09, 0, 0x03),
    build(0x41, [hh, t.m, t.s], [0, 0], 10),
    finish(),
    announce(0x0a, 0, 0x04),
    build(0x41, [t.year & 0xff, t.dow, t.month, t.day], [0, 0], 11),
    finish(),
  ];
  return [...one, ...one, ...one];
}

/** Convenience: build a clock payload from a JS Date. */
export function clockFromDate(date, is12hr = true) {
  return buildClock(
    {
      h: date.getHours(),
      m: date.getMinutes(),
      s: date.getSeconds(),
      year: date.getFullYear() % 100,
      month: date.getMonth() + 1,
      day: date.getDate(),
      dow: date.getDay() || 7,
    },
    is12hr,
  );
}

// ---- view switch + clear (§5f) ----------------------------------------------

export const VIEW = { HOMEPAGE: 0x0b, PICTURE: 0x0d, GIF: 0x0f };

/** Switch the LCD view. type = VIEW.HOMEPAGE / PICTURE / GIF. */
export function buildView(type) {
  return [announce(type, 0, 0), finish()];
}

/** Clear all stored pictures (type 14, x16). DESTRUCTIVE. */
export function buildClearPicture() {
  const out = [];
  for (let i = 0; i < 16; i++) out.push(announce(0x0e, 0, 0), finish());
  return out;
}

/** Clear the stored GIF (type 18 sub1, then type 19 sub2). DESTRUCTIVE. */
export function buildClearGif() {
  return [announce(0x12, 0, 1, [1, 0]), finish(), announce(0x13, 0, 2, [1, 0]), finish()];
}

// ---- GIF (EXPERIMENTAL — source-derived, §14c; wire path differs from our capture) ----

/**
 * @param {Uint8Array[]} frames  each FRAME_BYTES of RGB565-BE
 * @param {number} fps           1..60
 * @param {number} mode          0 (full 112x137) default
 * NOTE: experimental. Source uses subcmd 0x02/0x03; our capture showed 0x09/0x0A/0x07 banked.
 * Verify on-device before trusting; the still-image path is the proven one.
 */
export function buildGifTransfer(frames, fps, mode = 0) {
  if (!frames.length) throw new Error('buildGifTransfer: no frames');
  if (frames.length > 255) frames = frames.slice(0, 255); // count byte is 8-bit; never wrap
  fps = Math.max(1, Math.min(60, Math.round(fps) || 30));
  const packets = [announce(0x12, 0, 0x02, [mode, 0]), announce(0x13, 0, 0x02, [mode, 0])];
  frames.forEach((frame, i) => {
    if (frame.length !== FRAME_BYTES) throw new Error(`GIF frame ${i} must be ${FRAME_BYTES} bytes`);
    packets.push(announce(0x10, 0, 0x03, [0x02, mode, i & 0xff]));
    // per-frame length descriptor: A5 5A 11 lenHi lenLo crc crc  (big-endian length)
    const lenBE = [(FRAME_BYTES >> 8) & 0xff, FRAME_BYTES & 0xff];
    const lcrc = ga([0x11, lenBE[0], lenBE[1]]);
    packets.push(build(0x41, [0xa5, 0x5a, 0x11, lenBE[0], lenBE[1], lcrc[0], lcrc[1]], [0, 0], 14));
    for (const p of dataBlocks(frame)) packets.push(p);
  });
  packets.push(announce(0x12, 0, 0x02, [mode, frames.length & 0xff])); // FRAME COUNT in trailing byte
  packets.push(announce(0x13, 0, 0x02, [mode, fps & 0xff])); // FPS in trailing byte
  packets.push(finish());
  return packets;
}

// ---- MAIN PAGE (the display that actually renders on the ripple firmware) ----
// Decoded from a live capture of the vendor app's "Save GIF to main page". The main page
// is a MODE-2 GIF at 96x64 (NOT 112x137). Regular picture/GIF uploads store to slots the
// firmware won't display; only the main-page path shows. Structure:
//   announce(type 0x12, mode 2) -> setup(0x13) -> per frame [header(0x10) + length(0x11) + data]
//   -> finish(0x12 with FRAME COUNT) + finish(0x13 with FPS) + 0x42
// Each frame = 96*64*2 = 12,288 bytes = 12 banks of 1024 (18 x 56-byte blocks + one 16-byte
// block, packet offset resetting 0..0x3F0 per bank; the device advances the bank implicitly).

export const MP_W = 96;
export const MP_H = 64;
export const MP_FRAME_BYTES = MP_W * MP_H * 2; // 12288
const MP_BANK = 1024;
const MP_FULL_BLOCKS = 18; // 18 x 56 + 1 x 16 = 1024

/** 0x40/0x41 control packet with an A5 5A payload and an explicit length marker (byte[3]). */
function ctrl(op, type, flag, subcmd, extra, reqLen) {
  const crc = ga([type, flag, subcmd]);
  return build(op, [0xa5, 0x5a, type, flag, subcmd, crc[0], crc[1], ...extra], [0, 0], reqLen);
}

/**
 * Build a "save to main page" GIF transfer (the path that displays).
 * @param {Uint8Array[]} frames  each exactly MP_FRAME_BYTES (96x64 RGB565 big-endian)
 * @param {number} fps           1..60 (default 30)
 */
export const MP_MAX_FRAMES = 42; // vendor caps mode-2 GIFs at 42 frames

// Startup animation = mode 0: full-screen ANIMATED GIF (the "skull" is one). 96x160, up to 64 frames.
export const SA_W = 96;
export const SA_H = 160;
export const SA_FRAME_BYTES = SA_W * SA_H * 2; // 30720
export const SA_MAX_FRAMES = 64;

/**
 * Shared mode-based GIF/animation builder. The vendor uses one wire format with a MODE byte:
 *   mode 0 = startup animation (96x160, cap 64) · mode 2 = main page (96x64, cap 42).
 * Only the mode byte, per-frame dimensions, and frame count differ. Structure:
 *   announce(0x12,mode) -> setup(0x13,mode) -> per frame [header(0x10) + length(0x11) + banks]
 *   -> finish(0x12, mode+COUNT) + finish(0x13, mode+FPS) + 0x42.
 * @param {Uint8Array[]} frames  each `frameBytes` long (w*h*2 RGB565 big-endian)
 */
function buildModeGif(frames, fps, mode, frameBytes, maxFrames) {
  if (!frames.length) throw new Error('buildModeGif: no frames');
  if (frames.length > maxFrames) frames = frames.slice(0, maxFrames);
  fps = Math.max(1, Math.min(60, Math.round(fps) || 30));
  const lenHi = (frameBytes >> 8) & 0xff, lenLo = frameBytes & 0xff; // per-frame byte length, big-endian
  const lenCrc = ga([0x11, lenHi, lenLo]);
  const packets = [
    ctrl(0x40, 0x12, 0, 2, [mode, 0], 16), // announce
    ctrl(0x41, 0x13, 0, 2, [mode, 0], 16), // setup
  ];
  frames.forEach((frame, fi) => {
    if (frame.length !== frameBytes) throw new Error(`mode-${mode} frame must be ${frameBytes} bytes, got ${frame.length}`);
    // per-frame header = [0x02, mode, FRAME INDEX] — the frame index is the 10th payload byte
    // (header length byte is 0x0a=10). Dropping it made every frame index 0, so frames overwrote
    // each other and GIFs rendered white. Capture-verified: frame N's header checksum = base + N.
    packets.push(ctrl(0x41, 0x10, 0, 3, [0x02, mode, fi & 0xff], 17));
    packets.push(build(0x41, [0xa5, 0x5a, 0x11, lenHi, lenLo, lenCrc[0], lenCrc[1]], [0, 0], 14)); // per-frame length
    for (let base = 0; base < frameBytes; base += MP_BANK) {
      const remain = frameBytes - base;
      const full = Math.min(MP_FULL_BLOCKS, Math.floor(remain / BLOCK));
      for (let i = 0; i < full; i++) {
        const off = i * BLOCK;
        packets.push(build(0x41, Array.from(frame.subarray(base + off, base + off + BLOCK)), [off & 0xff, (off >> 8) & 0xff], 63));
      }
      const off16 = full * BLOCK;
      const tail = Math.min(16, remain - off16);
      if (tail > 0) packets.push(build(0x41, Array.from(frame.subarray(base + off16, base + off16 + tail)), [off16 & 0xff, (off16 >> 8) & 0xff], 7 + tail));
    }
  });
  packets.push(ctrl(0x41, 0x12, 0, 2, [mode, frames.length & 0xff], 16)); // finish: FRAME COUNT
  packets.push(ctrl(0x41, 0x13, 0, 2, [mode, fps & 0xff], 16)); // finish: FPS
  packets.push(finish());
  return packets;
}

/** Main page (mode 2): 96x64, up to 42 frames. */
export function buildMainPageGif(frames, fps = 30) {
  return buildModeGif(frames, fps, 2, MP_FRAME_BYTES, MP_MAX_FRAMES);
}

/** Startup animation (mode 0): full-screen animated GIF, 96x160, up to 64 frames — replaces the boot GIF. */
export function buildStartupAnimation(frames, fps = 30) {
  return buildModeGif(frames, fps, 0, SA_FRAME_BYTES, SA_MAX_FRAMES);
}

// GIF page = mode 1: the separate GIF view, 96x160 banked (30 banks/frame), up to 160 frames.
// Capture-verified (announce mode byte 0x01, length 0x7800, header [0x02,0x01]).
export const GP_W = 96;
export const GP_H = 160;
export const GP_FRAME_BYTES = GP_W * GP_H * 2; // 30720
export const GP_MAX_FRAMES = 160;
export function buildGifPage(frames, fps = 30) {
  return buildModeGif(frames, fps, 1, GP_FRAME_BYTES, GP_MAX_FRAMES);
}

/** Save a single still image to the main page (a 1-frame mode-2 GIF). frame = 96x64 RGB565 BE. */
export function buildMainPageImage(frame) {
  return buildMainPageGif([frame], 1);
}

/** Serialize a logical packet (64-byte body) to the capture-schema hex string, for tests/logs. */
export function toHex(pkt) {
  return Array.from(pkt, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
