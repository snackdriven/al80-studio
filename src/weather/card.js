// Weather card renderer — the browser port of host/apps/weather.js. Renders current weather onto the
// 96x160 portrait picture page: a condition icon (~44px, 2-color pixel art), a big current
// temperature with a hand-drawn degree ring, condition text, today's hi/lo, a location label, and a
// bottom accent bar keyed to the condition. Pure render — no network, no DOM. Output is a 96x160
// RGB565-BE frame ready for protocol.buildImageTransfer(), same as nowplaying/card.js.
//
// It reuses the SAME pixel primitives nowplaying/card.js draws with (newFrame/fillRect/setPx/drawText
// over the shared 5x7 font in ../nowplaying/render.js) so both cards render pixel-identically to the
// Node host.
//
// State shape (from ../weather/weather.js getWeather / getWeatherMock):
//   { tempF, tempC, code, condition, icon, isDay, hiF, loF, hiC, loC, label, units }
//     tempF/tempC  current temperature in each unit (integers)
//     condition    UPPERCASE text, e.g. 'PARTLY CLOUDY'  (font is caps-only)
//     icon         'sun'|'moon'|'cloud'|'rain'|'snow'|'bolt'|'fog'  (drawn below)
//     hi*/lo*      today's max/min in each unit
//     label        location name, e.g. 'DETROIT'
//     units        'F'|'C' — which of temp/hi/lo to actually draw
// Every field is optional at draw time; missing values fall back to sensible defaults so a partial
// state never throws (mirrors nowplaying.render's placeholder path).
//
// FONT NOTE: the 5x7 font has NO degree glyph — it carries only 0-9, ':', space, '-', '/', '.',
// A-Z. So the '°' is drawn as a tiny hollow ring in code (drawDegree), not a char.

import { newFrame, fillRect, setPx, drawText, WIDTH } from '../nowplaying/render.js';
import { GLYPH_H, textWidth } from '../nowplaying/font.js';

const BG = [10, 11, 16]; // panel background — must match iconMoon's carve color

const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const shade = (c, t) => [lerp(c[0], 0, t), lerp(c[1], 0, t), lerp(c[2], 0, t)]; // toward black by t
const tint = (c, t) => [lerp(c[0], 255, t), lerp(c[1], 255, t), lerp(c[2], 255, t)]; // toward white by t

// Accent per condition icon — seeds both the icon body and the bottom bar (same idea as now-playing
// theming its progress bar off the cover art). Ported from host/apps/weather.js.
const ICON_ACCENT = {
  sun:   [245, 190, 70],   // warm gold
  moon:  [150, 160, 220],  // pale indigo
  cloud: [150, 165, 185],  // slate
  rain:  [90, 150, 225],   // blue
  snow:  [180, 210, 235],  // ice
  bolt:  [240, 205, 80],   // amber-yellow
  fog:   [160, 168, 178],  // muted gray
};
const CLOUD_GRAY = [120, 130, 145]; // secondary tone under rain/snow/bolt clouds

// ── ICON PRIMITIVES ─────────────────────────────────────────────────────────────────────────────

/** Solid disc of radius r centered at (cx,cy). */
function filledCircle(fb, cx, cy, r, color) {
  const r2 = r * r;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y <= r2) setPx(fb, cx + x, cy + y, color);
    }
  }
}

/** A short straight ray from radius r0 to r1 along a unit direction (dx,dy). */
function ray(fb, cx, cy, dx, dy, r0, r1, color) {
  for (let r = r0; r <= r1; r++) setPx(fb, Math.round(cx + dx * r), Math.round(cy + dy * r), color);
}

/** A puffy cloud (three discs + a flat base) centered around (cx,cy). Returns its base-line y. */
function drawCloud(fb, cx, cy, color) {
  filledCircle(fb, cx - 10, cy + 3, 8, color);
  filledCircle(fb, cx + 10, cy + 3, 8, color);
  filledCircle(fb, cx, cy - 4, 11, color);
  fillRect(fb, cx - 17, cy + 3, 34, 8, color); // flat underside
  return cy + 11;
}

// ── ICONS (~44px, 2-color, drawn with the primitives above) ───────────────────────────────────────

