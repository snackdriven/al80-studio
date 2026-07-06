// Pure album-art color math — the accent/dominant-color functions ported from host/lib/art.js.
// The Node original also decoded JPEGs (jpeg-js + createRequire); in the browser we decode cover
// art with an <img> + <canvas> instead (see albumart.js), so this file keeps ONLY the pure,
// dependency-free color functions. RGB in, {hue,sat} / [r,g,b] out. No I/O, no DOM — unit-testable.

export const ART = 96;                        // album-art tile is 96x96 (top square of the card)
export const ART_RGB_BYTES = ART * ART * 3;   // 27648

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
 * @param {Uint8Array} rgb   packed RGB, length a multiple of 3 (e.g. 96*96*3 from albumart.js)
 * @returns {{hue:number, sat:number}}  hue 0-360, sat 0-1.
 */
export function dominantColor(rgb, opts = {}) {
  const { buckets = 24, minV = 0.16, maxV = 0.98, minS = 0.18 } = opts;
  const N = (rgb.length / 3) | 0;
  const wsum = new Float64Array(buckets);
  const sSum = new Float64Array(buckets);
  const cos = new Float64Array(buckets);
  const sin = new Float64Array(buckets);
  let kept = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 3;
    const { h, s, v } = rgbToHsv(rgb[o], rgb[o + 1], rgb[o + 2]);
    if (v < minV || s < minS || (v > maxV && s < 0.4)) continue;
    const w = s * v;
    const bi = Math.min(buckets - 1, Math.floor((h / 360) * buckets));
    const rad = (h * Math.PI) / 180;
    wsum[bi] += w; sSum[bi] += s * w;
    cos[bi] += Math.cos(rad) * w; sin[bi] += Math.sin(rad) * w;
    kept++;
  }
  if (kept === 0) return { hue: 175, sat: 0.12 }; // grayscale cover -> quiet neutral
  let best = 0;
  for (let i = 1; i < buckets; i++) if (wsum[i] > wsum[best]) best = i;
  const hue = ((Math.atan2(sin[best], cos[best]) * 180) / Math.PI + 360) % 360;
  const sat = Math.min(1, sSum[best] / wsum[best]);
  return { hue, sat };
}

/**
 * Dominant color as an [r,g,b] accent ready to paint (progress bar / future LED sync). Clamps
 * saturation and forces a bright value so the accent reads on the dark card. Pure.
 * @param {Uint8Array} rgb
 * @returns {number[]} [r,g,b] 0..255
 */
export function accentFromArt(rgb, { v = 0.92, minSat = 0.35 } = {}) {
  const { hue, sat } = dominantColor(rgb);
  return hsvToRgb(hue, Math.max(minSat, Math.min(0.9, sat)), v);
}
