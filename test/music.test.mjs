// Music-reactive lighting tests — pure, device-free (no board, no mic, no HID open).
// Covers: the new save-less brightness builder is the BARE noeeprom set (not the EEPROM wrapper);
// the audio→HSV mapper on canned FFT fixtures (floor, band→hue, cap, slew, onset, hue wrap);
// pickSaveLessCommand per firmware; detectFirmware branch selection. Run: node --test test/music.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLightBrightnessLive, buildLightBrightness, buildLightColorLive, buildVialRGBColorLive,
} from '../src/protocol.js';
import {
  mapAudioToHSV, newMapState, pickSaveLessCommand, detectFirmware,
  MUSIC_MODE, DEFAULT_CAP, MAX_VAL_DELTA,
} from '../src/music.js';

// ---- fixtures ---------------------------------------------------------------
const BINS = 256;   // frequencyBinCount for fftSize 512
const WAVE = 512;
const silenceFreq = () => new Uint8Array(BINS);            // all 0
const silenceWave = () => new Uint8Array(WAVE).fill(128);  // 128 = no displacement
function bandFreq(lo, hi, v = 255) { const f = new Uint8Array(BINS); for (let i = lo; i <= hi; i++) f[i] = v; return f; }
function loudWave() { const w = new Uint8Array(WAVE); for (let i = 0; i < WAVE; i++) w[i] = i % 2 ? 255 : 0; return w; } // rms ~1
function flatFreq(v) { return new Uint8Array(BINS).fill(v); }
function settle(fn, frames) { let r; for (let i = 0; i < frames; i++) r = fn(); return r; } // run N frames, return last

// ---- the crux: save-less brightness builder --------------------------------
test('buildLightBrightnessLive is the BARE noeeprom set — single 07 03 01 <val>, no 0x09 save', () => {
  const r = buildLightBrightnessLive(200);
  assert.ok(r instanceof Uint8Array, 'returns ONE report, not an array');
  assert.equal(r.length, 64);
  assert.deepEqual([r[0], r[1], r[2], r[3]], [0x07, 0x03, 0x01, 200]); // set-value id 1 (brightness)
  assert.ok(![...r].includes(0x09), 'no id_custom_save byte anywhere');
});

test('buildLightBrightnessLive is NOT the EEPROM-writing wrapper', () => {
  const wrapper = buildLightBrightness(200);           // [set, save] pair
  assert.ok(Array.isArray(wrapper) && wrapper.length === 2, 'wrapper is a set+save pair');
  assert.equal(wrapper[1][0], 0x09, 'wrapper appends an id_custom_save (EEPROM write)');
  // The live builder must be a lone report, provably without that save.
  assert.ok(!Array.isArray(buildLightBrightnessLive(200)));
});

test('buildLightBrightnessLive clamps to a byte', () => {
  assert.equal(buildLightBrightnessLive(999)[3], 255);
  assert.equal(buildLightBrightnessLive(-5)[3], 0);
});

// ---- mapAudioToHSV ----------------------------------------------------------
test('silence → dim floor, sat pinned 255', () => {
  const state = newMapState();
  const hsv = settle(() => mapAudioToHSV(silenceFreq(), silenceWave(), MUSIC_MODE.BREATHE, { cap: DEFAULT_CAP, state }), 10);
  assert.equal(hsv.sat, 255);
  const floor = Math.round(0.15 * DEFAULT_CAP * 255); // ~38
  assert.ok(Math.abs(hsv.val - floor) <= 3, `expected val≈${floor}, got ${hsv.val}`);
  assert.ok(hsv.val > 0, 'floor is a gentle glow, not off');
});

test('bass spike → hue ≈ 0 (red)', () => {
  const state = newMapState();
  const hsv = settle(() => mapAudioToHSV(bandFreq(1, 8), loudWave(), MUSIC_MODE.BREATHE, { cap: 1, state }), 20);
  assert.ok(hsv.hue <= 4, `expected hue≈0, got ${hsv.hue}`);
});

test('treble spike → hue ≈ 170 (blue)', () => {
  const state = newMapState();
  const hsv = settle(() => mapAudioToHSV(bandFreq(41, 120), loudWave(), MUSIC_MODE.BREATHE, { cap: 1, state }), 40);
  assert.ok(Math.abs(hsv.hue - 170) <= 6, `expected hue≈170, got ${hsv.hue}`);
});

test('brightness cap respected — cap 0.6 never exceeds val 153', () => {
  const state = newMapState();
  for (let i = 0; i < 60; i++) {
    const hsv = mapAudioToHSV(flatFreq(255), loudWave(), MUSIC_MODE.PULSE, { cap: 0.6, state });
    assert.ok(hsv.val <= Math.round(0.6 * 255), `val ${hsv.val} exceeded cap`);
  }
});

test('moderate audio reaches usable keyboard brightness instead of staying dim', () => {
  const state = newMapState();
  const w = new Uint8Array(WAVE);
  for (let i = 0; i < WAVE; i++) w[i] = i % 2 ? 168 : 88; // RMS ~= 0.31 before threshold
  const hsv = settle(() => mapAudioToHSV(flatFreq(180), w, MUSIC_MODE.BREATHE, { cap: 1, threshold: 0.06, state }), 8);
  assert.ok(hsv.val >= 128, `expected moderate audio to reach at least half brightness, got ${hsv.val}`);
});

