// AL80 Studio — still-image processing. Browser-only (Canvas 2D). No dependencies.
//
// Turns an arbitrary image source into the exact 30,688-byte RGB565-BE frame the
// LCD expects (112x137). The RGB565 quantization itself lives in protocol.js; this
// module only handles decode, fit/scale, colour adjustment, optional dithering, and
// the RGBA -> rgb565BE hand-off.
//
// Pipeline:  source -> ImageBitmap/HTMLImageElement
//                   -> draw onto 112x137 canvas (cover / contain / stretch, smoothing on)
//                   -> ctx.filter (brightness / contrast / saturate / grayscale)
//                   -> [optional] Floyd-Steinberg dither snapped to 5/6/5 levels
//                   -> getImageData -> protocol.rgb565BE -> Uint8Array(30688)

import { WIDTH, HEIGHT, FRAME_BYTES, MP_W, MP_H, MP_FRAME_BYTES, rgb565BE } from './protocol.js';

/**
 * @typedef {Object} ImageOpts
 * @property {'cover'|'contain'|'stretch'} [fit='cover']  cover=fill+centre-crop, contain=fit+pad, stretch=exact
 * @property {string} [padColor='#000000']  CSS colour used to pad in 'contain' mode
 * @property {number} [brightness=1]  1 = unchanged (CSS filter multiplier)
 * @property {number} [contrast=1]    1 = unchanged
 * @property {number} [saturation=1]  1 = unchanged, 0 = greyscale
 * @property {boolean} [grayscale=false]  hard greyscale (grayscale(1))
 * @property {boolean} [dither=false]  Floyd-Steinberg error diffusion before RGB565 quantization
 */

/** @type {Required<ImageOpts>} */
const DEFAULTS = {
  fit: 'cover',
  padColor: '#000000',
  brightness: 1,
  contrast: 1,
  saturation: 1,
  grayscale: false,
  dither: false,
};

// --- 5/6/5 helpers (kept identical between dither reconstruction and preview decode
//     so the preview shows exactly the colours the device will receive) ------------
const expand5 = (l) => (l << 3) | (l >> 2); // 5-bit level -> 8-bit
const expand6 = (l) => (l << 2) | (l >> 4); // 6-bit level -> 8-bit
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Create a 112x137 drawing surface. Prefers OffscreenCanvas (works in workers too),
 * falls back to a detached <canvas>.
 * @param {number} w
 * @param {number} h
 * @returns {OffscreenCanvas|HTMLCanvasElement}
 */
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error('image.js: no canvas available (needs a browser or OffscreenCanvas).');
}

/**
 * Decode `source` into something drawImage() accepts. Returns the drawable plus a
 * `close()` you must call when done (no-op for sources we did not create).
 * @param {File|Blob|HTMLImageElement|ImageBitmap} source
 * @returns {Promise<{drawable: CanvasImageSource, close: () => void}>}
 */
async function decodeSource(source) {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    return { drawable: source, close: () => {} };
  }
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    // Make sure it has actually decoded before we draw it.
    if (!source.complete && typeof source.decode === 'function') {
      try {
        await source.decode();
      } catch {
        /* fall through; drawImage will still work if it is loaded */
      }
    }
    return { drawable: source, close: () => {} };
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const bitmap = await createImageBitmap(source);
    return { drawable: bitmap, close: () => bitmap.close() };
  }
  throw new Error('image.js: unsupported source (expected File | Blob | HTMLImageElement | ImageBitmap).');
}

/** Natural pixel size of any drawable. */
function srcDims(img) {
  const w = img.naturalWidth || img.videoWidth || img.displayWidth || img.width || 0;
  const h = img.naturalHeight || img.videoHeight || img.displayHeight || img.height || 0;
  return { w, h };
}

/**
 * Draw `img` onto a `w`x`h` context using the chosen fit rule.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {CanvasImageSource} img
 * @param {number} w
 * @param {number} h
 * @param {'cover'|'contain'|'stretch'} fit
 * @param {string} padColor  used only for 'contain'
 */
