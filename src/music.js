// AL80 Studio — music-reactive lighting core. Pure, DOM-free, HID-free, node-unit-testable.
// The browser side (src/ui.js) owns the audio *capture* (getDisplayMedia/getUserMedia + AnalyserNode)
// behind a user gesture; this module owns the deterministic math and the firmware-aware command pick.
// Splitting it this way keeps the reactive mapping fully testable without a board or a mic.
//
// Grounded in research/al80-music-reactive-lighting-SPARC.md (P.2/P.3/P.4). The whole feature is
// "existing FX loop + audio color source + which-save-less-command" — no firmware change. Every
// per-frame report is save-less (never buildLightBrightness/buildLightColor which append a 0x09 save).

import {
  buildVialRGBColorLive, buildLightColorLive, buildLightBrightnessLive, buildBarGet,
} from './protocol.js';

export const MUSIC_MODE = Object.freeze({ BREATHE: 'breathe', PULSE: 'pulse', FOLLOW_HUE: 'follow', PICKED: 'picked' });

// Safety constants (R.3/R.4). The firmware imposes NO brightness ceiling, so the host is the only
// clamp: DEFAULT_CAP scales every frame, and the slew limits keep a bass drop from strobing.
export const DEFAULT_CAP = 1.0;             // default to the keyboard's full 0-255 brightness scale
export const DEFAULT_THRESHOLD = 0.06;       // ignore low-level noise; higher = less sensitive
export const DEFAULT_GAIN = 1.25;            // lift ordinary playback toward the selected ceiling
export const DEFAULT_DECAY = 0.086;          // brightness fall per frame at the default Decay control value
export const MAX_VAL_DELTA = 0.12;          // max value change per frame (0..1) — anti-strobe
export const MAX_HUE_DELTA = 24;            // max hue change per frame on the 0..255 wheel
export const FLOOR = 0.15;                  // dim floor so silence still shows a gentle glow
export const ACTIVE_FLOOR = 0.5;            // keep audible music bright between peaks

// Hue anchors on the 0..255 VIA wheel: bass=red(0), mid=green(85), treble=blue(170).
const HUE_BASS = 0, HUE_MID = 85, HUE_TREB = 170;

