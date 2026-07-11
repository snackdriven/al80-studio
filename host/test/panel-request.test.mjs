// Device-free tests for the hotkey->panel HOST half (al80-hotkey-panel-switch-SPARC.md C2).
// Covers: (1) _onData 0x4B inbound dispatch incl. no-cross-talk with the ACK matcher, (2) the
// panelRequest -> cycler.jumpTo/togglePaused/step wiring against a MOCK cycler (the real cycler from
// al80-lcd-panel-auto-cycle-SPARC.md is a separate, unmerged feature — this builds to its jumpTo
// INTERFACE only), (3) debounce/coalesce. No hardware, no real cycler; MockDevice only.
import assert from 'node:assert/strict';
import { MockDevice } from '../device.js';
import { wirePanelRequests, PANEL_REQ_DEBOUNCE_MS } from '../panel-request.js';
import { PANEL_REQ, PANEL_ID } from '../../src/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- (1) inbound dispatch: 0x4B emits 'panelRequest'; 0x41 echo resolves an ACK and does NOT emit ----
{
  const dev = new MockDevice({ log: () => {} });
  await dev.open();

  const seen = [];
  dev.on('panelRequest', (id) => seen.push(id));

  // A pending ACK wait, as a real sendFrame data-block would set up.
  const ackPromise = dev._waitAck(new Uint8Array([0x41, 0x00, 0x00]), 200);

  // An inbound 0x4B report must emit panelRequest and must NOT resolve/consume the pending ACK.
  const panelReport = new Uint8Array(64);
  panelReport[0] = PANEL_REQ;
  panelReport[1] = PANEL_ID.NOWPLAYING;
  dev._onData(panelReport);

  assert.deepEqual(seen, [0x00], '0x4B report emits panelRequest with buf[1]');
  assert.equal(dev._pending !== null, true, '0x4B must not resolve/consume an in-flight ACK wait (no cross-talk)');

  // Now the matching 0x41 echo DOES resolve the ACK, and must NOT also emit panelRequest.
  const echo = new Uint8Array(64);
  echo[0] = 0x41; echo[1] = 0x00; echo[2] = 0x00;
  dev._onData(echo);
  const acked = await ackPromise;
  assert.equal(acked, true, 'the matching 0x41 echo resolves the pending ACK');
  assert.deepEqual(seen, [0x00], '0x41 echo does not also emit panelRequest (opcodes stay disjoint)');

  dev.close();
  console.log('panel-request: inbound dispatch ok (0x4B -> panelRequest, 0x41 ACK untouched, no cross-talk)');
}

// ---- mock cycler implementing the auto-cycle SPARC's jumpTo interface ----
function makeMockCycler() {
  return {
    calls: [],
    jumpTo(name, now) { this.calls.push(['jumpTo', name, now]); },
    togglePaused() { this.calls.push(['togglePaused']); },
    step(now) { this.calls.push(['step', now]); },
  };
}

function emitPanelRequest(dev, id) {
  const buf = new Uint8Array(64);
  buf[0] = PANEL_REQ;
  buf[1] = id;
  dev._onData(buf);
}

// ---- (2) jumpTo path: nowplaying/weather/clock ids route to cycler.jumpTo with the right panel name ----
{
  const dev = new MockDevice({ log: () => {} });
  await dev.open();
  const cyc = makeMockCycler();
  const unwire = wirePanelRequests(dev, cyc, { debounceMs: 10 });

  emitPanelRequest(dev, PANEL_ID.WEATHER);
  await sleep(20);

  assert.equal(cyc.calls.length, 1, 'one jumpTo call after the debounce window closes');
  assert.equal(cyc.calls[0][0], 'jumpTo');
  assert.equal(cyc.calls[0][1], 'weather', 'PANEL_ID.WEATHER maps to panel name "weather"');
  assert.equal(typeof cyc.calls[0][2], 'number', 'jumpTo receives a `now` timestamp');

  unwire();
  dev.close();
  console.log('panel-request: jumpTo dispatch ok (weather id -> cycler.jumpTo("weather", now))');
}

