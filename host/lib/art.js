// Album-art decode + downscale: JPEG bytes -> the 96x96 RGB buffer nowplaying.render() blits as
// state.artRGB. That blit (apps/nowplaying.js blitArt) reads artRGB[(y*96+x)*3 + {0,1,2}], so the
// contract here is EXACT: a Uint8Array of length 96*96*3 = 27648, row-major, 3 bytes/px (R,G,B),
// no alpha, no padding.
//
// DECODE APPROACH — the host/ package is deliberately zero-dependency (only node-hid, native, for
// the real transport). We use `jpeg-js` (pure JS, no native build) for the decode and a hand-written
// box-average downscale here. jpeg-js.decode returns RGBA (4 bytes/px), so we drop alpha while we
// average.
//
//   Dep status: `npm install --no-save jpeg-js` for the spike (dev only, not written to
//   package.json). For production, vendor lib/jpeg-js/ (copy node_modules/jpeg-js into host/lib/,
//   MIT) and import from there so there's still no *runtime* npm dependency. This file already
//   imports lazily so a missing decoder fails loudly only when art is actually requested.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export const ART = 96;                 // target tile is 96x96 (top square of the picture page)
export const ART_RGB_BYTES = ART * ART * 3; // 27648

let _jpeg = null;
/** Lazy-load the JPEG decoder. Prefers a vendored copy (lib/jpeg-js), falls back to the npm dep. */
function jpeg() {
  if (_jpeg) return _jpeg;
  for (const id of ['./jpeg-js/index.js', 'jpeg-js']) {
    try { _jpeg = require(id); return _jpeg; } catch { /* try next */ }
  }
  throw new Error('art.js: no JPEG decoder found. Run `npm install --no-save jpeg-js` (spike) or vendor host/lib/jpeg-js/ (prod).');
}

/**
 * Box-average downscale of an RGBA source (w*h*4) into a 96x96 RGB buffer.
 * Each destination pixel averages the source pixels that map into its cell — noticeably cleaner
 * than nearest-neighbor when shrinking a 300px cover to 96px. Alpha is dropped.
 * @param {Uint8Array} src   RGBA, length w*h*4
 * @param {number} w
 * @param {number} h
 * @returns {Uint8Array} length 96*96*3
 */
export function downscaleRGBAtoRGB96(src, w, h) {
  const out = new Uint8Array(ART_RGB_BYTES);
  for (let dy = 0; dy < ART; dy++) {
    const sy0 = Math.floor((dy * h) / ART);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * h) / ART));
    for (let dx = 0; dx < ART; dx++) {
      const sx0 = Math.floor((dx * w) / ART);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * w) / ART));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let si = (sy * w + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          r += src[si]; g += src[si + 1]; b += src[si + 2]; n++;
          si += 4;
        }
      }
      const o = (dy * ART + dx) * 3;
      out[o] = (r / n) | 0;
      out[o + 1] = (g / n) | 0;
      out[o + 2] = (b / n) | 0;
    }
  }
  return out;
}

/**
 * Decode a JPEG buffer and downscale to the 96x96 RGB buffer nowplaying.render() expects as
 * state.artRGB. This is the drop-in the art-cache path feeds the app (fetch cover -> this -> artRGB).
 * @param {Buffer|Uint8Array} jpegBuffer  raw JPEG bytes (e.g. an i.scdn.co cover download)
 * @returns {Uint8Array} length 96*96*3, row-major RGB
 */
export function decodeToRGB96(jpegBuffer) {
  const raw = jpeg().decode(jpegBuffer, { useTArray: true, formatAsRGBA: true });
  // jpeg-js returns RGBA (4 bytes/px) by default; formatAsRGBA is the explicit, stable request.
  return downscaleRGBAtoRGB96(raw.data, raw.width, raw.height);
}

