// keymap.js — AL80 Studio keymap/shortcuts module
//
// Preset library + VIA keymap JSON import/export for the YUNZII AL80.
// Vanilla ES module, dependency-free.
//
// VIA keymap JSON shape (the-via/reader), verified against
// ../al80-lcd/keymap/al80_keymap.json and docs.qmk.fm / caniusevia.com:
//   {
//     name:            string,
//     vendorProductId: number,
//     macros:          string[]      // 16 slots, VIA macro action syntax
//     layers:          string[][]    // LAYER_COUNT layers, each a flat array
//                                    // of keycode strings in matrix order
//     encoders:        [[ [cw, ccw], ... ]]  // per encoder, one [cw,ccw] per layer
//   }
//
// Keycode tokens emitted here are valid VIA strings: basic KC_*, media
// (KC_MPLY/KC_MNXT/KC_MPRV/KC_MUTE/KC_VOLU/KC_VOLD), layer functions
// (MO/TG/TT/LT/LM/DF), mod-tap MT(), quantum mod wraps (LGUI(kc)/G(kc),
// LALT(kc), LCTL(kc), LSFT(kc)), macro refs MACRO(n), and the AL80's
// firmware custom keycodes CUSTOM(n).

/**
 * AL80 matrix geometry, inferred from al80_keymap.json.
 * The AL80 is an ~80-key TKL; the matrix carries 90 positions per layer
 * (unused positions are KC_NO), across 4 layers, with a single volume encoder.
 * @readonly
 */
export const AL80 = Object.freeze({
  NAME: 'AL80 Keyboard',
  VENDOR_PRODUCT_ID: 686370991,
  LAYER_COUNT: 4,
  LAYER_SIZE: 90,
  ENCODER_COUNT: 1,
  MACRO_COUNT: 16,
});

// ---------------------------------------------------------------------------
// PRESETS — grouped catalog of ready-to-bind keycodes.
// Each preset: { label, keycode, note? }  keycode is a valid VIA token.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Preset
 * @property {string} label   Human-readable name for the UI.
 * @property {string} keycode Valid VIA keycode string to write into a layer slot.
 * @property {string} [note]  Optional extra context for the UI.
 */

/** @type {Record<string, Preset[]>} */
export const PRESETS = {
  // AL80 firmware custom keycodes. In VIA keymap JSON these are the literal
  // strings "CUSTOM(n)". Mapping from ../al80-lcd/keymap/community/README.md.
  'LCD + lighting': [
    { label: 'Switch to clock view', keycode: 'CUSTOM(22)', note: 'LCD homepage / clock (HOM)' },
    { label: 'Switch to picture view', keycode: 'CUSTOM(23)', note: 'LCD image view (IMG)' },
    { label: 'Switch to GIF view', keycode: 'CUSTOM(24)', note: 'LCD GIF view (GIF)' },
    { label: 'Backlight on/off', keycode: 'CUSTOM(10)', note: 'Toggle backlight (BLT)' },
    { label: 'Brightness +', keycode: 'CUSTOM(17)', note: 'LED brightness up (B+)' },
    { label: 'Brightness -', keycode: 'CUSTOM(18)', note: 'LED brightness down (B-)' },
  ],

  // Taskbar-position launchers: LGUI(1..9) presses Win+<n>, which activates the
  // Nth pinned/running app on the Windows taskbar. Plus macro-driven launchers
  // (Win+R "run" flavor) built by buildAppLauncherMacro().
  'App launchers': [
    { label: 'Taskbar app 1', keycode: 'LGUI(KC_1)', note: 'Win+1 — first pinned taskbar app' },
    { label: 'Taskbar app 2', keycode: 'LGUI(KC_2)', note: 'Win+2' },
    { label: 'Taskbar app 3', keycode: 'LGUI(KC_3)', note: 'Win+3' },
    { label: 'Taskbar app 4', keycode: 'LGUI(KC_4)', note: 'Win+4' },
    { label: 'Taskbar app 5', keycode: 'LGUI(KC_5)', note: 'Win+5' },
    { label: 'Taskbar app 6', keycode: 'LGUI(KC_6)', note: 'Win+6' },
    { label: 'Taskbar app 7', keycode: 'LGUI(KC_7)', note: 'Win+7' },
    { label: 'Taskbar app 8', keycode: 'LGUI(KC_8)', note: 'Win+8' },
    { label: 'Taskbar app 9', keycode: 'LGUI(KC_9)', note: 'Win+9' },
    // Macro-based launchers open the Run dialog and type a target. These bind
    // to a MACRO(n) slot; use buildAppLauncherMacro() to produce the slot text.
    { label: 'Run: Notepad', keycode: 'MACRO(1)', note: 'Win+R → "notepad" → Enter (fill macro slot 1)' },
    { label: 'Run: Calculator', keycode: 'MACRO(2)', note: 'Win+R → "calc" → Enter (fill macro slot 2)' },
    { label: 'Run: Terminal', keycode: 'MACRO(3)', note: 'Win+R → "wt" → Enter (fill macro slot 3)' },
  ],

  'Media': [
    { label: 'Play / Pause', keycode: 'KC_MPLY' },
    { label: 'Next track', keycode: 'KC_MNXT' },
    { label: 'Previous track', keycode: 'KC_MPRV' },
    { label: 'Mute', keycode: 'KC_MUTE' },
    { label: 'Volume up', keycode: 'KC_VOLU' },
    { label: 'Volume down', keycode: 'KC_VOLD' },
  ],

  'Window': [
    { label: 'Snap left', keycode: 'LGUI(KC_LEFT)', note: 'Win+Left' },
    { label: 'Snap right', keycode: 'LGUI(KC_RGHT)', note: 'Win+Right' },
    { label: 'Close window', keycode: 'LALT(KC_F4)', note: 'Alt+F4' },
    { label: 'Show desktop', keycode: 'LGUI(KC_D)', note: 'Win+D' },
    { label: 'Task view', keycode: 'LGUI(KC_TAB)', note: 'Win+Tab' },
  ],

  'Basics': [
    { label: 'Momentary layer 1 (hold)', keycode: 'MO(1)', note: 'Fn layer while held' },
    { label: 'Toggle layer 2', keycode: 'TG(2)' },
    { label: 'Layer-tap: L1 / Esc', keycode: 'LT(1,KC_ESC)', note: 'Hold = layer 1, tap = Esc' },
    { label: 'Layer-tap: L1 / Space', keycode: 'LT(1,KC_SPC)', note: 'Hold = layer 1, tap = Space' },
    { label: 'Layer-tap: L2 / Caps', keycode: 'LT(2,KC_CAPS)' },
    { label: 'Mod-tap: Ctrl / Esc', keycode: 'MT(MOD_LCTL,KC_ESC)', note: 'Hold = Ctrl, tap = Esc' },
    { label: 'Mod-tap: Shift / Enter', keycode: 'MT(MOD_RSFT,KC_ENT)', note: 'Hold = Shift, tap = Enter' },
    { label: 'Left GUI (Win)', keycode: 'KC_LGUI' },
    { label: 'Left Ctrl', keycode: 'KC_LCTL' },
    { label: 'Left Alt', keycode: 'KC_LALT' },
    { label: 'Left Shift', keycode: 'KC_LSFT' },
    { label: 'Transparent (fall through)', keycode: 'KC_TRNS', note: 'Use lower layer at this position' },
    { label: 'No-op', keycode: 'KC_NO', note: 'Disable this key' },
  ],
};

