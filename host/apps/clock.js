// Clock app — renders a 96x160 logical framebuffer from a Date. Portrait layout:
//   date line · big stacked HH over MM · seconds number + progress bar.
// Only the seconds (and the bar) change most ticks, so the region diff stays tiny.
import { newFrame, drawTextCentered, fillRect, WIDTH } from '../lib/render.js';

const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MO = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * @param {Date} date
 * @param {{is12hr?:boolean, bg?, fg?, dim?, accent?}} opts
 * @returns {Uint8Array} 96x160 RGB565-BE frame
 */
export function renderClock(date, opts = {}) {
  const { is12hr = true, bg = [8, 10, 18], fg = [130, 200, 255], dim = [110, 122, 145], accent = [80, 220, 160] } = opts;
  const fb = newFrame(bg);

  let h = date.getHours();
  const m = date.getMinutes(), s = date.getSeconds();
  if (is12hr) h = h % 12 || 12;

  // date line, e.g. "MON JUL 02"
  drawTextCentered(fb, `${WD[date.getDay()]} ${MO[date.getMonth()]} ${pad2(date.getDate())}`, 6, { scale: 1, color: dim });

  // big stacked hours / minutes (scale 7 -> ~77px wide, 49px tall each)
  drawTextCentered(fb, pad2(h), 22, { scale: 7, color: fg });
  drawTextCentered(fb, pad2(m), 82, { scale: 7, color: fg });

  // seconds number
  drawTextCentered(fb, pad2(s), 140, { scale: 2, color: accent });

  // seconds progress bar (fills over a minute)
  fillRect(fb, 4, 156, WIDTH - 8, 2, [28, 32, 44]);
  fillRect(fb, 4, 156, Math.round((s / 60) * (WIDTH - 8)), 2, accent);

  return fb;
}

export const clockApp = { id: 'clock', fps: 1, render: (now) => renderClock(now) };
