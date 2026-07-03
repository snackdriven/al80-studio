// Device-free validation of the foundation: the scheduler's preemption logic (sticky vs transient,
// dedup, ack) and that every app's frame reassembles through the mock. Also drops PNGs to out/.
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { Scheduler } from '../lib/scheduler.js';
import { clockApp } from '../apps/clock.js';
import { makeAlertApp, normalizeAlert } from '../apps/alert.js';
import { MockTransport } from '../transport-mock.js';
import { buildImageTransfer } from '../../src/protocol.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
mkdirSync(OUT, { recursive: true });

// ---- preemption logic ----
const s = new Scheduler(clockApp);
assert.equal(s.active().id, 'clock', 'base app shows when idle');

// sticky "Claude needs you" preempts
s.onAlert(normalizeAlert({ source: 'claude:abc', level: 'warn', title: 'Claude needs you', body: 'al80-studio · permission: Bash', sticky: true }), 0);
assert.equal(s.active().id, 'alert:claude:abc', 'alert preempts base');
assert.equal(s.update(9999), false, 'sticky does not expire');
assert.equal(s.active().id, 'alert:claude:abc');

// transient stacks on top, then expires back to the sticky
s.onAlert(normalizeAlert({ source: 'ntfy:info', level: 'info', title: 'Deploy done', ttl: 3000 }), 1000);
assert.equal(s.active().id, 'alert:ntfy:info', 'newest alert shows on top');
assert.equal(s.update(5000), true, 'transient expired');
assert.equal(s.active().id, 'alert:claude:abc', 'sticky remains after transient clears');

// dedup by source
s.onAlert(normalizeAlert({ source: 'claude:abc', level: 'warn', title: 'Claude needs you', body: 'updated', sticky: true }), 5000);
assert.equal(s.alertCount, 1, 'same source replaces, does not stack');

// ack clears the sticky -> back to base
s.onKey('ack');
assert.equal(s.active().id, 'clock', 'ack restores the base app');

// ---- render each card through the mock (validates frames reassemble) ----
const now0 = new Date(2026, 6, 2, 14, 9, 42);
function shot(app, file) {
  const m = new MockTransport();
  m.send(buildImageTransfer(app.render(now0)));
  assert.equal(m.stats.badChecksums, 0, `${file}: checksums valid`);
  m.savePNG(join(OUT, file));
}
shot(clockApp, 'fnd-clock.png');
shot(makeAlertApp(normalizeAlert({ source: 'claude', level: 'warn', title: 'Claude needs you', body: 'al80-studio · permission to run Bash', sticky: true })), 'fnd-alert-claude.png');
shot(makeAlertApp(normalizeAlert({ source: 'kuma', level: 'error', title: 'SITE DOWN', body: 'snackdriven.com not responding', label: 'UPTIME' })), 'fnd-alert-error.png');
shot(makeAlertApp(normalizeAlert({ source: 'spotify', level: 'ok', title: 'Deploy complete', sticky: false })), 'fnd-alert-ok.png');

console.log('foundation tests passed (preemption: sticky/transient/dedup/ack; 4 cards reassembled). PNGs in out/');
