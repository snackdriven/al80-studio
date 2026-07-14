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
 * Captured verbatim for the 96x160 panel: A5 5A 0C 78 00 <crc>. The 0x78 is a fixed panel
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
  // AL80 is ROW-MAJOR (on-device: column-major rendered sideways). The banding was never packing —
  // it's dropped bytes from blasting, fixed by ACK-gating the send, not by reordering pixels.
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

/** Readable alias for "delete all 16 picture slots" (the 0x0e x16 loop above). */
export const buildClearAllPictures = buildClearPicture;

/**
 * Delete the CURRENTLY-DISPLAYED picture slot — one iteration of buildClearPicture's loop.
 * PK_DEL_PIC (0x0e) sent with no index (length 0) acts on whatever's on the LCD right now, not a
 * slot number (matches the sibling keyboard_screen.c:354). Wire: 40 announce(0x0e,0,0) + 42 finish.
 * Studio can't read which slot is shown, so the user rotates to it (buildNextPicture) then deletes.
 */
export function buildDeletePicture() {
  return [announce(0x0e, 0, 0), finish()];
}

/**
 * Advance the picture ring to the NEXT stored slot (PK_TOGGLE_PIC 0x0d). This is exactly what
 * buildView(VIEW.PICTURE) sends — the picture view-switch IS the "next picture" command. Thin
 * named wrapper so slot-management code reads clearly.
 */
export function buildNextPicture() {
  return buildView(VIEW.PICTURE);
}

/** Clear the stored GIF (type 18 sub1, then type 19 sub2). DESTRUCTIVE. */
export function buildClearGif() {
  return [announce(0x12, 0, 1, [1, 0]), finish(), announce(0x13, 0, 2, [1, 0]), finish()];
}

// ---- GIF (EXPERIMENTAL — source-derived, §14c; wire path differs from our capture) ----

/**
 * @param {Uint8Array[]} frames  each FRAME_BYTES of RGB565-BE
 * @param {number} fps           1..60
 * @param {number} mode          0 (full 96x160) default
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
    // Row-major (the AL80 is row-major — column-major renders sideways on-device).
    const wire = frame;
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
        packets.push(build(0x41, Array.from(wire.subarray(base + off, base + off + BLOCK)), [off & 0xff, (off >> 8) & 0xff], 63));
      }
      const off16 = full * BLOCK;
      const tail = Math.min(16, remain - off16);
      if (tail > 0) packets.push(build(0x41, Array.from(wire.subarray(base + off16, base + off16 + tail)), [off16 & 0xff, (off16 >> 8) & 0xff], 7 + tail));
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

// ---- RGB lighting (VIA / QMK RGB Matrix) — SAME 0xFF60/0x61 interface + 64-byte reports as the LCD ----
// Decoded from a live usevia.app capture: the firmware multiplexes standard VIA commands and the
// vendor LCD stream on one raw-HID channel (first byte distinguishes them: 0x07/0x09 = VIA lighting,
// 0x40-0x42 = LCD). Standard VIA custom-value protocol on the QMK RGB-Matrix channel (0x03):
//   set:  07 03 <valueId> <data...>     save: 09 03     read: 08 03 <valueId>
//   valueId 1=brightness 2=effect 3=speed 4=color(hue,sat); all 0-255.
const LIGHT_CHANNEL = 0x03;
export const LIGHT = { BRIGHTNESS: 1, EFFECT: 2, SPEED: 3, COLOR: 4 };
const clamp8 = (n) => Math.max(0, Math.min(255, Math.round(n) || 0));

/** Pad a raw VIA report to 64 bytes. Refuses the dangerous VIA commands (eeprom reset / bootloader). */
function viaReport(bytes) {
  const cmd = bytes[0];
  if (cmd === 0x0a || cmd === 0x0b) throw new Error(`protocol.viaReport: refusing VIA cmd 0x${cmd.toString(16)} (eeprom-reset/bootloader-jump)`);
  const out = new Uint8Array(REPORT);
  out.set(bytes.slice(0, REPORT));
  return out;
}