// ── DOMINANT / ACCENT COLOR ─────────────────────────────────────────────────────────────────────
// From a decoded album-art RGB buffer, pick one pleasant accent color — the seed for future
// screen-synced RGB lighting (recolor a preset effect to match what's on screen). We want the color
// a human would name if asked "what color is this cover", NOT the flat pixel average (which muddies
// to gray). Approach: convert every pixel to HSV, throw out near-black and near-white/gray pixels
// (they carry no usable hue and would drag a keyboard's LEDs toward a dull wash), bin the survivors
// into hue buckets weighted by colorfulness (saturation × value), pick the heaviest bucket, and take
// the circular-mean hue + weighted-mean saturation inside it. Pure + unit-testable: RGB in, {hue,sat}
// out. Hue is 0–360°, sat is 0–1. No I/O, no decode — feed it decodeToRGB96()'s output (or any RGB).

/** sRGB [0..255] triplet -> {h:0-360, s:0-1, v:0-1}. Standard HSV. */
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** {h:0-360, s:0-1, v:0-1} -> [r,g,b] 0..255. Inverse of rgbToHsv. */
export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Dominant/accent color of an album-art RGB buffer, skewed away from near-black and near-white.
 * @param {Uint8Array|Buffer} rgb   packed RGB, length must be a multiple of 3 (e.g. decodeToRGB96 out)
 * @param {object} [opts]
 * @param {number} [opts.buckets=24]   hue bins (24 -> 15° each)
 * @param {number} [opts.minV=0.16]    drop pixels darker than this (near-black)
 * @param {number} [opts.maxV=0.98]    drop blown-out pixels (near-white)
 * @param {number} [opts.minS=0.18]    drop pixels grayer than this (no usable hue)
 * @returns {{hue:number, sat:number}}  hue 0-360, sat 0-1. Falls back to a neutral teal-ish
 *          low-sat value if the image is essentially grayscale (nothing colorful survives the filter).
 */
export function dominantColor(rgb, opts = {}) {
  const { buckets = 24, minV = 0.16, maxV = 0.98, minS = 0.18 } = opts;
  const N = (rgb.length / 3) | 0;
  const wsum = new Float64Array(buckets); // total colorfulness weight per hue bucket
  const sSum = new Float64Array(buckets); // weighted saturation per bucket
  const cos = new Float64Array(buckets);  // weighted cos(hue) — for circular mean
  const sin = new Float64Array(buckets);  // weighted sin(hue)
  let kept = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 3;
    const { h, s, v } = rgbToHsv(rgb[o], rgb[o + 1], rgb[o + 2]);
    // skip near-black, near-gray, and blown-out PALE pixels — but keep vivid full-brightness
    // colors (pure red is v=1.0 yet obviously not white; white is caught by the low-sat test).
    if (v < minV || s < minS || (v > maxV && s < 0.4)) continue;
    const w = s * v;                                 // colorfulness: vivid + bright pixels win
    const bi = Math.min(buckets - 1, Math.floor((h / 360) * buckets));
    const rad = (h * Math.PI) / 180;
    wsum[bi] += w; sSum[bi] += s * w;
    cos[bi] += Math.cos(rad) * w; sin[bi] += Math.sin(rad) * w;
    kept++;
  }
  if (kept === 0) return { hue: 175, sat: 0.12 }; // grayscale cover -> quiet neutral, not a hard color
  // heaviest bucket wins
  let best = 0;
  for (let i = 1; i < buckets; i++) if (wsum[i] > wsum[best]) best = i;
  const hue = ((Math.atan2(sin[best], cos[best]) * 180) / Math.PI + 360) % 360;
  const sat = Math.min(1, sSum[best] / wsum[best]);
  return { hue, sat };
}

/**
 * Convenience: dominant color as an [r,g,b] accent ready to paint (progress bar, future LED sync).
 * Clamps saturation and forces a bright value so the accent reads on the dark UI and on RGB LEDs
 * (a raw dominant of a dark cover would be near-invisible). Pure.
 * @param {Uint8Array|Buffer} rgb
 * @param {{v?:number, minSat?:number}} [opts]  v = output brightness, minSat floors dull covers.
 * @returns {number[]} [r,g,b] 0..255
 */
export function accentFromArt(rgb, { v = 0.92, minSat = 0.35 } = {}) {
  const { hue, sat } = dominantColor(rgb);
  return hsvToRgb(hue, Math.max(minSat, Math.min(0.9, sat)), v);
}