// ---------------------------------------------------------------------------
// Keymap construction / import / export
// ---------------------------------------------------------------------------

/**
 * Build an empty, valid VIA keymap for the AL80.
 * Base layer (0) is all KC_NO; upper layers are all KC_TRNS. Macros are 16
 * empty slots. The single encoder maps to volume on every layer.
 * @returns {{name:string, vendorProductId:number, macros:string[], layers:string[][], encoders:string[][][]}}
 */
export function emptyKeymap() {
  const layers = [];
  for (let i = 0; i < AL80.LAYER_COUNT; i++) {
    const fill = i === 0 ? 'KC_NO' : 'KC_TRNS';
    layers.push(new Array(AL80.LAYER_SIZE).fill(fill));
  }

  const macros = new Array(AL80.MACRO_COUNT).fill('');

  // encoders: one entry per physical encoder; each is an array of [cw, ccw]
  // pairs, one pair per layer.
  const encoders = [];
  for (let e = 0; e < AL80.ENCODER_COUNT; e++) {
    const perLayer = [];
    for (let i = 0; i < AL80.LAYER_COUNT; i++) {
      perLayer.push(['KC_VOLD', 'KC_VOLU']);
    }
    encoders.push(perLayer);
  }

  return {
    name: AL80.NAME,
    vendorProductId: AL80.VENDOR_PRODUCT_ID,
    macros,
    layers,
    encoders,
  };
}

/**
 * Normalize a parsed VIA keymap JSON object into editable internal state.
 * Deep-copies arrays so edits don't mutate the source. Missing fields fall
 * back to AL80 defaults so a partial file still yields usable state.
 * @param {Object} jsonObject Parsed VIA keymap (e.g. JSON.parse of a .json file).
 * @returns {{name:string, vendorProductId:number, layers:string[][], macros:string[], encoders:string[][][]}}
 */
export function importKeymap(jsonObject) {
  if (!jsonObject || typeof jsonObject !== 'object') {
    throw new TypeError('importKeymap: expected a parsed VIA keymap object');
  }

  const name =
    typeof jsonObject.name === 'string' ? jsonObject.name : AL80.NAME;

  const vendorProductId =
    typeof jsonObject.vendorProductId === 'number'
      ? jsonObject.vendorProductId
      : AL80.VENDOR_PRODUCT_ID;

  const layers = Array.isArray(jsonObject.layers)
    ? jsonObject.layers.map((layer) =>
        Array.isArray(layer) ? layer.map(String) : []
      )
    : [];

  const macros = Array.isArray(jsonObject.macros)
    ? jsonObject.macros.map(String)
    : [];

  // encoders: [[ [cw, ccw], ... ], ...]  — deep copy the nested arrays.
  const encoders = Array.isArray(jsonObject.encoders)
    ? jsonObject.encoders.map((enc) =>
        Array.isArray(enc)
          ? enc.map((pair) =>
              Array.isArray(pair) ? pair.map(String) : pair
            )
          : enc
      )
    : [];

  return { name, vendorProductId, layers, macros, encoders };
}

