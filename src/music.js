// AL80 Studio — music-reactive lighting core. Pure, DOM-free, HID-free, node-unit-testable.
// The browser side (src/ui.js) owns the audio *capture* (getDisplayMedia/getUserMedia + AnalyserNode)
// behind a user gesture; this module owns the deterministic math and the firmware-aware command pick.
// Splitting it this way keeps the reactive mapping fully testable without a board or a mic.
//
// Grounded in research/al80-music-reactive-lighting-SPARC.md (P.2/P.3/P.4). The whole feature is
// "existing FX loop + audio color source + which-save-less-command" — no firmware change. Every
// per-frame report is save-less (never buildLightBrightness/buildLightColor which append a 0x09 save).

import {
  buildVialRGBColorLive, buildLightColorLive, buildLightBrightnessLive, buildBarGet, buildLiveFrame,
} from './protocol.js';

export const MUSIC_MODE = Object.freeze({ BREATHE: 'breathe', PULSE: 'pulse', FOLLOW_HUE: 'follow', PICKED: 'picked', ZONES: 'zones' });

// Safety constants (R.3/R.4). The firmware imposes NO brightness ceiling, so the host is the only
// clamp: DEFAULT_CAP scales every frame, and the slew limits keep a bass drop from strobing.
export const DEFAULT_CAP = 1.0;             // default to the keyboard's full 0-255 brightness scale
export const DEFAULT_THRESHOLD = 0.06;       // ignore low-level noise; higher = less sensitive
export const DEFAULT_DECAY = 0.086;          // brightness fall per nominal 60fps frame at the default Hold value
export const MAX_VAL_DELTA = 0.12;          // max value change per frame (0..1) — anti-strobe
export const MAX_HUE_DELTA = 24;            // max hue change per frame on the 0..255 wheel
export const FLOOR = 0.15;                  // dim floor so silence still shows a gentle glow

// Brightness curve. Shared-tab audio never arrives near full scale: ordinary music sits around
// -20 dBFS RMS (rawRms ~0.10), and a full-scale waveform is a clipping square wave that playback
// cannot produce. The previous rms^0.35 mapped [0,1]→[0,1] against that, so normal music topped out
// near 43% brightness with the Brightness slider already pinned at 255 — and no exponent fixes it,
// because reaching 1.0 required an input that cannot occur. A saturating soft knee scaled to REAL
// music levels reaches the top on ordinary peaks while staying strictly monotonic in loudness.
//
// Deliberately history-free: an auto-gain normalizing against a rolling peak also reaches full, but
// it makes brightness depend on what played seconds ago and flattens sustained passages. That was
// tried and rejected — see the 'prior louder peak' and 'sustained audio' tests, which exist to keep
// it from coming back. This frame's brightness depends only on this frame.
export const LEVEL_KNEE = 0.06;             // post-threshold RMS reaching ~63% — calibrated to real playback
const levelCurve = (rms) => 1 - Math.exp(-rms / LEVEL_KNEE);

// Hue anchors on the 0..255 VIA wheel: bass=red(0), mid=green(85), treble=blue(170).
const HUE_BASS = 0, HUE_MID = 85, HUE_TREB = 170;
const BAND_GAMMA = 0.55;                    // see the double-compression note on bandLevel
const GATE_KNEE = 0.05;                     // normalized-rms span over which zones ramp in (soft gate)
// keyboard.json's 82 RGB-matrix layout x positions. 0=left/bass, 1=center/mids,
// 2=right/treble. This is logical LED order, which is what 0x49 uses.
const LED_X = new Uint8Array([
  0, 19, 34, 49, 63, 82, 97, 112, 127, 146, 161, 175, 190, 209,
  0, 15, 30, 45, 60, 75, 89, 104, 119, 135, 149, 164, 179, 202, 224,
  4, 22, 37, 52, 67, 82, 97, 112, 127, 142, 157, 172, 187, 202, 224,
  5, 26, 41, 56, 71, 86, 101, 116, 131, 146, 161, 176, 190,
  9, 34, 49, 63, 78, 93, 108, 123, 138, 153, 168, 189, 209,
  2, 21, 39, 95, 151, 170, 183, 183, 183, 194, 209, 224,
]);
const ZONE_BY_LED = Uint8Array.from(LED_X, (x) => (x < 75 ? 0 : x < 150 ? 1 : 2));