/** Fresh per-run state for the mapper. Kept outside the pure fn so it can accumulate across frames. */
export function newMapState() {
  return { prevVal: 0, prevHue: 0, prevFreq: null, fluxAvg: 0, levelPeak: 0 };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

function meanRange(arr, lo, hi) {
  let sum = 0, n = 0;
  const end = Math.min(hi, arr.length - 1);
  for (let i = lo; i <= end; i++) { sum += arr[i]; n++; }
  return n ? sum / n : 0;
}

/** Slew-limit a value in the 0..1 domain so it can't jump more than maxDelta per frame. */
function slewLimit(prev, target, riseDelta, fallDelta = riseDelta) {
  const d = target - prev;
  if (d > riseDelta) return prev + riseDelta;
  if (d < -fallDelta) return prev - fallDelta;
  return target;
}

/** Slew-limit a hue on the 0..255 wheel, taking the short way round and capping the rotation. */
function slewLimitWrap(prev, target, maxDelta) {
  let d = target - prev;
  if (d > 128) d -= 256; else if (d < -128) d += 256; // shortest path
  if (d > maxDelta) d = maxDelta; else if (d < -maxDelta) d = -maxDelta;
  return ((prev + d) % 256 + 256) % 256;
}

/** Index of the loudest FFT bin above the DC bin → its hue on the wheel (FOLLOW_HUE). */
function dominantBinHue(freq) {
  let best = 1, bestV = -1;
  for (let i = 1; i < freq.length; i++) if (freq[i] > bestV) { bestV = freq[i]; best = i; }
  // Map bin position across the usable spectrum onto the 0..255 hue wheel.
  const span = Math.max(1, freq.length - 1);
  return Math.round((best / span) * 255) % 256;
}

/**
 * Reduce one analyser frame to ONE global HSV. Pure — deterministic for a given (freq, wave, mode, state).
 * @param {Uint8Array|number[]} freq  getByteFrequencyData output (0..255 per bin)
 * @param {Uint8Array|number[]} wave  getByteTimeDomainData output (0..255, 128 = silence)
 * @param {string} mode               MUSIC_MODE.*
 * @param {{cap?:number, threshold?:number, gain?:number, decay?:number, state:object, accentHue?:number, accentSat?:number}} opts
 * @returns {{hue:number, sat:number, val:number}} 0..255 each
 */
export function mapAudioToHSV(freq, wave, mode = MUSIC_MODE.BREATHE, opts = {}) {
  const cap = opts.cap == null ? DEFAULT_CAP : clamp01(opts.cap);
  const threshold = opts.threshold == null ? DEFAULT_THRESHOLD : clamp01(opts.threshold);
  const gain = opts.gain == null ? DEFAULT_GAIN : Math.max(0, +opts.gain || 0);
  const decay = opts.decay == null ? DEFAULT_DECAY : clamp01(opts.decay);
  const state = opts.state || newMapState();
  const accentHue = opts.accentHue == null ? 40 : opts.accentHue; // warm accent for onset pops
  const accentSat = opts.accentSat == null ? 255 : Math.max(0, Math.min(255, Math.round(opts.accentSat)));

  // RMS loudness (0..1) from the time-domain waveform.
  let ss = 0;
  for (let i = 0; i < wave.length; i++) { const d = wave[i] - 128; ss += d * d; }
  const rawRms = clamp01(Math.sqrt(ss / Math.max(1, wave.length)) / 128);
  const active = rawRms > threshold;
  const rms = active ? clamp01((rawRms - threshold) / Math.max(1e-6, 1 - threshold)) : 0;
  // Display-capture audio rarely reaches a full-scale waveform. Track the recent peak so the
  // slider's ceiling is reachable with ordinary playback volume, not only clipped input.
  state.levelPeak = Math.max(rms, state.levelPeak * 0.995);
  // Favor sustained visible brightness after a transient: music's normal body should not look
  // capped just because a preceding beat set a higher peak.
  const level = clamp01(Math.pow(rms / Math.max(1e-6, state.levelPeak), 0.25) * gain);

  // Band energies → a target hue.
  const bass = meanRange(freq, 1, 8);
  const mid = meanRange(freq, 9, 40);
  const treb = meanRange(freq, 41, 120);
  const total = bass + mid + treb + 1;
  const hueTarget = (bass * HUE_BASS + mid * HUE_MID + treb * HUE_TREB) / total;

  // Spectral flux → adaptive onset detection.
  let flux = 0;
  if (active && state.prevFreq) {
    for (let i = 0; i < freq.length; i++) {
      const inc = freq[i] - state.prevFreq[i];
      if (inc > 0) flux += inc;
    }
  }
  state.prevFreq = Array.from(freq);
  const onset = flux > state.fluxAvg * 1.5 + 1e-6;
  state.fluxAvg = lerp(state.fluxAvg, flux, 0.1); // moving average

  // Per-mode value + hue target.
  let valTarget, hueGoal, satTarget = 255;
  if (!active) {
    valTarget = FLOOR;
    hueGoal = mode === MUSIC_MODE.PICKED ? accentHue : state.prevHue;
    if (mode === MUSIC_MODE.PICKED) satTarget = accentSat;
  } else if (mode === MUSIC_MODE.PULSE) {
    const base = lerp(ACTIVE_FLOOR, 0.8, level);
    valTarget = onset ? Math.min(1, base + 0.25) : base;
    hueGoal = onset ? accentHue : slewLimitWrap(state.prevHue, hueTarget, MAX_HUE_DELTA * 3);
    if (onset) satTarget = accentSat;
  } else if (mode === MUSIC_MODE.FOLLOW_HUE) {
    valTarget = lerp(ACTIVE_FLOOR, 1.0, level);
    hueGoal = dominantBinHue(freq);
  } else if (mode === MUSIC_MODE.PICKED) {
    valTarget = lerp(ACTIVE_FLOOR, 1.0, level);
    hueGoal = accentHue;
    satTarget = accentSat;
  } else { // BREATHE (gentle default)
    valTarget = lerp(ACTIVE_FLOOR, 1.0, level);
    hueGoal = hueTarget;
  }

  // SAFETY: cap, then slew-limit both value and hue (R.3/R.4). Two independent clamps on value
  // because the firmware offers none — cap here, clamp8 again at the builder edge.
  valTarget = clamp01(valTarget) * cap;
  const val = slewLimit(state.prevVal, valTarget, MAX_VAL_DELTA, decay);
  const hue = slewLimitWrap(state.prevHue, hueGoal, MAX_HUE_DELTA);
  state.prevVal = val;
  state.prevHue = hue;

  return { hue: Math.round(hue), sat: satTarget, val: Math.round(clamp01(val) * 255) };
}

/**
 * Pick the save-less report(s) for one HSV frame, per detected firmware (P.3). Neither branch emits
 * a 0x09 save, so streaming these never touches EEPROM. A misdetect degrades to "no reactivity"
 * (the wrong firmware's command is a harmless no-op), never a bad write.
 * @param {'custom'|'stock'} fw
 * @param {{hue:number, sat:number, val:number}} hsv
 * @returns {Uint8Array[]} 1 report on custom (07 41…), 2 on stock (07 03 04… + 07 03 01…)
 */
export function pickSaveLessCommand(fw, { hue, sat, val }) {
  if (fw === 'custom') return [buildVialRGBColorLive(hue, sat, val)];
  return [buildLightColorLive(hue, sat), buildLightBrightnessLive(val)];
}

/**
 * Detect stock vs custom firmware via the 0x46 side-bar GET probe (P.4). Custom (vial-qmk) replies
 * [0x46, …]; stock default-cases it → no reply → 'stock'. `transact(report, match, timeoutMs)` is the
 * host's request/response helper (ui.js viaTransact) injected so this stays testable with no HID.
 * @param {(report:Uint8Array, match:(d:Uint8Array)=>boolean, timeoutMs:number)=>Promise<Uint8Array>} transact
 * @returns {Promise<'custom'|'stock'>}
 */
export async function detectFirmware(transact, timeoutMs = 400) {
  try {
    const reply = await transact(buildBarGet(), (d) => d && d[0] === 0x46, timeoutMs);
    return reply ? 'custom' : 'stock';
  } catch {
    return 'stock'; // no reply / timeout → treat as stock (safe: stock commands no-op on custom)
  }
}
