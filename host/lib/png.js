// Minimal zero-dependency PNG encoder (RGB, 8-bit). Uses Node's built-in zlib.
// Enough to preview a framebuffer as a real PNG file — no native deps, no npm install.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode an RGB pixel buffer to a PNG Buffer.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb  width*height*3 bytes, row-major
 * @returns {Buffer}
 */
export function encodePNG(width, height, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  // 10,11,12 = compression/filter/interlace = 0
  // scanlines with filter byte 0 prefixed
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** RGB565 big-endian framebuffer -> RGB888 buffer (for PNG). scale = integer nearest-neighbor zoom. */
export function rgb565ToRGB(fb, width, height, scale = 1) {
  const outW = width * scale, outH = height * scale;
  const out = new Uint8Array(outW * outH * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 2;
      const v = (fb[p] << 8) | fb[p + 1];
      const r = ((v >> 11) & 0x1f) * 255 / 31 | 0;
      const g = ((v >> 5) & 0x3f) * 255 / 63 | 0;
      const b = (v & 0x1f) * 255 / 31 | 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const o = ((y * scale + sy) * outW + (x * scale + sx)) * 3;
          out[o] = r; out[o + 1] = g; out[o + 2] = b;
        }
      }
    }
  }
  return { rgb: out, width: outW, height: outH };
}