/**
 * Serialize internal editable state back into a VIA keymap JSON object that
 * usevia.app can byte-load. Deep-copies so the returned object is standalone.
 * Round-trip: exportKeymap(importKeymap(file)) reproduces the same
 * name / vendorProductId / macros / layers / encoders.
 * @param {{name:string, vendorProductId:number, layers:string[][], macros:string[], encoders:string[][][]}} state
 * @returns {{name:string, vendorProductId:number, macros:string[], layers:string[][], encoders:string[][][]}}
 */
export function exportKeymap(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('exportKeymap: expected internal keymap state');
  }

  const layers = Array.isArray(state.layers)
    ? state.layers.map((layer) => layer.map(String))
    : [];

  const macros = Array.isArray(state.macros) ? state.macros.map(String) : [];

  const encoders = Array.isArray(state.encoders)
    ? state.encoders.map((enc) =>
        Array.isArray(enc)
          ? enc.map((pair) =>
              Array.isArray(pair) ? pair.map(String) : pair
            )
          : enc
      )
    : [];

  // Key order matches al80_keymap.json: name, vendorProductId, macros, layers, encoders.
  return {
    name: typeof state.name === 'string' ? state.name : AL80.NAME,
    vendorProductId:
      typeof state.vendorProductId === 'number'
        ? state.vendorProductId
        : AL80.VENDOR_PRODUCT_ID,
    macros,
    layers,
    encoders,
  };
}

// ---------------------------------------------------------------------------
// Macro builder
// ---------------------------------------------------------------------------

/**
 * VIA macro-action name for a single printable character.
 * Only the characters needed for typical Run targets are mapped (letters,
 * digits, and a few path separators). Returns null for anything unmapped.
 * @param {string} ch single character
 * @returns {string|null} VIA keycode name (e.g. "KC_N", "KC_DOT") or null
 */
function keycodeForChar(ch) {
  if (ch >= 'a' && ch <= 'z') return 'KC_' + ch.toUpperCase();
  if (ch >= 'A' && ch <= 'Z') return 'KC_' + ch; // caller handles shift if needed
  if (ch >= '0' && ch <= '9') return 'KC_' + ch;
  switch (ch) {
    case ' ':
      return 'KC_SPC';
    case '.':
      return 'KC_DOT';
    case '-':
      return 'KC_MINS';
    case '_':
      return 'KC_UNDS';
    case '\\':
      return 'KC_BSLS';
    case '/':
      return 'KC_SLSH';
    case ':':
      return 'KC_COLN';
    default:
      return null;
  }
}

/**
 * Build a VIA macro that opens the Windows Run dialog and launches a target.
 * Sequence: Win+R, short delay, type the target, Enter.
 *
 * Uses the same human-readable VIA macro action syntax as al80_keymap.json
 * (Down(kc) / Up(kc) / Tap(kc), comma-separated). Delay() gives the Run dialog
 * time to focus before typing.
 *
 * @param {string} runTarget command to type into Run (e.g. "notepad", "calc", "wt").
 * @param {Object} [opts]
 * @param {number} [opts.macroIndex=1] which MACRO slot this fills (0-15); the
 *   returned keycode is MACRO(macroIndex).
 * @param {number} [opts.openDelayMs=200] delay after Win+R before typing.
 * @returns {{keycode:string, macroIndex:number, macro:string}}
 *   keycode: bind this on a layer; macroIndex: slot to write `macro` into;
 *   macro: the VIA macro action string for that slot.
 */
export function buildAppLauncherMacro(runTarget, opts = {}) {
  const macroIndex =
    Number.isInteger(opts.macroIndex) &&
    opts.macroIndex >= 0 &&
    opts.macroIndex < AL80.MACRO_COUNT
      ? opts.macroIndex
      : 1;
  const openDelayMs =
    Number.isFinite(opts.openDelayMs) && opts.openDelayMs >= 0
      ? Math.round(opts.openDelayMs)
      : 200;

  const target = String(runTarget == null ? '' : runTarget);

  const actions = [];

  // Win+R
  actions.push('Down(KC_LGUI)', 'Tap(KC_R)', 'Up(KC_LGUI)');

  // Let the Run dialog appear before typing.
  actions.push(`Delay(${openDelayMs})`);

  // Type the target, one Tap per character.
  for (const ch of target) {
    const kc = keycodeForChar(ch);
    if (kc) {
      actions.push(`Tap(${kc})`);
    }
    // Unmapped characters are skipped rather than emitting an invalid token.
  }

  // Submit.
  actions.push('Tap(KC_ENT)');

  return {
    keycode: `MACRO(${macroIndex})`,
    macroIndex,
    macro: actions.join(', '),
  };
}

export default {
  AL80,
  PRESETS,
  emptyKeymap,
  importKeymap,
  exportKeymap,
  buildAppLauncherMacro,
};
