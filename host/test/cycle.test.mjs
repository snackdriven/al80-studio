// Device-free validation of the panel-rotation FSM (auto-cycle SPARC C2). Drives makeCycler(...)
// .tick(now) with explicit timestamps + fake panels + a RecordingDevice. No hardware, no real
// timers — every dwell boundary is an exact `t` value.
import assert from 'node:assert/strict';
import { Scheduler } from '../lib/scheduler.js';
import { normalizeAlert } from '../apps/alert.js';
import { render as renderNowPlaying } from '../apps/nowplaying.js';
import { makeCycler } from '../cycle.js';
import { RecordingDevice } from './recording-device.js';
import { MockTransport } from '../transport-mock.js';
import { buildImageTransfer, FRAME_BYTES } from '../../src/protocol.js';

function fakePanel(id, page, opts = {}) {
  const { dwellMs = 1000, avail = () => true, stale = () => false, wantsFocus, rgb, render } = opts;
  return {
    id,
    page,
    dwellMs,
    async poll() {},
    available: avail,
    stale,
    wantsFocus,
    rgb,
    render: render || (() => { const fb = new Uint8Array(FRAME_BYTES); fb[0] = id.charCodeAt(0); return fb; }),
  };
}

// ---- 1) Transition sequences (picture<->picture, home<->picture) --------------------------
{
  const dev = new RecordingDevice();
  const np = fakePanel('nowplaying', 'picture', { dwellMs: 1000 });
  const wx = fakePanel('weather', 'picture', { dwellMs: 1000 });
  const clk = fakePanel('clock', 'home', { dwellMs: 1000 });
  const cyc = makeCycler({ dev, panels: [np, wx, clk], mode: 'roundrobin', npFocusOnChange: false });

  await cyc.tick(0); // first paint -> nowplaying, no delete (nothing of ours yet)
  assert.deepEqual(dev.ops, [{ op: 'sendCard', replacePrevious: false }], 'first paint: add only');
  assert.equal(cyc.committed, true);

  dev.ops.length = 0;
  await cyc.tick(1000); // dwell elapsed -> nowplaying -> weather (picture->picture)
  assert.deepEqual(dev.ops, ['deletePicture', { op: 'sendCard', replacePrevious: true }], 'picture->picture: delete-before-add');
  assert.equal(cyc.committed, true);

  dev.ops.length = 0;
  await cyc.tick(2000); // weather -> clock (picture->home)
  assert.deepEqual(dev.ops, ['deletePicture', 'sendClock', 'goHome'], 'picture->home: delete, sendClock, goHome');
  assert.equal(cyc.committed, false, 'home leaves nothing committed');

  dev.ops.length = 0;
  await cyc.tick(3000); // clock -> nowplaying (home->picture)
  assert.deepEqual(dev.ops, [{ op: 'sendCard', replacePrevious: false }], 'home->picture: add only (nothing committed to delete)');
  assert.equal(cyc.committed, true);

  console.log('ok — 1) transition sequences (picture<->picture, home<->picture)');
}

// ---- 2) Ring net-zero over a full cycle ----------------------------------------------------
{
  const dev = new RecordingDevice();
  const panels = ['nowplaying', 'weather', 'clock'].map((id) => fakePanel(id, id === 'clock' ? 'home' : 'picture', { dwellMs: 1000 }));
  const cyc = makeCycler({ dev, panels, mode: 'roundrobin', npFocusOnChange: false });
  for (let t = 0; t <= 3000; t += 1000) await cyc.tick(t); // one full lap back to nowplaying
  const expected = cyc.committed ? 1 : 0;
  assert.equal(dev.ringDelta(), expected, `ring net growth should be ${expected} (committed=${cyc.committed}), got ${dev.ringDelta()}`);
  console.log('ok — 2) ring net-zero over a full cycle');
}

// ---- 3) Skip logic: unavailable panels are never shown; falls back to the always-available clock
{
  const dev = new RecordingDevice();
  const np = fakePanel('nowplaying', 'picture', { dwellMs: 1000, avail: () => false });
  const wx = fakePanel('weather', 'picture', { dwellMs: 1000, avail: () => false });
  const clk = fakePanel('clock', 'home', { dwellMs: 1000 });
  const cyc = makeCycler({ dev, panels: [np, wx, clk], mode: 'smart', npFocusOnChange: false });

  await cyc.tick(0);
  assert.equal(cyc.current.id, 'clock', 'only clock available -> parks on clock');
  await cyc.tick(1000);
  assert.equal(cyc.current.id, 'clock', 'stays parked on clock (nothing else ever becomes available)');

  // now make weather available -> next tick should land there, never nowplaying
  wx.available = () => true;
  await cyc.tick(2000);
  assert.equal(cyc.current.id, 'weather', 'idx never lands on the still-unavailable nowplaying');
  console.log('ok — 3) skip logic (unavailable panels never shown; clock is the FR3 fallback)');
}

