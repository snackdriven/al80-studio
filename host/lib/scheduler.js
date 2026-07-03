// Scheduler: one base app (clock / now-playing) runs; alerts PREEMPT it. Sticky alerts (errors,
// "Claude needs you") stay until acked; transient alerts auto-expire. Time is passed in via
// update(now) rather than setTimeout, so preemption is deterministic and testable against the mock.
//
// App model: { id, fps, render(now: Date) -> Uint8Array(30720), onKnob?(dir), onKey?(key) }.
import { makeAlertApp } from '../apps/alert.js';

export class Scheduler {
  /** @param {object} baseApp the default app shown when no alert is active */
  constructor(baseApp) {
    this.base = baseApp;
    this.stack = []; // [{ app, source, sticky, expiresAt }] — top of stack is shown
  }

  setBase(app) { this.base = app; }

  /** The app currently shown (top alert, else base). */
  active() { return this.stack.length ? this.stack[this.stack.length - 1].app : this.base; }

  /** Raise an alert. Dedups by source (a source shows one live card). now = ms. */
  onAlert(alert, now) {
    const ttl = alert.ttl ?? 6000;
    const entry = {
      app: makeAlertApp(alert),
      source: alert.source || 'anon',
      sticky: !!alert.sticky,
      expiresAt: alert.sticky ? Infinity : now + ttl,
    };
    this.stack = this.stack.filter((e) => e.source !== entry.source); // replace same-source
    this.stack.push(entry);
    return entry.app;
  }

  /** Expire transient alerts whose time has passed. Call each tick. */
  update(now) {
    const before = this.stack.length;
    this.stack = this.stack.filter((e) => e.expiresAt > now);
    return this.stack.length !== before; // true if something was dismissed (forces a redraw)
  }

  /** Dismiss the top alert (a sticky ack). No-op if only the base app is showing. */
  ack() { return this.stack.pop() ? true : false; }

  /** Route input to the active app; a bare ack key/press also dismisses the top alert. */
  onKnob(dir) { this.active().onKnob?.(dir); }
  onKey(key) {
    this.active().onKey?.(key);
    if (key === 'ack' && this.stack.length) this.ack();
  }

  get alertCount() { return this.stack.length; }
}
