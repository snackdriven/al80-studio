// Framebuffer diff: find what changed between two frames so we can send a partial update
// instead of a full 549-block transfer. Returns the bounding changed byte range (simple and
// exact for localized changes like a ticking clock; scattered changes over-send the bounding
// box, which is fine — still far cheaper than a full frame).
import { FRAME_BYTES, BLOCK } from '../../src/protocol.js';

/**
 * @returns {{changed:boolean, full?:boolean, start?:number, end?:number, span?:number, blocks?:number}}
 *   changed=false  -> identical, send nothing
 *   full=true      -> first frame or >threshold changed, send a full transfer
 *   else           -> send buildImageRegion(next, start, end)
 */
export function diffRegion(prev, next, { fullThreshold = 0.6 } = {}) {
  if (!prev) return { changed: true, full: true, start: 0, end: FRAME_BYTES };
  let start = -1, end = -1;
  for (let i = 0; i < FRAME_BYTES; i++) {
    if (prev[i] !== next[i]) { if (start < 0) start = i; end = i + 1; }
  }
  if (start < 0) return { changed: false };
  const span = end - start;
  const full = span / FRAME_BYTES > fullThreshold;
  const alignedStart = start - (start % BLOCK);
  const blocks = Math.ceil((end - alignedStart) / BLOCK);
  return { changed: true, full, start, end, span, blocks };
}
