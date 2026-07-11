// AL80 hotkey -> LCD panel — HOST half (al80-hotkey-panel-switch-SPARC.md, Phase 1 FR3/FR4/FR7).
//
// The keyboard's process_record_kb sends an unsolicited raw_hid_send report [0x4B, panelId, ...] on
// keypress (firmware half, not in this repo). device.js._onData decodes that opcode and re-emits it
// as this Device's 'panelRequest' event (see device.js, additive after the ACK-match block). This
// module is the consumer: it subscribes to that event and drives the auto-cycle SPARC's `cycler`.
//
// Drives the `cycler` from the auto-cycle feature (host/cycle.js makeCycler). That branch now
// implements all three methods this calls — jumpTo/togglePaused/step — so this is no longer built
// against a phantom interface; it just isn't wired yet. The integration commit adds, after both land:
//   import { wirePanelRequests } from './panel-request.js';
//   wirePanelRequests(dev, cyc);   // after dev.open(), once
//
// cycler interface (host/cycle.js) — the `now` arg passed below is ignored by jumpTo/step, kept for API symmetry:
//   jumpTo(panelName)   -> jump to the named panel on the next tick, repaint, reset dwell (does NOT pause)
//   togglePaused()      -> freeze/resume auto-rotation (CYCLE_TOGGLE)
//   step()              -> advance one panel on the next tick (PANEL_NEXT)
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
    try {
      if (id === PANEL_ID.CYCLE_TOGGLE) { cycler.togglePaused(); return; }
      if (id === PANEL_ID.PANEL_NEXT) { cycler.step(t); return; }
      const name = PANEL_NAME_BY_ID[id];
      if (name === undefined) { opts.onDrop?.(id); return; } // unknown id — ignore, never throw on a bad byte
      cycler.jumpTo(name, t);
    } catch (e) {
      // This runs in a bare setTimeout — an uncaught throw here would crash the always-on host.
      // A misbehaving/mismatched cycler must degrade to a dropped hotkey, never take the process down.
      console.error('[panel-request] cycler action failed for id', id, '—', e?.message ?? e);
      opts.onError?.(id, e);
    }
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
