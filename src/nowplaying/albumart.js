// Browser album-art decode: cover-art URL -> the 96x96 RGB buffer card.render() blits as
// state.artRGB (Uint8Array length 96*96*3 = 27648, row-major, 3 bytes/px, no alpha). Replaces the
// Node host's jpeg-js path (host/lib/art.js decodeToRGB96) — the browser decodes the image natively
// with an <img>, downscales via a <canvas>, and reads pixels with getImageData.
//
// CORS: Spotify's image CDN (i.scdn.co) generally sends Access-Control-Allow-Origin, so loading with
// crossOrigin='anonymous' lets us read the canvas back. If a particular image taints the canvas
// (getImageData throws a SecurityError), we swallow it and return null — card.render() then falls
// back to the themed placeholder tile instead of failing the whole push.

import { ART, ART_RGB_BYTES } from './art.js';

/**
 * Load a cover-art URL and return a 96x96 row-major RGB buffer, or null if it can't be read
 * (network error, or a CORS-tainted canvas). Never throws — the caller treats null as "no art".
 * @param {string} url
 * @returns {Promise<Uint8Array|null>}  length ART_RGB_BYTES, or null
 */
export async function loadArtRGB(url) {
  if (!url) return null;
  let img;
  try {
    img = await loadImage(url);
  } catch {
    return null; // network / decode failure
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = ART;
    canvas.height = ART;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Box-ish downscale for free: the 2D context resamples when we draw the source into 96x96.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, ART, ART);
    const rgba = ctx.getImageData(0, 0, ART, ART).data; // throws if the canvas is tainted
    const out = new Uint8Array(ART_RGB_BYTES);
    for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
      out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2]; // drop alpha
    }
    return out;
  } catch {
    return null; // tainted canvas (CORS) — fall back to placeholder
  }
}

/** Load an <img> with anonymous CORS so its pixels can be read back from a canvas. */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}