test('reactivity threshold treats quiet signal as silence and holds hue', () => {
  const state = newMapState();
  state.prevHue = 85;
  const quietWave = new Uint8Array(WAVE);
  for (let i = 0; i < WAVE; i++) quietWave[i] = i % 2 ? 132 : 124; // tiny RMS, below 8%
  const hsv = settle(() => mapAudioToHSV(bandFreq(41, 120), quietWave, MUSIC_MODE.BREATHE, { cap: 1, threshold: 0.08, state }), 5);
  assert.equal(hsv.hue, 85, 'below threshold should not chase the treble hue');
  const floor = Math.round(0.15 * 255);
  assert.ok(Math.abs(hsv.val - floor) <= 3, `expected floor≈${floor}, got ${hsv.val}`);
});

test('reactivity threshold lets signal above the threshold through', () => {
  const state = newMapState();
  const quiet = mapAudioToHSV(flatFreq(255), loudWave(), MUSIC_MODE.BREATHE, { cap: 1, threshold: 0.95, state });
  const active = settle(() => mapAudioToHSV(flatFreq(255), loudWave(), MUSIC_MODE.BREATHE, { cap: 1, threshold: 0.05, state }), 8);
  assert.ok(active.val > quiet.val, `active val ${active.val} should exceed gated val ${quiet.val}`);
});

test('picked color mode keeps the selected color while audio drives brightness', () => {
  const state = newMapState();
  const quiet = mapAudioToHSV(bandFreq(1, 8), silenceWave(), MUSIC_MODE.PICKED, { cap: 1, threshold: 0, state, accentHue: 170, accentSat: 120 });
  const active = settle(() => mapAudioToHSV(bandFreq(1, 8), loudWave(), MUSIC_MODE.PICKED, { cap: 1, threshold: 0, state, accentHue: 170, accentSat: 120 }), 8);
  assert.equal(active.hue, 170);
  assert.equal(active.sat, 120);
  assert.ok(active.val > quiet.val, `active val ${active.val} should exceed quiet ${quiet.val}`);
});

test('slew limits value — a 0→loud step rises at most MAX_VAL_DELTA in one frame', () => {
  const state = newMapState(); // prevVal 0
  const hsv = mapAudioToHSV(flatFreq(255), loudWave(), MUSIC_MODE.BREATHE, { cap: 1, state });
  assert.ok(hsv.val <= Math.round(MAX_VAL_DELTA * 255) + 1, `first-frame val ${hsv.val} jumped past the slew cap`);
});

test('hue slew takes the short way round the wheel (250 → 0, not the long way)', () => {
  const state = newMapState();
  state.prevHue = 250;
  // bass spike → hueTarget 0; from 250 the short path is +6 (up through wrap), not -250.
  const hsv = mapAudioToHSV(bandFreq(1, 8), loudWave(), MUSIC_MODE.BREATHE, { cap: 1, state });
  assert.equal(hsv.hue, 0, `wrapped short path should land on 0, got ${hsv.hue}`);
});

test('PULSE onset bumps brightness above the quiet baseline', () => {
  const state = newMapState();
  // settle on a quiet steady frame (flux → 0, fluxAvg → 0)
  let quiet;
  for (let i = 0; i < 8; i++) quiet = mapAudioToHSV(flatFreq(20), silenceWave(), MUSIC_MODE.PULSE, { cap: 1, state });
  // a sudden loud, spectrally-rich frame → large flux vs the low average → onset
  const onset = mapAudioToHSV(flatFreq(230), loudWave(), MUSIC_MODE.PULSE, { cap: 1, state });
  assert.ok(onset.val > quiet.val, `onset val ${onset.val} should exceed quiet ${quiet.val}`);
});

// ---- pickSaveLessCommand ----------------------------------------------------
test('pickSaveLessCommand custom → one VialRGB report (07 41 …), no save', () => {
  const reports = pickSaveLessCommand('custom', { hue: 100, sat: 255, val: 120 });
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0][0], reports[0][1]], [0x07, 0x41]);
  assert.deepEqual(Array.from(reports[0]), Array.from(buildVialRGBColorLive(100, 255, 120)));
  assert.ok(reports.every((r) => r[0] !== 0x09), 'no id_custom_save');
});

test('pickSaveLessCommand stock → two reports (07 03 04 h s) + (07 03 01 v), no save', () => {
  const reports = pickSaveLessCommand('stock', { hue: 100, sat: 200, val: 120 });
  assert.equal(reports.length, 2);
  assert.deepEqual([reports[0][0], reports[0][1], reports[0][2], reports[0][3], reports[0][4]], [0x07, 0x03, 0x04, 100, 200]);
  assert.deepEqual([reports[1][0], reports[1][1], reports[1][2], reports[1][3]], [0x07, 0x03, 0x01, 120]);
  assert.deepEqual(Array.from(reports[0]), Array.from(buildLightColorLive(100, 200)));
  assert.deepEqual(Array.from(reports[1]), Array.from(buildLightBrightnessLive(120)));
  assert.ok(reports.every((r) => r[0] !== 0x09), 'no id_custom_save in either report');
});

// ---- detectFirmware ---------------------------------------------------------
test('detectFirmware → custom when the 0x46 probe replies', async () => {
  const transact = async (report, match) => {
    assert.equal(report[0], 0x46, 'probes with the side-bar GET opcode');
    const reply = new Uint8Array([0x46, 10, 255, 128, 1]);
    return match(reply) ? reply : null;
  };
  assert.equal(await detectFirmware(transact), 'custom');
});

test('detectFirmware → stock when the probe gets no reply (null)', async () => {
  assert.equal(await detectFirmware(async () => null), 'stock');
});

test('detectFirmware → stock when the probe times out / throws', async () => {
  assert.equal(await detectFirmware(async () => { throw new Error('VIA read timed out'); }), 'stock');
});
