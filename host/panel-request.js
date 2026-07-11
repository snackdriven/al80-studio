// AL80 hotkey -> LCD panel — HOST half (al80-hotkey-panel-switch-SPARC.md, Phase 1 FR3/FR4/FR7).
//
// The keyboard's process_record_kb sends an unsolicited raw_hid_send report [0x4B, panelId, ...] on
// keypress (firmware half, not in this repo). device.js._onData decodes that opcode and re-emits it
// as this Device's 'panelRequest' event (see device.js, additive after the ACK-match block). This
// module is the consumer: it subscribes to that event and drives the auto-cycle SPARC's `cycler`.
//
// Built against the `cycler` INTERFACE the auto-cycle SPARC specifies (jumpTo/togglePaused/step), not
// the real implementation — al80-lcd-panel-auto-cycle-SPARC.md's cycle.js/cycle-run.mjs are a separate
// unmerged feature. cycle-run.mjs wires this in once it exists:
//   import { wirePanelRequests } from './panel-request.js';
//   wirePanelRequests(dev, cyc);   // after dev.open(), once
//
// cycler interface (auto-cycle SPARC A/P sections):
//   jumpTo(panelName, now)   -> set idx to the named panel, repaint, reset dwell, pause the cycle
//   togglePaused()           -> flip the rotation's paused flag (CYCLE_TOGGLE)
//   step(now)                -> advance one panel (PANEL_NEXT)
import { PANEL_ID, PANEL_NAME_BY_ID } from '../src/protocol.js';

/** Debounce/coalesce window (SPARC R3, FR7): collapses a held key / double-tap bounce to the LAST id. */
export const PANEL_REQ_DEBOUNCE_MS = 250;

/**
 * Subscribe `dev`'s 'panelRequest' event and drive `cycler`. Returns an unsubscribe function.
 *
 * Debounce is trailing-edge coalescing, not simple drop-first: every request received inside the
 * window replaces the pending one, and a single timer fires the LATEST id once the window closes with
 * no further requests — so a held key or a rapid double-tap resolves to one action on the id you
 * settled on, not the first one your finger grazed. (FR7: "a held key must not spam switches"; the
 * firmware already only fires on the press edge, so this is the belt-and-suspenders host side.)
 *
 * @param {import('node:events').EventEmitter} dev   a Device (or anything emitting 'panelRequest')
 * @param {{jumpTo:Function, togglePaused:Function, step:Function}} cycler
 * @param {object} [opts]
 * @param {number} [opts.debounceMs=PANEL_REQ_DEBOUNCE_MS]
 * @param {() => number} [opts.now=Date.now]
 * @param {(...a:any[])=>void} [opts.onDrop] optional callback fired for an id with no known panel (no-op, logged)
 */
export function wirePanelRequests(dev, cycler, opts = {}) {
  const debounceMs = opts.debounceMs ?? PANEL_REQ_DEBOUNCE_MS;
  const now = opts.now ?? Date.now;
  let timer = null;
  let pendingId = null;

  const fire = (id) => {
    timer = null;
    const t = now();
    if (id === PANEL_ID.CYCLE_TOGGLE) { cycler.togglePaused(); return; }
    if (id === PANEL_ID.PANEL_NEXT) { cycler.step(t); return; }
    const name = PANEL_NAME_BY_ID[id];
    if (name === undefined) { opts.onDrop?.(id); return; } // unknown id — ignore, never throw on a bad byte
    cycler.jumpTo(name, t);
  };

  const onPanelRequest = (id) => {
    pendingId = id;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fire(pendingId), debounceMs);
  };

  dev.on('panelRequest', onPanelRequest);
  return () => {
    dev.off('panelRequest', onPanelRequest);
    if (timer) { clearTimeout(timer); timer = null; }
  };
}