/** id_custom_set_value (0x07) on the RGB-matrix channel. Returns a single 64-byte report. */
export function buildLightSet(valueId, data = []) {
  return viaReport([0x07, LIGHT_CHANNEL, valueId & 0xff, ...data.map(clamp8)]);
}
/** id_custom_save (0x09) — persist current lighting to EEPROM. */
export function buildLightSave() {
  return viaReport([0x09, LIGHT_CHANNEL]);
}
/** id_custom_get_value (0x08) — device replies with the value on an inputreport. */
export function buildLightGet(valueId) {
  return viaReport([0x08, LIGHT_CHANNEL, valueId & 0xff]);
}

// Convenience: each returns [setReport, saveReport] to send in order.
export const buildLightBrightness = (v) => [buildLightSet(LIGHT.BRIGHTNESS, [v]), buildLightSave()];
export const buildLightEffect = (mode) => [buildLightSet(LIGHT.EFFECT, [mode]), buildLightSave()];
export const buildLightSpeed = (v) => [buildLightSet(LIGHT.SPEED, [v]), buildLightSave()];
export const buildLightColor = (hue, sat) => [buildLightSet(LIGHT.COLOR, [hue, sat]), buildLightSave()];

/**
 * SAVE-LESS color set for real-time animation. Returns a SINGLE 64-byte report (no 0x09 save),
 * so software effects (strobe / cycle / breathe) can push hundreds of colors/second without
 * hammering the EEPROM. Set effect=Solid Color once (with save) up front, then stream these.
 * @returns {Uint8Array} one 07 03 04 <hue> <sat> report — NOT an array, unlike buildLightColor.
 */
export const buildLightColorLive = (hue, sat) => buildLightSet(LIGHT.COLOR, [hue, sat]);

/**
 * SAVE-LESS brightness set for real-time animation. One 07 03 01 <val> report, no 0x09 save.
 * Companion to buildLightColorLive; the streaming loop uses this instead of buildLightBrightness
 * (which appends a save = EEPROM write). Stock via_qmk_rgb_matrix_set_value handles id 1 noeeprom
 * (rgb_matrix_sethsv_noeeprom, preserving the current hue/sat). The music-reactive path pairs this
 * with buildLightColorLive on stock firmware to stream full HSV without ever touching eeconfig.
 * @returns {Uint8Array} one 07 03 01 <val> report — NOT an array, unlike buildLightBrightness.
 */
export const buildLightBrightnessLive = (v) => buildLightSet(LIGHT.BRIGHTNESS, [v]);

// ---- VialRGB (custom vial-qmk firmware) — a DIFFERENT protocol from the stock channel-3 lighting ----
// Read from vial-qmk quantum/vialrgb.c: with VIALRGB_ENABLE, VIA id_custom_set_value (0x07) routes
// straight to vialrgb_set_value — there is NO channel byte, so the stock "07 03 …" is ignored. Instead
// data[1] is the vialrgb sub-command, and set_mode sets the WHOLE mode in one report:
//   set:  07 41 <effLo> <effHi> <speed> <hue> <sat> <val>   (effect id is 16-bit little-endian)
//   save: 09           (vialrgb_save flushes rgb_matrix to EEPROM; ignores the rest)
// Effect ids are the VIALRGB_EFFECT_* enum (quantum/vialrgb_effects.inc). PALETTE_CYCLE (0x0100) is
// the al80's own custom effect (config.h AL80_VIALRGB_PALETTE_CYCLE_ID).
export const VIALRGB_EFFECT = {
  OFF: 0, SOLID: 2, BREATHING: 6, BAND_VAL: 8, CYCLE_ALL: 13, CYCLE_LR: 14, CYCLE_UD: 15,
  RAINBOW_CHEVRON: 16, CYCLE_OUT_IN: 17, CYCLE_PINWHEEL: 19, CYCLE_SPIRAL: 20, DUAL_BEACON: 21,
  RAINBOW_BEACON: 22, RAINDROPS: 24, HUE_BREATHING: 26, HUE_WAVE: 28, DIGITAL_RAIN: 30,
  // v20 react-to-keypress effects (firmware config.h RGB_MATRIX_KEYREACTIVE_ENABLED).
  // IDs are the exact VIALRGB_EFFECT_* enum ordinals in quantum/vialrgb_effects.inc.
  SOLID_REACTIVE_SIMPLE: 31, SOLID_REACTIVE: 32, SOLID_REACTIVE_WIDE: 33, SOLID_REACTIVE_MULTIWIDE: 34,
  SOLID_REACTIVE_CROSS: 35, SOLID_REACTIVE_MULTICROSS: 36, SOLID_REACTIVE_NEXUS: 37, SOLID_REACTIVE_MULTINEXUS: 38,
  SPLASH: 39, MULTISPLASH: 40, SOLID_SPLASH: 41, SOLID_MULTISPLASH: 42,
  // PIXEL_RAIN corrected 44 -> 43: the enum ordinal is 43 (PIXEL_FRACTAL is 44 and is not compiled).
  PIXEL_RAIN: 43, PALETTE_CYCLE: 0x0100,
};
const VIALRGB_SET_MODE = 0x41;

