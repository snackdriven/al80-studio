// Drawing onto a 96x160 RGB565 big-endian framebuffer — the exact byte format
// protocol.buildImageTransfer() sends. Ported from host/lib/render.js; the only change is the
// protocol import path (../protocol.js in the app vs ../../src/protocol.js in the host). Apps draw
// in plain row-major logical space; the transport handles the wire.
import { WIDTH, HEIGHT, FRAME_BYTES } from '../protocol.js';
import { glyph, GLYPH_W, GLYPH_H } from './font.js';
export { GLYPH_H, WIDTH, HEIGHT };

export function rgb565(r, g, b) {
  const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
  return [(v >> 8) & 0xff, v & 0xff];
}

export function newFrame([r, g, b] = [0, 0, 0]) {
  const fb = new Uint8Array(FRAME_BYTES);
  clear(fb, [r, g, b]);
  return fb;
}

export function clear(fb, [r, g, b] = [0, 0, 0]) {
  const [hi, lo] = rgb565(r, g, b);
  for (let i = 0; i < fb.length; i += 2) { fb[i] = hi; fb[i + 1] = lo; }
}

export function setPx(fb, x, y, [r, g, b]) {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const p = (y * WIDTH + x) * 2;
  const [hi, lo] = rgb565(r, g, b);
  fb[p] = hi; fb[p + 1] = lo;
}

export function fillRect(fb, x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPx(fb, xx, yy, color);
}

/** Draw a string with the 5x7 font. Returns the x just past the text. */
export function drawText(fb, str, x, y, { scale = 1, gap = 1, color = [255, 255, 255] } = {}) {
  let cx = x;
  for (const ch of String(str)) {
    const g = glyph(ch);
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (g[gy][gx] === '#') fillRect(fb, cx + gx * scale, y + gy * scale, scale, scale, color);
      }
    }
    cx += (GLYPH_W + gap) * scale;
  }
  return cx - gap * scale;
}