/** Fresh per-run state for the mapper. Kept outside the pure fn so it can accumulate across frames. */
export function newMapState() {
  return { prevVal: 0, prevHue: 0, prevFreq: null, fluxAvg: 0, bandAvg: [0, 0, 0], zoneVals: [0, 0, 0] };
}

/**
 * Forget the cross-frame tracking that only mapAudioToHSV maintains. Call when the style changes.
 *
 * mapAudioToZones never touches prevFreq, so after a stint in Zones it still holds the spectrum from
 * whenever an HSV style last ran. Differencing the current frame against that reports every change
 * the song made in between as one instantaneous flux — a false onset, which PULSE renders as an
 * accent flash that no transient in the audio asked for. Nulling it says "there was a gap"; the flux
 * guard already reads that as no-previous-frame. prevVal/prevHue/zoneVals are deliberately KEPT, so
 * brightness and color stay continuous across the switch instead of jumping.
 *
 * bandAvg is intentionally left alone: it's an EMA that re-converges on its own within ~1s, and hue
 * is slew-limited anyway, so it drifts back rather than flashing.
 */
export function resetTracking(state) {
  state.prevFreq = null;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/**
 * Raw input loudness as an RMS fraction of full scale (0..1), straight off the waveform.
 * This is what the analyser is ACTUALLY receiving, before any threshold or curve — the number the
 * on-screen meter shows, so "the lights are dim" and "the audio is quiet" stop looking identical.
 * Ordinary shared-tab playback lands near 0.10; 1.0 is a clipping square wave.
 */
export function frameLevel(wave) {
  let ss = 0;
  for (let i = 0; i < wave.length; i++) { const d = wave[i] - 128; ss += d * d; }
  return clamp01(Math.sqrt(ss / Math.max(1, wave.length)) / 128);
}

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

/**
 * One band's brightness (0..1).
 *
 * KNOWN DEFECT, deliberately left alone: getByteFrequencyData bytes are ALREADY logarithmic (the
 * analyser maps its -100..-30 dB window onto 0..255), so powering them compresses an already-log
 * value a second time — an 18 dB input swing moves a zone by under 15%, which is why the zones read
 * as a static picture of the spectrum's tilt rather than a reaction to it. The honest fix is a
 * dB-window map with a per-band tilt offset, but choosing that window needs REAL captured audio:
 * synthetic signals put treble near -98 dB, and constants fitted to that would be fitted to a
 * fiction. Left as-is pending a look at the desk with real playback, rather than replaced by a guess.
 */
function bandLevel(band) {
  return Math.pow(band / 255, BAND_GAMMA);
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
 * @param {{cap?:number, threshold?:number, decay?:number, frameScale?:number, state:object, accentHue?:number, accentSat?:number}} opts
 * @returns {{hue:number, sat:number, val:number}} 0..255 each
 */
export function mapAudioToHSV(freq, wave, mode = MUSIC_MODE.BREATHE, opts = {}) {
  const cap = opts.cap == null ? DEFAULT_CAP : clamp01(opts.cap);
  const threshold = opts.threshold == null ? DEFAULT_THRESHOLD : clamp01(opts.threshold);
  const decay = opts.decay == null ? DEFAULT_DECAY : clamp01(opts.decay);
  const frameScale = opts.frameScale == null ? 1 : Math.max(0.1, Math.min(3, +opts.frameScale || 1));
  const state = opts.state || newMapState();
  const accentHue = opts.accentHue == null ? 40 : ((Math.round(opts.accentHue) % 256) + 256) % 256;
  const accentSat = opts.accentSat == null ? 255 : Math.max(0, Math.min(255, Math.round(opts.accentSat)));

  const rawRms = frameLevel(wave);
  const active = rawRms > threshold;
  const rms = active ? clamp01((rawRms - threshold) / Math.max(1e-6, 1 - threshold)) : 0;
  const level = levelCurve(rms);

  // Color follows the band rising most above its recent level, not the average spectrum.
  // Averaging anchors 0/85/170 makes balanced music permanently green.
  const bass = meanRange(freq, 1, 8);
  const mid = meanRange(freq, 9, 40);
  const treb = meanRange(freq, 41, 120);
  const bands = [bass, mid, treb];
  const bandHues = [HUE_BASS, HUE_MID, HUE_TREB];
  const bandActivity = bands.map((value, i) => Math.max(0, value - state.bandAvg[i]));
  const activityTotal = bandActivity[0] + bandActivity[1] + bandActivity[2];
  const hueTarget = activityTotal > 1
    ? (bandActivity[0] * bandHues[0] + bandActivity[1] * bandHues[1] + bandActivity[2] * bandHues[2]) / activityTotal
    : state.prevHue;
  if (active) state.bandAvg = state.bandAvg.map((average, i) => lerp(average, bands[i], 0.05));

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
    const base = lerp(FLOOR, 0.72, level);
    valTarget = onset ? Math.min(1, base + 0.28) : base;
    hueGoal = onset ? accentHue : slewLimitWrap(state.prevHue, hueTarget, MAX_HUE_DELTA * 3);
    if (onset) satTarget = accentSat;
  } else if (mode === MUSIC_MODE.FOLLOW_HUE) {
    valTarget = lerp(FLOOR, 1.0, level);
    hueGoal = dominantBinHue(freq);
  } else if (mode === MUSIC_MODE.PICKED) {
    valTarget = lerp(FLOOR, 1.0, level);
    hueGoal = accentHue;
    satTarget = accentSat;
  } else { // BREATHE (gentle default)
    valTarget = lerp(FLOOR, 1.0, level);
    hueGoal = hueTarget;
  }

  // SAFETY: cap, then slew-limit both value and hue (R.3/R.4). Two independent clamps on value
  // because the firmware offers none — cap here, clamp8 again at the builder edge.
  valTarget = clamp01(valTarget) * cap;
  const val = slewLimit(state.prevVal, valTarget, MAX_VAL_DELTA * frameScale, decay * frameScale);
  const hue = mode === MUSIC_MODE.PULSE && active && onset
    ? accentHue
    : slewLimitWrap(state.prevHue, hueGoal, MAX_HUE_DELTA * frameScale);
  state.prevVal = val;
  state.prevHue = hue;

  return { hue: Math.round(hue), sat: satTarget, val: Math.round(clamp01(val) * 255) };
}

/**
 * Map a frame to physical keyboard-zone brightnesses. The three values drive red on the left,
 * green through the middle, and blue on the right via the custom firmware's 0x49 live LED path.
 * @returns {{values:number[], level:number}} RGB values are 0..255; level is the loudest zone.
 */
export function mapAudioToZones(freq, wave, opts = {}) {
  const cap = opts.cap == null ? DEFAULT_CAP : clamp01(opts.cap);
  const threshold = opts.threshold == null ? DEFAULT_THRESHOLD : clamp01(opts.threshold);
  const decay = opts.decay == null ? DEFAULT_DECAY : clamp01(opts.decay);
  const frameScale = opts.frameScale == null ? 1 : Math.max(0.1, Math.min(3, +opts.frameScale || 1));
  const state = opts.state || newMapState();

  const rawRms = frameLevel(wave);
  const active = rawRms > threshold;
  const rms = active ? clamp01((rawRms - threshold) / Math.max(1e-6, 1 - threshold)) : 0;
  // Soft gate. A binary active/inactive flip meant a 6 dB change swung the whole board between
  // fully dark and ~81% — the threshold was a cliff in the SETTLED response, not just in how fast
  // it got there, so the slew limiter could not hide it. Ramp in over the first stretch instead.
  const gate = smoothstep(rms / GATE_KNEE);
  const bands = [meanRange(freq, 1, 8), meanRange(freq, 9, 40), meanRange(freq, 41, 120)];

  const values = bands.map((band, i) => {
    // Each physical zone is its own VU channel. Do not mix in overall loudness here: that makes
    // all three thirds flash together whenever any band is present.
    const target = active ? cap * bandLevel(band) * gate : 0;
    const previous = state.zoneVals[i] || 0;
    const value = slewLimit(previous, target, MAX_VAL_DELTA * frameScale, decay * frameScale);
    state.zoneVals[i] = value;
    return Math.round(clamp01(value) * 255);
  });
  return { values, level: Math.max(...values) };
}

/** Build the custom-firmware 0x49 LED field for the bass/mids/treble keyboard zones. */
export function buildZoneFrame(values) {
  const rgb = new Uint8Array(ZONE_BY_LED.length * 3);
  for (let led = 0; led < ZONE_BY_LED.length; led++) {
    const channel = ZONE_BY_LED[led];
    rgb[led * 3 + channel] = Math.max(0, Math.min(255, Math.round(values[channel] || 0)));
  }
  return buildLiveFrame(rgb);
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