/** VialRGB set_mode — one report setting effect + speed + HSV together (live, noeeprom). */
export function buildVialRGBMode(effect, { speed = 128, hue = 0, sat = 255, val = 255 } = {}) {
  return viaReport([0x07, VIALRGB_SET_MODE,
    effect & 0xff, (effect >> 8) & 0xff, clamp8(speed), clamp8(hue), clamp8(sat), clamp8(val)]);
}
/** Persist current VialRGB state to EEPROM (id_custom_save 0x09). */
export function buildVialRGBSave() { return viaReport([0x09]); }
/** [modeReport, saveReport] — set the mode and persist it. */
export const buildVialRGB = (effect, opts) => [buildVialRGBMode(effect, opts), buildVialRGBSave()];
/** SAVE-LESS solid-color mode for host-driven FX streaming (no EEPROM write). One report. */
export const buildVialRGBColorLive = (hue, sat, val = 255) =>
  buildVialRGBMode(VIALRGB_EFFECT.SOLID, { hue, sat, val });

// ---- side LED bar (custom firmware) — independent color for RGB-matrix indices 76-78 ----
// The al80's own raw-HID KB opcodes 0x46/0x47/0x48, mirroring the palette protocol (0x43/0x44/0x45).
// They ride the SAME 0xFF60/0x61 channel and 64-byte report as the LCD + VIA families, and reach
// raw_hid_receive_kb() because they're above VIA's command range (VIA tops out at 0x13). Firmware:
//   SET  0x47: data[1]=hue data[2]=sat data[3]=val data[4]=independent  -> writes RAM, ACK 0x55
//   SAVE 0x48: flush RAM state to a dedicated EEPROM sub-block
//   GET  0x46: reply [0x46, hue, sat, val, independent]
// When independent, the firmware paints indices 76-78 with this HSV every frame; else they follow
// the keys. These are NOT part of build()'s LCD whitelist (40/41/42/55) — they're a plain KB report.
export const AP_BAR = Object.freeze({ GET: 0x46, SET: 0x47, SAVE: 0x48 });

/** Pad a raw KB-opcode report to 64 bytes (same wire shape as viaReport, no VIA-command guard). */
function kbReport(bytes) {
  const out = new Uint8Array(REPORT);
  out.set(bytes.slice(0, REPORT));
  return out;
}

/** 0x47 set: [0x47, hue, sat, val, independent]. independent=false makes the bar follow the keys. */
export function buildBarColor(hue, sat, val, independent = true) {
  return kbReport([AP_BAR.SET, clamp8(hue), clamp8(sat), clamp8(val), independent ? 1 : 0]);
}
/** 0x48 save: persist the current bar color/mode to EEPROM. */
export function buildBarSave() {
  return kbReport([AP_BAR.SAVE]);
}
/** 0x46 get: device replies [0x46, hue, sat, val, independent] on an inputreport. */
export function buildBarGet() {
  return kbReport([AP_BAR.GET]);
}