// ---- (3) toggle / next control ids route to togglePaused / step, not jumpTo ----
{
  const dev = new MockDevice({ log: () => {} });
  await dev.open();
  const cyc = makeMockCycler();
  const unwire = wirePanelRequests(dev, cyc, { debounceMs: 10 });

  emitPanelRequest(dev, PANEL_ID.CYCLE_TOGGLE);
  await sleep(20);
  assert.deepEqual(cyc.calls[0].slice(0, 1), ['togglePaused'], 'CYCLE_TOGGLE (0xF0) calls togglePaused, not jumpTo');

  emitPanelRequest(dev, PANEL_ID.PANEL_NEXT);
  await sleep(20);
  assert.equal(cyc.calls[1][0], 'step', 'PANEL_NEXT (0xF1) calls step, not jumpTo');

  unwire();
  dev.close();
  console.log('panel-request: toggle/next dispatch ok (0xF0 -> togglePaused, 0xF1 -> step)');
}

// ---- (4) debounce/coalesce: a burst of requests inside the window collapses to ONE call, on the LAST id ----
{
  const dev = new MockDevice({ log: () => {} });
  await dev.open();
  const cyc = makeMockCycler();
  const unwire = wirePanelRequests(dev, cyc, { debounceMs: 40 });

  // Simulate a held key / rapid double-tap: three requests land well inside one debounce window.
  emitPanelRequest(dev, PANEL_ID.NOWPLAYING);
  await sleep(5);
  emitPanelRequest(dev, PANEL_ID.WEATHER);
  await sleep(5);
  emitPanelRequest(dev, PANEL_ID.CLOCK);

  await sleep(60); // let the window close

  assert.equal(cyc.calls.length, 1, 'a burst inside the debounce window collapses to exactly one call');
  assert.equal(cyc.calls[0][1], 'clock', 'the coalesced call uses the LAST id in the burst, not the first');

  unwire();
  dev.close();
  console.log('panel-request: debounce/coalesce ok (3 rapid requests -> 1 call, last-id-wins)');
}

// ---- (5) unknown/unmapped id is dropped, never throws, never calls the cycler ----
{
  const dev = new MockDevice({ log: () => {} });
  await dev.open();
  const cyc = makeMockCycler();
  let dropped = null;
  const unwire = wirePanelRequests(dev, cyc, { debounceMs: 10, onDrop: (id) => { dropped = id; } });

  emitPanelRequest(dev, 0x77); // not a known PANEL_ID
  await sleep(20);

  assert.equal(cyc.calls.length, 0, 'an unknown id never reaches jumpTo/togglePaused/step');
  assert.equal(dropped, 0x77, 'onDrop is told which id was dropped');

  unwire();
  dev.close();
  console.log('panel-request: unknown id ok (dropped, no cycler call, no throw)');
}

// ---- (6) unwire() stops delivery (cycle-run teardown / reconnect safety) ----
{
  const dev = new MockDevice({ log: () => {} });
  await dev.open();
  const cyc = makeMockCycler();
  const unwire = wirePanelRequests(dev, cyc, { debounceMs: 10 });
  unwire();

  emitPanelRequest(dev, PANEL_ID.NOWPLAYING);
  await sleep(20);

  assert.equal(cyc.calls.length, 0, 'after unwire(), no further panelRequest reaches the cycler');
  dev.close();
  console.log('panel-request: unwire ok (stops delivery)');
}

// ---- (7) a throwing cycler is contained — a bad hotkey never crashes the always-on host ----
{
  const dev = new MockDevice({ log: () => {} });
  await dev.open();
  const boomCycler = {
    jumpTo() { throw new Error('cycler boom'); },
    togglePaused() { throw new Error('cycler boom'); },
    step() { throw new Error('cycler boom'); },
  };
  let errId = null;
  const unwire = wirePanelRequests(dev, boomCycler, { debounceMs: 10, onError: (id) => { errId = id; } });

  emitPanelRequest(dev, PANEL_ID.NOWPLAYING);
  await sleep(20); // fire() runs inside setTimeout — a throw here must be caught, not crash the process

  assert.equal(errId, PANEL_ID.NOWPLAYING, 'a throwing cycler is caught + reported via onError, not propagated');
  unwire();
  dev.close();
  console.log('panel-request: throwing cycler contained (no host crash)');
}

assert.equal(typeof PANEL_REQ_DEBOUNCE_MS, 'number', 'exports its default debounce constant');
console.log('host/panel-request.test.mjs: all assertions passed');