// ---- 4) Focus-on-change: wantsFocus() mid-dwell jumps to nowplaying + resets its dwell -----
{
  const dev = new RecordingDevice();
  let wants = false;
  const np = fakePanel('nowplaying', 'picture', { dwellMs: 5000, wantsFocus: () => { const w = wants; wants = false; return w; } });
  const wx = fakePanel('weather', 'picture', { dwellMs: 1000 });
  const cyc = makeCycler({ dev, panels: [wx, np], mode: 'smart', npFocusOnChange: true });

  await cyc.tick(0); // first paint lands on weather (idx 0, both available)
  assert.equal(cyc.current.id, 'weather');

  wants = true; // simulate a track change arriving mid-dwell
  await cyc.tick(500); // well before weather's dwell (1000) elapses
  assert.equal(cyc.current.id, 'nowplaying', 'focus-on-change jumps to nowplaying mid-dwell');
  assert.equal(cyc.dwellUntil, 500 + 5000, 'dwell resets to nowplaying\'s own dwellMs from the jump time');

  dev.ops.length = 0;
  await cyc.tick(600); // flag was consumed -> no re-trigger, still well within the fresh dwell
  assert.equal(cyc.current.id, 'nowplaying', 'flag consumed once — no thrash');
  assert.deepEqual(dev.ops, [], 'still dwelling — no device writes');
  console.log('ok — 4) focus-on-change (mid-dwell jump, dwell reset, consume-once)');
}

// ---- 5) Alert interleave: onAlert freezes the dwell; ack() redraws + restarts the dwell ----
{
  const dev = new RecordingDevice();
  const np = fakePanel('nowplaying', 'picture', { dwellMs: 1000 });
  const scheduler = new Scheduler(null);
  const cyc = makeCycler({ dev, panels: [np], mode: 'roundrobin', scheduler });

  await cyc.tick(0);
  assert.equal(cyc.current.id, 'nowplaying');

  scheduler.onAlert(normalizeAlert({ source: 'claude', level: 'warn', title: 'Claude needs you', sticky: true }), 100);
  dev.ops.length = 0;
  await cyc.tick(100); // alert preempts — a card is pushed, dwell frozen
  assert.equal(scheduler.alertCount, 1);
  assert.equal(dev.ops.length, 2, 'alert card pushed (delete-before-add, since a picture was already committed)');
  assert.equal(cyc.preempting, true);

  dev.ops.length = 0;
  await cyc.tick(200); // still active, same alert -> no re-push
  assert.deepEqual(dev.ops, [], 'no re-push while the same alert is still active');

  scheduler.ack();
  dev.ops.length = 0;
  await cyc.tick(300); // ack clears it -> resume: redraw current panel + restart its dwell
  assert.equal(cyc.preempting, false);
  assert.equal(cyc.current.id, 'nowplaying');
  assert.equal(cyc.dwellUntil, 300 + 1000, 'dwell restarts in full from the resume tick');
  console.log('ok — 5) alert interleave (preempt, hold, ack resumes with a fresh dwell)');
}

// ---- 6) Reopen recovery: a dropped write clears `committed`, reopens, repaints clean --------
{
  const dev = new RecordingDevice();
  const np = fakePanel('nowplaying', 'picture', { dwellMs: 1000 });
  const wx = fakePanel('weather', 'picture', { dwellMs: 1000 });
  const cyc = makeCycler({ dev, panels: [np, wx], mode: 'roundrobin', npFocusOnChange: false });

  await cyc.tick(0);
  assert.equal(cyc.committed, true);

  dev.failNextSend();
  await cyc.tick(1000); // dwell elapsed -> tries to advance to weather -> the send throws
  assert.equal(cyc.committed, false, 'drop clears committed — never assume our card is still on screen');
  assert.equal(dev.reopenCount, 1, 'tick recovered by reopening');
  assert.equal(dev.opened, true);

  dev.ops.length = 0;
  await cyc.tick(1500); // dwellUntil was forced to 0 -> next tick repaints fresh
  assert.deepEqual(dev.ops, [{ op: 'sendCard', replacePrevious: false }], 'repaint after reopen is add-only — NO blind deletePicture');
  console.log('ok — 6) reopen recovery (committed cleared, reopened, clean repaint, no blind delete)');
}

// ---- 7) Frame correctness: the pushed frame matches the panel's own render(), reassembles clean
{
  const dev = new RecordingDevice();
  const state = { title: 'Test Track', artist: 'Test Artist', progress: 0.4, paused: false, elapsedMs: 40000, durationMs: 100000 };
  const np = fakePanel('nowplaying', 'picture', { dwellMs: 1000, render: () => renderNowPlaying(state) });
  const cyc = makeCycler({ dev, panels: [np], mode: 'roundrobin' });

  await cyc.tick(0);
  const expected = renderNowPlaying(state);
  assert.ok(Buffer.compare(Buffer.from(dev.frame()), Buffer.from(expected)) === 0, 'reassembled frame equals apps/nowplaying.render(state)');

  const check = new MockTransport();
  check.send(buildImageTransfer(expected));
  assert.equal(check.stats.badChecksums, 0, 'checksums valid for the same frame through a fresh MockTransport');
  console.log('ok — 7) frame correctness (matches apps/nowplaying render, checksums valid)');
}

console.log('cycle.test.mjs: all 7 SPARC C2 assertions passed');