// ---- per-key audio-reactive live LED stream (custom firmware, opcode 0x49) ----------------
// HOST BUILDERS ONLY — the 0x49 firmware handler (g_live_rgb + rgb_matrix_indicators_advanced_kb +
// matrix_scan_kb idle-timeout) is the firmware half of this feature and lives in al80.c, not here.
// See research/al80-per-key-audio-reactive-SPARC.md (A.1/A.3) for the full design.
//
// Wire: [0x49, offset, count, R,G,B x count(<=20), spare...] padded to 64 bytes. count max =
// floor((64-3)/3) = 20. The 82-LED rgb-matrix (keyboard.json rgb_matrix.layout order — the
// electrical scramble is already resolved inside the aw20216s driver's g_aw20216s_leds[], so the
// host sends plain logical index order, no wire-side remap) needs 5 chunks per full-board frame:
// offsets 0/20/40/60/80 with counts 20/20/20/20/2 (82 = 4*20 + 2). Save-less: no 0x09/0x48-style
// SAVE exists for this opcode by design (NFR2) — RAM-only, mirrors the bar/LCD streaming pattern.
export const AP_LIVE = Object.freeze({ LEDS: 0x49, CTRL: 0x4a });
export const RGB_MATRIX_LED_COUNT = 82;
export const LED_BAR_RANGE = [76, 78]; // inclusive indices the independent side bar owns
const LIVE_MAX_LEDS_PER_CHUNK = Math.floor((REPORT - 3) / 3); // 20

/**
 * One 0x49 chunk: [0x49, offset, count, r,g,b x count]. `leds` is a flat array/typed-array of
 * count*3 RGB bytes (already in rgb-matrix logical order for this offset). count must be 1..20 —
 * anything else throws (mirrors the firmware's out-of-range ACK 0x0F path, but catch it host-side
 * before it ever reaches the wire).
 * @param {number} offset  starting LED index (0-based, logical rgb-matrix order)
 * @param {number[]|Uint8Array} leds  flat RGB bytes, length must be a multiple of 3, 3..60 bytes
 */
export function buildLiveLeds(offset, leds) {
  const count = Math.floor(leds.length / 3);
  if (leds.length % 3 !== 0) throw new Error(`protocol.buildLiveLeds: leds length ${leds.length} is not a multiple of 3`);
  if (count < 1 || count > LIVE_MAX_LEDS_PER_CHUNK) {
    throw new Error(`protocol.buildLiveLeds: count ${count} out of range 1..${LIVE_MAX_LEDS_PER_CHUNK}`);
  }
  const rgb = Array.from(leds, clamp8);
  return kbReport([AP_LIVE.LEDS, offset & 0xff, count & 0xff, ...rgb]);
}

/**
 * Chunk a full-board RGB field into <=5 reports of <=20 LEDs each, covering every LED exactly once.
 * @param {number[]|Uint8Array} rgb246  RGB_MATRIX_LED_COUNT*3 bytes (82*3 = 246), logical LED order
 * @returns {Uint8Array[]} 0x49 reports, offsets ascending from 0, each <=64 bytes
 */
export function buildLiveFrame(rgb246) {
  const expected = RGB_MATRIX_LED_COUNT * 3;
  if (rgb246.length !== expected) {
    throw new Error(`protocol.buildLiveFrame: expected ${expected} bytes (${RGB_MATRIX_LED_COUNT} LEDs x 3), got ${rgb246.length}`);
  }
  const packets = [];
  for (let led = 0; led < RGB_MATRIX_LED_COUNT; led += LIVE_MAX_LEDS_PER_CHUNK) {
    const ledCount = Math.min(LIVE_MAX_LEDS_PER_CHUNK, RGB_MATRIX_LED_COUNT - led);
    const slice = Array.prototype.slice.call(rgb246, led * 3, led * 3 + ledCount * 3);
    packets.push(buildLiveLeds(led, slice));
  }
  return packets;
}