function iconSun(fb, cx, cy, accent) {
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]];
  for (const [dx, dy] of dirs) ray(fb, cx, cy, dx, dy, 15, 21, accent);
  filledCircle(fb, cx, cy, 12, accent);
  filledCircle(fb, cx, cy, 9, tint(accent, 0.25)); // brighter core for a little depth
}

function iconMoon(fb, cx, cy, accent) {
  // crescent: a disc with an offset disc carved out of it (carve color = the panel bg)
  filledCircle(fb, cx + 2, cy, 14, accent);
  filledCircle(fb, cx + 9, cy - 4, 13, BG); // bg — must match render()'s bg
}

function iconCloud(fb, cx, cy, accent) {
  drawCloud(fb, cx, cy - 2, shade(accent, 0.25)); // darker back puff for a little depth
  filledCircle(fb, cx, cy - 6, 9, accent);        // brighter front lobe
}

function iconRain(fb, cx, cy, accent) {
  const baseY = drawCloud(fb, cx, cy - 6, CLOUD_GRAY);
  for (let i = -1; i <= 1; i++) {
    const x = cx + i * 9;
    for (let s = 0; s < 6; s++) setPx(fb, x - Math.round(s / 2), baseY + 3 + s, accent); // slanted streak
  }
}

function iconSnow(fb, cx, cy, accent) {
  const baseY = drawCloud(fb, cx, cy - 6, CLOUD_GRAY);
  for (let i = -1; i <= 1; i++) {
    const x = cx + i * 9, y = baseY + 7;
    setPx(fb, x, y, accent); setPx(fb, x - 2, y, accent); setPx(fb, x + 2, y, accent); // horizontal
    setPx(fb, x, y - 2, accent); setPx(fb, x, y + 2, accent);                          // vertical
    setPx(fb, x - 1, y - 1, accent); setPx(fb, x + 1, y + 1, accent);                  // diagonals
    setPx(fb, x + 1, y - 1, accent); setPx(fb, x - 1, y + 1, accent);
  }
}

function iconBolt(fb, cx, cy, accent) {
  const baseY = drawCloud(fb, cx, cy - 6, CLOUD_GRAY);
  // a chunky zigzag lightning bolt under the cloud
  const bolt = [
    [cx + 2, baseY + 2], [cx - 2, baseY + 8], [cx + 1, baseY + 8], [cx - 3, baseY + 15],
  ];
  for (let i = 0; i < bolt.length - 1; i++) {
    const [x0, y0] = bolt[i], [x1, y1] = bolt[i + 1];
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps), y = Math.round(y0 + ((y1 - y0) * s) / steps);
      setPx(fb, x, y, accent); setPx(fb, x + 1, y, accent); // 2px thick
    }
  }
}

function iconFog(fb, cx, cy, accent) {
  // four stacked wavy bars
  for (let r = 0; r < 4; r++) {
    const y = cy - 12 + r * 8;
    const off = r % 2 ? 4 : -4; // alternate the inset so it reads as drifting fog
    fillRect(fb, cx - 18 + off, y, 34, 4, r % 2 ? shade(accent, 0.25) : accent);
  }
}

/** Draw the condition icon (~44px) centered at (cx,cy). Unknown ids fall back to a cloud. */
function drawIcon(fb, id, cx, cy) {
  const accent = ICON_ACCENT[id] || ICON_ACCENT.cloud;
  switch (id) {
    case 'sun':  return iconSun(fb, cx, cy, accent);
    case 'moon': return iconMoon(fb, cx, cy, accent);
    case 'rain': return iconRain(fb, cx, cy, accent);
    case 'snow': return iconSnow(fb, cx, cy, accent);
    case 'bolt': return iconBolt(fb, cx, cy, accent);
    case 'fog':  return iconFog(fb, cx, cy, accent);
    case 'cloud':
    default:     return iconCloud(fb, cx, cy, accent);
  }
}

// ── TEXT HELPERS ────────────────────────────────────────────────────────────────────────────────

// nowplaying/render.js doesn't export a centered-text helper (the host's render.js has one), so we
// center here with textWidth + drawText.
function drawTextCentered(fb, str, y, { scale = 1, gap = 1, color = [255, 255, 255] } = {}) {
  const w = textWidth(String(str), scale, gap);
  drawText(fb, str, Math.round((WIDTH - w) / 2), y, { scale, gap, color });
}

