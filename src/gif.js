// AL80 Studio — animated GIF processing. Browser-only (WebCodecs ImageDecoder + Canvas 2D).
//
// Decodes an animated GIF into an array of 30,688-byte RGB565-BE frames, each drawn
// centre-fit (cover) onto a 112x137 canvas. The RGB565 quantization lives in
// protocol.js; this module handles decode + fit + the RGBA -> rgb565BE hand-off.
//
// ImageDecoder (WebCodecs) is required. It is exposed on Window and DedicatedWorker in
// Chromium-based browsers, needs a secure context (https / localhost), and is not
// available in Firefox or Safari as of mid-2026. When absent we throw a clear error.

import { WIDTH, HEIGHT, rgb565BE } from './protocol.js';
import { fitDraw } from './image.js';

const BROWSER_REQ =
  'ImageDecoder (WebCodecs) is unavailable. Animated GIF import needs a Chromium-based ' +
  'browser (Chrome/Edge 94+) over a secure context (https or localhost). Firefox and ' +
  'Safari do not support it yet.';

/** True if the WebCodecs ImageDecoder API is usable in this context. */
function hasImageDecoder() {
  return typeof ImageDecoder !== 'undefined';
}

/** Create a 112x137 surface (OffscreenCanvas preferred, DOM canvas fallback). */
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error('gif.js: no canvas available (needs a browser or OffscreenCanvas).');
}

/**
 * Open an ImageDecoder for `file` and wait until tracks are ready and the data is
 * fully buffered (frameCount is only stable once `completed` resolves).
 * @param {File|Blob} file
 * @returns {Promise<ImageDecoder>}
 */
async function openDecoder(file) {
  if (!hasImageDecoder()) throw new Error(BROWSER_REQ);
  const type = file.type || 'image/gif';
  if (typeof ImageDecoder.isTypeSupported === 'function') {
    const ok = await ImageDecoder.isTypeSupported(type);
    if (!ok) throw new Error(`gif.js: this browser cannot decode "${type}".`);
  }
  const data = await file.arrayBuffer();
  const decoder = new ImageDecoder({ data, type });
  await decoder.tracks.ready; // populate track list before reading selectedTrack
  await decoder.completed; // frameCount is only reliable once buffering is complete
  return decoder;
}

/**
 * Draw a decoded VideoFrame onto the `w`x`h` context using the chosen fit rule.
 * Delegates to the SAME fitDraw the Picture tab uses, so GIF and still-image framing
 * can't diverge (a VideoFrame reports its size via displayWidth/Height, which srcDims reads).
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {VideoFrame} frame
 * @param {number} w
 * @param {number} h
 * @param {'cover'|'contain'|'stretch'} fit
 * @param {string} padColor  used only for 'contain'
 */
function drawVideoFrame(ctx, frame, w, h, fit, padColor) {
  fitDraw(ctx, frame, w, h, fit, padColor);
}

/**
 * Count frames in an animated GIF (or 1 for a still image).
 * @param {File|Blob} file
 * @returns {Promise<number>}
 */
export async function gifFrameCount(file) {
  const decoder = await openDecoder(file);
  try {
    return decoder.tracks.selectedTrack?.frameCount ?? 0;
  } finally {
    decoder.close();
  }
}

/**
 * Decode an animated GIF into RGB565-BE frames for the LCD.
 *
 * Returns an array of Uint8Array(FRAME_BYTES). The array object also carries metadata:
 *   .frameCount  total frames in the GIF (before capping)
 *   .truncated   true if the GIF had more than `maxFrames`
 *   .note        human-readable note when truncated (else '')
 *
 * @param {File|Blob} file
 * @param {{maxFrames?: number}} [opts]
 * @returns {Promise<Uint8Array[] & {frameCount:number, truncated:boolean, note:string}>}
 */
export async function gifToFrames(file, { maxFrames = 64, width = WIDTH, height = HEIGHT, fit = 'cover', padColor = '#000000' } = {}) {
  const decoder = await openDecoder(file);
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('gif.js: could not get a 2D context.');
  const expectBytes = width * height * 2;

  try {
    const track = decoder.tracks.selectedTrack;
    const total = track?.frameCount ?? 0;
    const n = Math.min(total, Math.max(0, maxFrames));

    /** @type {Uint8Array[]} */
    const frames = [];
    for (let i = 0; i < n; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      try {
        drawVideoFrame(ctx, image, width, height, fit, padColor);
        const rgba = ctx.getImageData(0, 0, width, height).data;
        const frame = rgb565BE(rgba);
        if (frame.length !== expectBytes) {
          throw new Error(`gif.js: frame ${i} produced ${frame.length} bytes, expected ${expectBytes}`);
        }
        frames.push(frame);
      } finally {
        image.close();
      }
    }

    const truncated = total > n;
    const note = truncated ? `GIF has ${total} frames; kept the first ${n} (maxFrames=${maxFrames}).` : '';
    if (truncated && typeof console !== 'undefined') console.warn(`gif.js: ${note}`);

    // Attach metadata to the returned array without disturbing its array-ness.
    const out = /** @type {Uint8Array[] & {frameCount:number, truncated:boolean, note:string}} */ (frames);
    Object.defineProperties(out, {
      frameCount: { value: total, enumerable: false },
      truncated: { value: truncated, enumerable: false },
      note: { value: note, enumerable: false },
    });
    return out;
  } finally {
    decoder.close();
  }
}