/** 0x4A AP_LIVE_CTRL sub0: stop-now (clears g_live_active without waiting for the idle timeout). */
export function buildLiveStop() {
  return kbReport([AP_LIVE.CTRL, 0]);
}

// ---- VIA keymap / macros / encoder — live editing on ripple, same 0xFF60/0x61 channel, 64-byte reports ----
// Standard VIA command IDs (the-via/app + qmk quantum/via.c). Ripple implements VIA (usevia drives it),
// so these work on the stock firmware — no custom flash. Each builds a REQUEST report; the device replies
// on an inputreport that the host reads (same read pattern as buildLightGet). Keycodes are 16-bit,
// big-endian (hi, lo) per VIA. Dangerous commands (0x0a eeprom_reset, 0x0b bootloader_jump) are refused
// by viaReport — a keymap edit can never accidentally wipe eeprom or jump to bootloader.
export const VIA_CMD = Object.freeze({
  GET_PROTOCOL_VERSION: 0x01,
  GET_KEYBOARD_VALUE: 0x02, SET_KEYBOARD_VALUE: 0x03,
  DYN_GET_KEYCODE: 0x04, DYN_SET_KEYCODE: 0x05, DYN_RESET: 0x06,
  MACRO_GET_COUNT: 0x0c, MACRO_GET_BUFSIZE: 0x0d, MACRO_GET_BUFFER: 0x0e, MACRO_SET_BUFFER: 0x0f, MACRO_RESET: 0x10,
  DYN_GET_LAYER_COUNT: 0x11, DYN_GET_BUFFER: 0x12, DYN_SET_BUFFER: 0x13,
  DYN_GET_ENCODER: 0x14, DYN_SET_ENCODER: 0x15,
});
/** get_keyboard_value sub-ids. SWITCH_MATRIX_STATE drives a live key tester. */
export const VIA_VALUE = Object.freeze({ UPTIME: 0x01, LAYOUT_OPTIONS: 0x02, SWITCH_MATRIX_STATE: 0x03, FIRMWARE_VERSION: 0x04, DEVICE_INDICATION: 0x05 });

const hi16 = (n) => (n >> 8) & 0xff;
const lo16 = (n) => n & 0xff;