export function fitDraw(ctx, img, w, h, fit, padColor) {
  const { w: sw, h: sh } = srcDims(img);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (fit === 'stretch' || !sw || !sh) {
    ctx.drawImage(img, 0, 0, w, h);
    return;
  }
  if (fit === 'contain') {
    ctx.fillStyle = padColor;
    ctx.fillRect(0, 0, w, h);
    const scale = Math.min(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return;
  }
  // cover: fill the whole surface, centre-crop the overflow
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Build a CSS filter string from colour opts, or 'none'. */
function filterString(o) {
  const parts = [];
  if (o.brightness !== 1) parts.push(`brightness(${o.brightness})`);
  if (o.contrast !== 1) parts.push(`contrast(${o.contrast})`);
  if (o.saturation !== 1) parts.push(`saturate(${o.saturation})`);
  if (o.grayscale) parts.push('grayscale(1)');
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * Floyd-Steinberg dither the RGBA buffer in place, snapping every pixel to a
 * 5/6/5-representable value. After this, each channel's stored 8-bit value is
 * `level << (8 - bits)`, so protocol.rgb565BE (which truncates with >>3 / >>2)
 * reproduces exactly the intended level with no further loss.
 * @param {Uint8ClampedArray} data  RGBA, length w*h*4
 * @param {number} w
 * @param {number} h
 */
function ditherFloydSteinberg(data, w, h) {
  const n = w * h;
  // Work in float per channel so error can accumulate below/above 0..255.
  const rf = new Float32Array(n);
  const gf = new Float32Array(n);
  const bf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    rf[i] = data[i * 4];
    gf[i] = data[i * 4 + 1];
    bf[i] = data[i * 4 + 2];
  }

  const quant = (val, bits) => {
    const levels = (1 << bits) - 1;
    const l = clamp(Math.round((val / 255) * levels), 0, levels);
    const recon = bits === 5 ? expand5(l) : expand6(l);
    const store = l << (8 - bits); // truncation-exact for rgb565BE
    return { store, recon };
  };

  const spread = (buf, idx, err) => {
    buf[idx] += err;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = quant(rf[i], 5);
      const g = quant(gf[i], 6);
      const b = quant(bf[i], 5);

      const er = rf[i] - r.recon;
      const eg = gf[i] - g.recon;
      const eb = bf[i] - b.recon;

      data[i * 4] = r.store;
      data[i * 4 + 1] = g.store;
      data[i * 4 + 2] = b.store;
      // alpha left as-is; LCD is opaque, rgb565BE ignores alpha

      const right = x + 1 < w ? i + 1 : -1;
      const below = y + 1 < h;
      const bl = below && x > 0 ? i + w - 1 : -1;
      const bc = below ? i + w : -1;
      const br = below && x + 1 < w ? i + w + 1 : -1;

      if (right >= 0) {
        spread(rf, right, (er * 7) / 16);
        spread(gf, right, (eg * 7) / 16);
        spread(bf, right, (eb * 7) / 16);
      }
      if (bl >= 0) {
        spread(rf, bl, (er * 3) / 16);
        spread(gf, bl, (eg * 3) / 16);
        spread(bf, bl, (eb * 3) / 16);
      }
      if (bc >= 0) {
        spread(rf, bc, (er * 5) / 16);
        spread(gf, bc, (eg * 5) / 16);
        spread(bf, bc, (eb * 5) / 16);
      }
      if (br >= 0) {
        spread(rf, br, (er * 1) / 16);
        spread(gf, br, (eg * 1) / 16);
        spread(bf, br, (eb * 1) / 16);
      }
    }
  }
}

/**
 * Shared core: render `source` to a 112x137 RGBA buffer with all opts applied
 * (fit, filters, optional dither). Returns the Uint8ClampedArray from getImageData.
 * @param {File|Blob|HTMLImageElement|ImageBitmap} source
 * @param {ImageOpts} [opts]
 * @returns {Promise<Uint8ClampedArray>}
 */
async function renderRGBA(source, opts = {}, w = WIDTH, h = HEIGHT) {
  const o = { ...DEFAULTS, ...opts };
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('image.js: could not get a 2D context.');

  const { drawable, close } = await decodeSource(source);
  try {
    ctx.filter = filterString(o);
    fitDraw(ctx, drawable, w, h, o.fit, o.padColor);
    ctx.filter = 'none';
  } finally {
    close();
  }

  const img = ctx.getImageData(0, 0, w, h);
  if (o.dither) ditherFloydSteinberg(img.data, w, h);
  return img.data;
}

/**
 * Turn any image source into the LCD's 30,688-byte RGB565-BE frame.
 * @param {File|Blob|HTMLImageElement|ImageBitmap} source
 * @param {ImageOpts} [opts]
 * @returns {Promise<Uint8Array>}  exactly FRAME_BYTES long
 */
export async function imageToFrame(source, opts = {}) {
  const rgba = await renderRGBA(source, opts);
  const frame = rgb565BE(rgba);
  if (frame.length !== FRAME_BYTES) {
    throw new Error(`imageToFrame: expected ${FRAME_BYTES} bytes, produced ${frame.length}`);
  }
  return frame;
}

/**
 * Turn any image source into a MAIN-PAGE frame: 96x64 RGB565-BE (12,288 bytes).
 * The main page is the only surface that actually displays on the AL80's firmware,
 * so this — not imageToFrame — is what "Send & show" should use.
 * @param {File|Blob|HTMLImageElement|ImageBitmap} source
 * @param {ImageOpts} [opts]
 * @returns {Promise<Uint8Array>}  exactly MP_FRAME_BYTES long
 */
export async function imageToMainPageFrame(source, opts = {}) {
  const rgba = await renderRGBA(source, opts, MP_W, MP_H);
  const frame = rgb565BE(rgba);
  if (frame.length !== MP_FRAME_BYTES) {
    throw new Error(`imageToMainPageFrame: expected ${MP_FRAME_BYTES} bytes, produced ${frame.length}`);
  }
  return frame;
}

/**
 * Expand a 30,688-byte RGB565-BE frame back to RGBA (the real, quantized colours).
 * @param {Uint8Array} frame
 * @returns {Uint8ClampedArray}  length WIDTH*HEIGHT*4
 */
export function frameToRGBA(frame) {
  const out = new Uint8ClampedArray((frame.length / 2) * 4);
  for (let i = 0, o = 0; i < frame.length; i += 2, o += 4) {
    const v = (frame[i] << 8) | frame[i + 1];
    out[o] = expand5(v >> 11);
    out[o + 1] = expand6((v >> 5) & 0x3f);
    out[o + 2] = expand5(v & 0x1f);
    out[o + 3] = 255;
  }
  return out;
}

/** Turn a canvas (Offscreen or DOM) into a PNG data URL. */
async function canvasToDataURL(canvas) {
  if (typeof canvas.toDataURL === 'function') return canvas.toDataURL('image/png');
  // OffscreenCanvas path
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(/** @type {string} */ (fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/**
 * Produce a 112x137 PNG data URL of exactly what will be sent to the LCD. The pixels
 * are round-tripped through RGB565 so the preview shows the real device quantization
 * (and, if enabled, the dither pattern).
 * @param {File|Blob|HTMLImageElement|ImageBitmap} source
 * @param {ImageOpts} [opts]
 * @returns {Promise<string>}  data:image/png;base64,...
 */
export async function previewDataURL(source, opts = {}) {
  const frame = await imageToFrame(source, opts);
  const rgba = frameToRGBA(frame);
  const canvas = makeCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('image.js: could not get a 2D context for preview.');
  ctx.putImageData(new ImageData(rgba, WIDTH, HEIGHT), 0, 0);
  return await canvasToDataURL(canvas);
}

/**
 * Preview of exactly what the MAIN-PAGE upload will send: 96x64, round-tripped through
 * RGB565 so the quantization (and dither) match the device.
 * @param {File|Blob|HTMLImageElement|ImageBitmap} source
 * @param {ImageOpts} [opts]
 * @returns {Promise<string>}
 */
export async function previewMainPageDataURL(source, opts = {}) {
  const frame = await imageToMainPageFrame(source, opts);
  const rgba = frameToRGBA(frame);
  const canvas = makeCanvas(MP_W, MP_H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('image.js: could not get a 2D context for preview.');
  ctx.putImageData(new ImageData(rgba, MP_W, MP_H), 0, 0);
  return await canvasToDataURL(canvas);
}
