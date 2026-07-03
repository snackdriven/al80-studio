// Alert card app (preempts the base app). Renders a level bar + title + wrapped body, and a
// "press to dismiss" hint for sticky alerts. Portrait 96x160. Colors are muted for the small panel.
import { newFrame, fillRect, drawText, drawTextCentered, wrapText, WIDTH } from '../lib/render.js';

const LEVELS = {
  info: { bar: [60, 130, 220], fg: [150, 200, 255], label: 'INFO' },
  warn: { bar: [235, 175, 45], fg: [245, 215, 130], label: 'ATTENTION' },
  error: { bar: [225, 70, 60], fg: [255, 150, 140], label: 'ERROR' },
  ok: { bar: [70, 200, 120], fg: [150, 235, 190], label: 'OK' },
};

/**
 * @param {{title?,body?,level?,sticky?,source?,label?}} alert
 * @returns {{id,fps,render(now):Uint8Array}}
 */
export function makeAlertApp(alert) {
  const lv = LEVELS[alert.level] || LEVELS.info;
  const bg = [Math.round(lv.bar[0] * 0.1), Math.round(lv.bar[1] * 0.1), Math.round(lv.bar[2] * 0.1)];
  return {
    id: 'alert:' + (alert.source || 'anon'),
    fps: 2,
    render(now) {
      const fb = newFrame(bg);
      // level bar
      fillRect(fb, 0, 0, WIDTH, 16, lv.bar);
      drawTextCentered(fb, alert.label || lv.label, 5, { scale: 1, color: [12, 14, 20] });
      // title (bold-ish, wraps)
      const afterTitle = wrapText(fb, alert.title || 'Alert', 4, 26, { scale: 2, color: lv.fg, maxWidth: WIDTH - 8, lineH: 20 });
      // body
      if (alert.body) wrapText(fb, alert.body, 4, afterTitle + 6, { scale: 1, color: [190, 200, 215], maxWidth: WIDTH - 8, lineH: 11 });
      // dismiss hint for sticky
      if (alert.sticky) {
        fillRect(fb, 0, 148, WIDTH, 12, [Math.round(lv.bar[0] * 0.25), Math.round(lv.bar[1] * 0.25), Math.round(lv.bar[2] * 0.25)]);
        drawTextCentered(fb, 'PRESS TO DISMISS', 150, { scale: 1, color: [140, 150, 165] });
      }
      return fb;
    },
  };
}

/** Fill defaults on an incoming alert (from HTTP / ntfy). */
export function normalizeAlert(a = {}) {
  const level = ['info', 'warn', 'error', 'ok'].includes(a.level) ? a.level : 'info';
  return {
    source: String(a.source || 'anon'),
    level,
    title: String(a.title || 'Alert').slice(0, 60),
    body: a.body != null ? String(a.body).slice(0, 200) : '',
    label: a.label ? String(a.label).slice(0, 16) : undefined,
    sticky: a.sticky ?? (level === 'error' || level === 'warn'),
    ttl: Number(a.ttl) || undefined,
  };
}