/** A tiny hollow degree ring (~4x4) with its top-left at (x,y). The font has no '°' glyph. */
function drawDegree(fb, x, y, color) {
  const pts = [[1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [3, 2], [1, 3], [2, 3]];
  for (const [dx, dy] of pts) setPx(fb, x + dx, y + dy, color);
}

/**
 * Greedy wrap to at most `maxLines`, ellipsizing the last kept line with '.' on overflow (the font
 * has only '.'). Same trick nowplaying/card.js uses so long condition text never spills.
 */
function wrapClamped(str, maxWidth, maxLines, scale = 1, gap = 1) {
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
  if (usedWords < words.length) {
    let last = lines[lines.length - 1] || '';
    while (last && textWidth(last + '.', scale, gap) > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last.replace(/\s+$/, '') + '.';
  }
  return lines;
}

/** Draw "HI 78°" style: label + number + a degree ring. Returns the x just past the ring. */
function drawTempLabeled(fb, x, y, label, value, color) {
  const cx = drawText(fb, `${label} ${value}`, x, y, { scale: 1, color });
  drawDegree(fb, cx + 1, y, color);
  return cx + 6;
}

/** Pick the temp/hi/lo in the state's active unit, with graceful fallbacks. */
function reading(state) {
  const c = state.units === 'C';
  const pick = (f, cc, d) => { const v = c ? cc : f; return v == null ? d : v; };
  return {
    temp: pick(state.tempF, state.tempC, 0),
    hi: pick(state.hiF, state.hiC, null),
    lo: pick(state.loF, state.loC, null),
  };
}

/**
 * Render a weather frame.
 * @param {{tempF,tempC,code,condition,icon,isDay,hiF,loF,hiC,loC,label,units}} state
 * @returns {Uint8Array} 96x160 RGB565-BE frame (FRAME_BYTES long)
 */
export function render(state = {}) {
  const fg = [235, 238, 245];
  const dim = [140, 150, 168];
  const fb = newFrame(BG);

  const iconId = state.icon || 'cloud';
  const accent = ICON_ACCENT[iconId] || ICON_ACCENT.cloud;
  const { temp, hi, lo } = reading(state);

  // --- location label (top, dim, centered) -----------------------------------------------
  drawTextCentered(fb, String(state.label || 'LOCAL').toUpperCase(), 5, { scale: 1, color: dim });

  // --- condition icon (centered, ~44px) --------------------------------------------------
  drawIcon(fb, iconId, 48, 36);

  // --- big current temperature (scale 4) + degree ring -----------------------------------
  const tempStr = String(Math.round(temp));
  const tScale = 4;
  const tW = textWidth(tempStr, tScale, 1);
  const groupW = tW + 8;                     // digits + degree ring gutter
  const tX = Math.round((WIDTH - groupW) / 2);
  const tY = 66;
  drawText(fb, tempStr, tX, tY, { scale: tScale, color: fg });
  drawDegree(fb, tX + tW + 2, tY, accent);   // degree superscript, themed to the condition

  // --- condition text (centered, up to 2 lines, ellipsized) ------------------------------
  const condLines = wrapClamped(state.condition || '---', WIDTH - 6, 2, 1, 1);
  let cy = 104;
  for (const ln of condLines) { drawTextCentered(fb, ln, cy, { scale: 1, color: fg }); cy += GLYPH_H + 3; }

  // --- hi / lo row -----------------------------------------------------------------------
  if (hi != null || lo != null) {
    const hiStr = hi == null ? '--' : String(Math.round(hi));
    const loStr = lo == null ? '--' : String(Math.round(lo));
    // measure both groups to space them evenly across the width
    const wHi = textWidth(`HI ${hiStr}`, 1, 1) + 6;
    const wLo = textWidth(`LO ${loStr}`, 1, 1) + 6;
    const gap = WIDTH - 8 - wHi - wLo;         // slack between the two groups
    const hiX = 4;
    const loX = hiX + wHi + Math.max(4, gap);
    drawTempLabeled(fb, hiX, 132, 'HI', hiStr, dim);
    drawTempLabeled(fb, loX, 132, 'LO', loStr, dim);
  }

  // --- accent bar (bottom) — condition color, the same seed a future LED sync would use ---
  fillRect(fb, 4, 152, WIDTH - 8, 4, accent);

  return fb;
}
