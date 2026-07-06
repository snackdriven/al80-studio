// Now-playing card renderer — ported from host/apps/nowplaying.js. Renders a Spotify track onto
// the 96x160 portrait picture page: album art (top 96x96), title (up to 2 lines), artist, transport
// glyph, optional elapsed/total, and a progress bar. Pure render — no network, no DOM. The caller
// (the app's poll loop) supplies artRGB (decoded 96x96 via albumart.js) or null for the placeholder.
// Output is a 96x160 RGB565-BE frame ready for protocol.buildImageTransfer(). Matches the preview
// PNGs in host/apps/nowplaying-preview-*.png.

import { newFrame, fillRect, setPx, drawText, WIDTH } from './render.js';
import { GLYPH_W, GLYPH_H, textWidth } from './font.js';
import { accentFromArt } from './art.js';

const ART = 96;            // album-art tile is the top 96x96 square
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// Curated placeholder bases — muted, tasteful hues, picked by a hash of the artist name so the same
// artist always gets the same tile (stable, recognizable at a glance).
const PLACEHOLDER_BASES = [
  [32, 148, 140],  // teal
  [196, 142, 52],  // amber
  [120, 86, 180],  // violet
  [76, 152, 96],   // forest
  [160, 72, 140],  // plum
  [150, 140, 60],  // gold
  [70, 120, 130],  // slate-teal
  [96, 150, 110],  // moss
];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** First letter/digit of the artist, uppercased, for the placeholder monogram. */
function initial(artist) {
  const m = String(artist || '').match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : '?';
}

/** Placeholder album tile: a diagonal gradient in a hash-picked base color + the artist initial. */
function drawPlaceholderArt(fb, artist) {
  const base = PLACEHOLDER_BASES[hashStr(String(artist || '')) % PLACEHOLDER_BASES.length];
  const dark = [Math.round(base[0] * 0.28), Math.round(base[1] * 0.28), Math.round(base[2] * 0.28)];
  for (let y = 0; y < ART; y++) {
    for (let x = 0; x < ART; x++) {
      const t = (x + y) / (ART + ART - 2);
      setPx(fb, x, y, [lerp(dark[0], base[0], t), lerp(dark[1], base[1], t), lerp(dark[2], base[2], t)]);
    }
  }
  const light = [lerp(base[0], 255, 0.55), lerp(base[1], 255, 0.55), lerp(base[2], 255, 0.55)];
  const scale = 6; // 5x7 glyph -> 30x42
  const gw = GLYPH_W * scale, gh = GLYPH_H * scale;
  drawText(fb, initial(artist), Math.round((ART - gw) / 2), Math.round((ART - gh) / 2), { scale, color: light });
  return base;
}

/** Blit a 96x96 RGB (3 bytes/px, row-major) buffer into the top-left 96x96. */
function blitArt(fb, artRGB) {
  for (let y = 0; y < ART; y++) {
    for (let x = 0; x < ART; x++) {
      const i = (y * ART + x) * 3;
      setPx(fb, x, y, [artRGB[i], artRGB[i + 1], artRGB[i + 2]]);
    }
  }
}

/** Greedy wrap capped at `maxLines`, char-ellipsized on overflow so text never spills its field. */
function wrapClamped(str, maxWidth, maxLines, scale, gap) {
  const words = String(str || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (line && textWidth(test, scale, gap) > maxWidth) { lines.push(line); line = w; }
    else line = test;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  const usedWords = lines.join(' ').split(/\s+/).filter(Boolean).length;
  if (usedWords < words.length || (lines.length === maxLines && line && lines[maxLines - 1] !== line)) {
    let last = lines[lines.length - 1] || '';
    while (last && textWidth(last + '.', scale, gap) > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last.replace(/\s+$/, '') + '.'; // font has only '.', use single dot as ellipsis
  }
  return lines;
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Small play triangle or pause bars, drawn 7px tall at (x,y). */
function drawTransport(fb, x, y, paused, color) {
  if (paused) {
    fillRect(fb, x, y, 2, 7, color);
    fillRect(fb, x + 4, y, 2, 7, color);
  } else {
    for (let r = 0; r < 7; r++) {
      const w = Math.max(1, 4 - Math.abs(3 - r));
      fillRect(fb, x, y + r, w, 1, color);
    }
  }
}

/**
 * Render a now-playing frame.
 * @param {{title,artist,artRGB,progress,paused,elapsedMs?,durationMs?}} state
 * @returns {Uint8Array} 96x160 RGB565-BE frame (FRAME_BYTES long)
 */
export function render(state = {}) {
  const bg = [10, 11, 16];
  const fg = [235, 238, 245];
  const dim = [140, 150, 168];
  const track = [40, 44, 56];
  const fb = newFrame(bg);

  // --- top 96x96: album art (real blit if provided, else themed placeholder) ---
  let accent = [90, 210, 170];
  if (state.artRGB && state.artRGB.length >= ART * ART * 3) {
    blitArt(fb, state.artRGB);
    try { accent = accentFromArt(state.artRGB); } catch { /* keep default accent on any hiccup */ }
  } else {
    const base = drawPlaceholderArt(fb, state.artist);
    accent = [lerp(base[0], 255, 0.25), lerp(base[1], 255, 0.25), lerp(base[2], 255, 0.25)];
  }

  // --- title: up to 2 lines, scale 1, ellipsized on overflow ---
  const titleLines = wrapClamped(state.title || 'Nothing playing', WIDTH - 8, 2, 1, 1);
  let cy = 102;
  for (const ln of titleLines) { drawText(fb, ln, 4, cy, { scale: 1, color: fg }); cy += GLYPH_H + 3; }

  // --- artist: one line, dimmer, ellipsized ---
  const artistLine = wrapClamped(state.artist || '', WIDTH - 8, 1, 1, 1)[0] || '';
  drawText(fb, artistLine, 4, 124, { scale: 1, color: dim });

  // --- transport glyph + optional elapsed/total ---
  const barY = 150, barX = 4, barW = WIDTH - 8, barH = 4;
  const p = clamp01(Number(state.progress) || 0);
  drawTransport(fb, barX, barY - 12, !!state.paused, state.paused ? dim : accent);
  if (state.elapsedMs != null && state.durationMs != null) {
    const el = fmtTime(state.elapsedMs), tot = fmtTime(state.durationMs);
    drawText(fb, el, barX + 10, barY - 12, { scale: 1, color: dim });
    drawText(fb, tot, WIDTH - 4 - textWidth(tot, 1, 1), barY - 12, { scale: 1, color: dim });
  }

  // --- progress bar ---
  fillRect(fb, barX, barY, barW, barH, track);
  fillRect(fb, barX, barY, Math.round(p * barW), barH, accent);

  return fb;
}