/** get_protocol_version (0x01) → reply [01, ver_hi, ver_lo]. VIA protocol handshake. */
export const buildViaProtocolVersion = () => viaReport([VIA_CMD.GET_PROTOCOL_VERSION]);
/** dynamic_keymap_get_layer_count (0x11) → reply [11, count]. */
export const buildViaLayerCount = () => viaReport([VIA_CMD.DYN_GET_LAYER_COUNT]);
/** dynamic_keymap_get_keycode (0x04) → reply [04, layer, row, col, kc_hi, kc_lo]. */
export const buildKeymapGet = (layer, row, col) => viaReport([VIA_CMD.DYN_GET_KEYCODE, layer & 0xff, row & 0xff, col & 0xff]);
/** dynamic_keymap_set_keycode (0x05): write one key. kc = 16-bit VIA keycode. */
export const buildKeymapSet = (layer, row, col, kc) => viaReport([VIA_CMD.DYN_SET_KEYCODE, layer & 0xff, row & 0xff, col & 0xff, hi16(kc), lo16(kc)]);
/** dynamic_keymap_reset (0x06): restore the keymap to firmware default (recoverable — re-apply your layout). */
export const buildKeymapReset = () => viaReport([VIA_CMD.DYN_RESET]);
/** dynamic_keymap_get/set_buffer (0x12/0x13): bulk keymap read/write, ≤28 data bytes per chunk (VIA convention). */
export const buildKeymapGetBuffer = (offset, size) => viaReport([VIA_CMD.DYN_GET_BUFFER, hi16(offset), lo16(offset), size & 0xff]);
export const buildKeymapSetBuffer = (offset, data) => viaReport([VIA_CMD.DYN_SET_BUFFER, hi16(offset), lo16(offset), data.length & 0xff, ...data.map((b) => b & 0xff)]);
/** dynamic_keymap_get/set_encoder (0x14/0x15): the knob ("radial"). clockwise=true is CW, false is CCW. */
export const buildEncoderGet = (layer, idx, clockwise) => viaReport([VIA_CMD.DYN_GET_ENCODER, layer & 0xff, idx & 0xff, clockwise ? 1 : 0]);
export const buildEncoderSet = (layer, idx, clockwise, kc) => viaReport([VIA_CMD.DYN_SET_ENCODER, layer & 0xff, idx & 0xff, clockwise ? 1 : 0, hi16(kc), lo16(kc)]);
/** get_keyboard_value / SWITCH_MATRIX_STATE (0x02 0x03) → reply is a bit-packed matrix snapshot: a live key tester. */
export const buildSwitchMatrixState = () => viaReport([VIA_CMD.GET_KEYBOARD_VALUE, VIA_VALUE.SWITCH_MATRIX_STATE]);
/** get_keyboard_value / FIRMWARE_VERSION (0x02 0x04) → reply [02, 04, v3, v2, v1, v0]: the 32-bit VIA firmware version. */
export const buildFirmwareVersion = () => viaReport([VIA_CMD.GET_KEYBOARD_VALUE, VIA_VALUE.FIRMWARE_VERSION]);
/** set_keyboard_value / DEVICE_INDICATION (0x03 0x05): ask the board to flash its LEDs to identify itself. */
export const buildDeviceIndication = () => viaReport([VIA_CMD.SET_KEYBOARD_VALUE, VIA_VALUE.DEVICE_INDICATION, 0]);
/** dynamic_keymap_macro_* (0x0c count, 0x0d buffer-size, 0x0e/0x0f get/set buffer, 0x10 reset). */
export const buildMacroCount = () => viaReport([VIA_CMD.MACRO_GET_COUNT]);
export const buildMacroBufferSize = () => viaReport([VIA_CMD.MACRO_GET_BUFSIZE]);
export const buildMacroGetBuffer = (offset, size) => viaReport([VIA_CMD.MACRO_GET_BUFFER, hi16(offset), lo16(offset), size & 0xff]);
export const buildMacroSetBuffer = (offset, data) => viaReport([VIA_CMD.MACRO_SET_BUFFER, hi16(offset), lo16(offset), data.length & 0xff, ...data.map((b) => b & 0xff)]);
export const buildMacroReset = () => viaReport([VIA_CMD.MACRO_RESET]);

// ---- hotkey → panel signal (keyboard→host, custom firmware) ----
// Unsolicited raw_hid_send from the keyboard's process_record_kb (al80-hotkey-panel-switch-SPARC.md):
// the keyboard emits this on keypress, unprompted — the host never sends a matching request. Disjoint
// from every host→keyboard opcode (0x40-0x48 LCD/palette/bar) and from the 0x41 LCD echo the ACK matcher
// keys on (device.js _onData matches byte[0]===0x41; 0x4B can never false-resolve an in-flight ACK wait).
// report = [0x4B, panelId, 0, 0, ...]. panelId: 0x00 nowplaying, 0x01 weather, 0x02 clock,
// 0xF0 CYCLE_TOGGLE (pause/resume rotation), 0xF1 PANEL_NEXT (advance one). Read-only from the host's
// side — there is no builder here on purpose; the host never constructs this report, only decodes it.
export const PANEL_REQ = 0x4b;
export const PANEL_ID = Object.freeze({ NOWPLAYING: 0x00, WEATHER: 0x01, CLOCK: 0x02, CYCLE_TOGGLE: 0xf0, PANEL_NEXT: 0xf1 });
/** Map a wire panelId to the auto-cycle SPARC's panel name (`cycle.js` panels[].id). null if unknown/control id. */
export const PANEL_NAME_BY_ID = Object.freeze({
  [PANEL_ID.NOWPLAYING]: 'nowplaying',
  [PANEL_ID.WEATHER]: 'weather',
  [PANEL_ID.CLOCK]: 'clock',
});

/** Serialize a logical packet (64-byte body) to the capture-schema hex string, for tests/logs. */
export function toHex(pkt) {
  return Array.from(pkt, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
