// cycle.js — the panel-rotation FSM (auto-cycle SPARC P/A/A6). Pure(ish) core: `tick(now)` is a
// step function; all device I/O lives inside it and its callees (showPanel/pushCard), so tests can
// drive it deterministically with explicit timestamps + a RecordingDevice (no hardware, no timers).
//
// Invariant (A6): `committed` = "our card is the displayed picture slot." Every transition either
// deletes-before-adding (picture->picture, home->picture keeps false->true, picture->home clears it)
// or is reset by a reconnect (committed=false, dwellUntil=0 — never a blind deletePicture).
//
// [CORRECTION vs the SPARC pseudocode's split] the SPARC's "driver (real timers)" owns the
// try/catch-then-reopen recovery outside tick(). Here tick() absorbs that recovery internally —
// the SPARC's own §C2 test plan drives `cycler.tick(now)` directly and expects the reopen to have
// already happened by the time the await resolves, which only works if tick() owns the catch. See
// al80-buildout-discoveries.md.
export function makeCycler({
  dev,
  panels,
  mode = 'smart',           // 'smart' | 'roundrobin' (FR9 — roundrobin ignores available()/stale()/focus)
  npFocusOnChange = true,   // FR5 gate
  syncRGB = false,          // Phase-3 optional; off by default
  scheduler = null,         // Scheduler|null — alert preemption (A5); null disables alerts entirely
  now = () => Date.now(),
} = {}) {
  if (!Array.isArray(panels) || panels.length === 0) throw new Error('cycle: at least one panel required');

  let idx = 0;
  let committed = false;
  let dwellUntil = 0;
  let preempting = false;
  let lastAlertShown = null;
  let pendingJump = null; // panelId requested via jumpTo(), consumed on the next tick
  let pendingStep = false; // step()/PANEL_NEXT — advance one panel on the next tick
  let paused = false;      // togglePaused()/CYCLE_TOGGLE — freezes auto-rotation (dwell + focus); alerts/jump/step still act

  /** FR3/FR9: smart rules gate availability; roundrobin ignores them (pure fixed rotation). */
  const available = (p) => (p.available() && !(p.stale?.())) || mode === 'roundrobin';

  function nextAvailableIndex(from, includeCurrent = false) {
    for (let n = includeCurrent ? 0 : 1; n <= panels.length; n++) {
      const i = (from + n) % panels.length;
      if (available(panels[i])) return i;
    }
    return from; // nothing else available -> hold where we are
  }

  // ---- the ONLY code touching `dev` --------------------------------------------------------
  async function pushCard(frame) {
    await dev.sendCard(frame, { replacePrevious: committed });
    committed = true;
  }

  async function showPanel(p) {
    if (p.page === 'home') {
      if (committed) { await dev.deletePicture(); committed = false; }
      await dev.sendClock();
      await dev.goHome();
    } else {
      let frame;
      try { frame = p.render(); }
      catch (e) { console.error(`[cycle] panel "${p.id}" render() threw — holding this tick:`, e?.message ?? e); return; }
      await pushCard(frame);
      // always-on host: a throwing rgb() must be contained like render() — skip the tint, keep dwelling, never crash
      if (syncRGB) {
        try { const tint = p.rgb?.(); if (tint) await dev.setRGB(tint); }
        catch (e) { console.error(`[cycle] panel "${p.id}" rgb() threw — skipping tint:`, e?.message ?? e); }
      }
    }
  }

  /** Public: request an immediate jump to `panelId` (the hotkey feature builds against this). Takes
   * effect on the NEXT tick, ahead of focus-on-change and normal dwell advance, but never ahead of
   * an active alert (alerts always win — A5/FR6). No-op if the panel doesn't exist or isn't available. */
  function jumpTo(panelId) { pendingJump = panelId; }

  /** Public (hotkey PANEL_NEXT): advance one panel on the next tick. Fires whether paused or not. */
  function step() { pendingStep = true; }

  /** Public (hotkey CYCLE_TOGGLE): freeze/resume auto-rotation. Alerts + explicit jump/step still act.
   * Returns the new paused state. */
  function togglePaused() { paused = !paused; return paused; }

  async function tick(t) {
    try {
      if (scheduler) scheduler.update(t); // expire transient alerts
      const alert = scheduler && scheduler.alertCount > 0 ? scheduler.active() : null; // [CORRECTION] A5 — alertCount, not active() truthiness
      if (alert) {
        if (!preempting || alert !== lastAlertShown) {
          await pushCard(alert.render(new Date(t)));
          preempting = true;
          lastAlertShown = alert;
        }
        return; // hold; dwell frozen
      }
      if (preempting) { // alert cleared -> resume, full fresh dwell (the user lost screen time to it)
        preempting = false;
        lastAlertShown = null;
        await showPanel(panels[idx]);
        dwellUntil = t + panels[idx].dwellMs;
        return;
      }
      if (pendingJump != null) {
        const wantId = pendingJump;
        pendingJump = null;
        const i = panels.findIndex((p) => p.id === wantId);
        if (i >= 0 && available(panels[i])) {
          idx = i;
          await showPanel(panels[idx]);
          dwellUntil = t + panels[idx].dwellMs;
          return;
        }
        // unknown/unavailable panel -> ignored, fall through to normal dwell logic this tick
      }
      if (pendingStep) { // explicit PANEL_NEXT — advance now, regardless of paused/dwell
        pendingStep = false;
        idx = nextAvailableIndex(idx);
        await showPanel(panels[idx]);
        dwellUntil = t + panels[idx].dwellMs;
        return;
      }
      if (mode === 'smart' && npFocusOnChange && !paused) {
        const npi = panels.findIndex((p) => p.id === 'nowplaying');
        // consume-once regardless of whether we act, so a stale flag can't fire later (R5)
        const wants = npi >= 0 ? !!panels[npi].wantsFocus?.() : false;
        if (wants && npi !== idx && available(panels[npi])) {
          idx = npi;
          await showPanel(panels[idx]);
          dwellUntil = t + panels[idx].dwellMs;
          return;
        }
      }
      const p = panels[idx];
      if (dwellUntil === 0) { // first tick
        idx = nextAvailableIndex(idx, true);
        await showPanel(panels[idx]);
        dwellUntil = t + panels[idx].dwellMs;
        return;
      }
      if (!available(p)) { // current panel died mid-dwell
        idx = nextAvailableIndex(idx);
        await showPanel(panels[idx]);
        dwellUntil = t + panels[idx].dwellMs;
        return;
      }
      if (t >= dwellUntil && !paused) { // dwell elapsed -> advance (frozen while paused)
        idx = nextAvailableIndex(idx);
        await showPanel(panels[idx]);
        dwellUntil = t + panels[idx].dwellMs;
        return;
      }
      // else: still dwelling, nothing to do this tick
    } catch (e) {
      if (dev.opened === false) {
        committed = false; // our card's slot ownership is unknown after a drop — never delete blind
        try { await dev.reopen(); } catch { /* driver will retry on a later tick */ }
        dwellUntil = 0; // force a fresh repaint (replacePrevious:false) next tick
      } else {
        throw e; // not a device drop — an unexpected bug; let it surface
      }
    }
  }

  return {
    tick,
    jumpTo,
    step,
    togglePaused,
    get idx() { return idx; },
    get current() { return panels[idx]; },
    get committed() { return committed; },
    get preempting() { return preempting; },
    get paused() { return paused; },
    get dwellUntil() { return dwellUntil; },
  };
}
