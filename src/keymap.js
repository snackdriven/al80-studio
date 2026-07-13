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
  MATRIX_ROWS: 6,
  MATRIX_COLS: 15,
});

/**
 * Physical layout of the AL80, extracted from the VIA definition's KLE keymap
 * (AL80_QMK__V0106_20251219.json). One entry per physical key:
 *   [row, col, x, y, w]  — x/y in key units (1u), w = key width in units.
 * The matrix is 6x15 = 90 positions (LAYER_SIZE); only 80 are populated (the
 * rest are KC_NO fillers with no physical key). Matrix/flat-layer index of a
 * key is row * MATRIX_COLS + col.
 * @readonly
 */
export const AL80_LAYOUT = Object.freeze([
  [0,0,0,0,1],[0,1,1.25,0,1],[0,2,2.25,0,1],[0,3,3.25,0,1],[0,4,4.25,0,1],[0,5,5.5,0,1],[0,6,6.5,0,1],[0,7,7.5,0,1],[0,8,8.5,0,1],[0,9,9.75,0,1],[0,10,10.75,0,1],[0,11,11.75,0,1],[0,12,12.75,0,1],[0,13,14.0,0,1],[0,14,15.0,0,1],
  [1,0,0,1,1.5],[1,1,1.5,1,1],[1,2,2.5,1,1],[1,3,3.5,1,1],[1,4,4.5,1,1],[1,5,5.5,1,1],[1,6,6.5,1,1],[1,7,7.5,1,1],[1,8,8.5,1,1],[1,9,9.5,1,1],[1,10,10.5,1,1],[1,11,11.5,1,1],[1,12,12.5,1,1],[1,13,13.5,1,1.5],[1,14,15.0,1,1],
  [2,0,0,2,1.75],[2,1,1.75,2,1],[2,2,2.75,2,1],[2,3,3.75,2,1],[2,4,4.75,2,1],[2,5,5.75,2,1],[2,6,6.75,2,1],[2,7,7.75,2,1],[2,8,8.75,2,1],[2,9,9.75,2,1],[2,10,10.75,2,1],[2,11,11.75,2,1],[2,12,12.75,2,1],[2,13,13.75,2,1.25],[2,14,15.0,2,1],
  [3,0,0,3,2],[3,1,2,3,1],[3,2,3,3,1],[3,3,4,3,1],[3,4,5,3,1],[3,5,6,3,1],[3,6,7,3,1],[3,7,8,3,1],[3,8,9,3,1],[3,9,10,3,1],[3,10,11,3,1],[3,11,12,3,1],[3,13,13,3,2],
  [4,0,0,4,2.25],[4,2,2.25,4,1],[4,3,3.25,4,1],[4,4,4.25,4,1],[4,5,5.25,4,1],[4,6,6.25,4,1],[4,7,7.25,4,1],[4,8,8.25,4,1],[4,9,9.25,4,1],[4,10,10.25,4,1],[4,11,11.25,4,1],[4,12,12.25,4,1.75],[4,13,14.0,4,1],
  [5,0,0,5,1.25],[5,1,1.25,5,1.25],[5,2,2.5,5,1.25],[5,6,3.75,5,6.25],[5,10,10.0,5,1.25],[5,11,11.25,5,1.25],[5,12,13.0,5,1],[5,13,14.0,5,1],[5,14,15.0,5,1],
]);

/** Flat matrix/layer index for a (row, col). Layers store keycodes in this order. */
export function matrixIndex(row, col) {
  return row * AL80.MATRIX_COLS + col;
}

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
  // AL80 firmware LCD view-switch keycodes. In VIA keymap JSON these are the
  // literal strings "CUSTOM(n)". These fire the same on-device view switch as
  // protocol.js buildView(): homepage=0x0b, picture=0x0d, gif=0x0f.
  // Mapping evidence (three independent sources agree):
  //   - @nvoostrom's VIA definition AL80_QMK_V0104-FIX-20250424.json customKeycodes
  //   - ../al80-lcd/keymap/AL80_QMK_V0106-with-keycodes.json customKeycodes
  //   - ../al80-lcd/keymap/community/README.md (cross-refs AL80_KNOWLEDGE_BASE.md §7)
  //   CUSTOM(22)=HOM "Go to Homepage" · CUSTOM(23)=IMG "Change to Image" · CUSTOM(24)=GIF "Change to GIF"
  'LCD view': [
    { label: 'Show GIF page', keycode: 'CUSTOM(24)', note: 'LCD GIF view (GIF) — protocol VIEW.GIF 0x0f' },
    { label: 'Show main page', keycode: 'CUSTOM(22)', note: 'LCD homepage / clock (HOM) — protocol VIEW.HOMEPAGE 0x0b' },
    { label: 'Show picture page', keycode: 'CUSTOM(23)', note: 'LCD image view (IMG) — protocol VIEW.PICTURE 0x0d' },
  ],

  // AL80 firmware panel hotkeys (CUSTOM 25-29, from al80-lcd al80.h). These fire the local LCD
  // view AND send an unsolicited raw-HID [0x4B, panelId] the always-on host (cycle-run.mjs) reads
  // and routes to its panel cycler — so they only "jump" while the host is running. Requires the
  // consolidated-keycodes firmware (AL80_CUSTOM_QMK_v28_keycodes.bin) flashed.
  'LCD panels (host cycler)': [
    { label: 'Panel: Now Playing', keycode: 'CUSTOM(25)', note: 'view 0x0d + host panel 0x00 (needs Spotify creds on the host)' },
    { label: 'Panel: Weather', keycode: 'CUSTOM(26)', note: 'view 0x0d + host panel 0x01' },
    { label: 'Panel: Clock', keycode: 'CUSTOM(27)', note: 'view 0x0b + host panel 0x02' },
    { label: 'Cycle pause / resume', keycode: 'CUSTOM(28)', note: 'host panel 0xf0 — toggle rotation' },
    { label: 'Cycle next panel', keycode: 'CUSTOM(29)', note: 'host panel 0xf1 — advance one' },
  ],

  // AL80 firmware lighting / backlight custom keycodes (same CUSTOM(n) space).
  'LCD + lighting': [
    { label: 'Backlight on/off', keycode: 'CUSTOM(10)', note: 'Toggle backlight (BLT)' },
    { label: 'Brightness +', keycode: 'CUSTOM(17)', note: 'LED brightness up (B+)' },
    { label: 'Brightness -', keycode: 'CUSTOM(18)', note: 'LED brightness down (B-)' },
  ],

  // AL80 tri-mode wireless / connection custom keycodes (same CUSTOM(n) space). Read off the
  // factory Fn layer: Fn+1/2/3 = CUSTOM(1/2/3) = Bluetooth 1-3, Fn+4 = CUSTOM(4) = 2.4GHz.
  // CUSTOM(0) = USB mode — the definition's only labeled customKeycode (KC_USB / USER00).
  'Wireless & mode': [
    { label: 'USB (wired)', keycode: 'CUSTOM(0)', note: 'Switch to wired USB mode' },
    { label: 'Bluetooth 1', keycode: 'CUSTOM(1)', note: 'BT channel 1 (factory Fn+1)' },
    { label: 'Bluetooth 2', keycode: 'CUSTOM(2)', note: 'BT channel 2 (factory Fn+2)' },
    { label: 'Bluetooth 3', keycode: 'CUSTOM(3)', note: 'BT channel 3 (factory Fn+3)' },
    { label: '2.4GHz', keycode: 'CUSTOM(4)', note: '2.4G dongle (factory Fn+4)' },
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

  // Layer activation. Place the trigger on the layer you press it FROM (usually
  // base/layer 0); put the target keys on the destination layer. Four layers (0-3).
  // NESTING: to reach layer 2 with "Fn + key", put MO(2) on a key on LAYER 1 (the
  // layer Fn=MO(1) turns on) — holding Fn makes layer 1 active, and the MO(2) key on
  // it then adds layer 2 while both are held. No firmware change needed.
  'Layers': [
    { label: 'Hold layer 1 (Fn)', keycode: 'MO(1)', note: 'Momentary — active while held. The factory Fn key.' },
    { label: 'Hold layer 2', keycode: 'MO(2)', note: 'Momentary L2. Put on a LAYER-1 key for Fn+key nesting.' },
    { label: 'Hold layer 3', keycode: 'MO(3)', note: 'Momentary L3.' },
    { label: 'Toggle layer 1', keycode: 'TG(1)', note: 'Tap on, tap off.' },
    { label: 'Toggle layer 2', keycode: 'TG(2)', note: 'Tap on, tap off.' },
    { label: 'Toggle layer 3', keycode: 'TG(3)', note: 'Tap on, tap off.' },
    { label: 'Switch to layer 1', keycode: 'TO(1)', note: 'Latch to L1 until another TO().' },
    { label: 'Switch to layer 2', keycode: 'TO(2)', note: 'Latch to L2 until another TO().' },
    { label: 'Switch to base (layer 0)', keycode: 'TO(0)', note: 'Return to the base layer.' },
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
// LCD view-switch keymap preset
//
// Binds the three LCD view-switch custom keycodes onto the Fn layer's number
// keys (layer 1). Matrix row 1 is the number row; flat index = row*15 + col:
//   Fn+8 -> col 8  -> index 23 -> CUSTOM(23) picture/image view
//   Fn+9 -> col 9  -> index 24 -> CUSTOM(22) main/homepage (clock) view
//   Fn+0 -> col 10 -> index 25 -> CUSTOM(24) GIF view
// A full ready-to-load VIA keymap file lives at keymaps/al80-lcd-view.json
// (factory base layer + these three bindings) — import it in the Keymap editor.
// @readonly
// ---------------------------------------------------------------------------
export const LCD_VIEW_BINDINGS = Object.freeze([
  { row: 1, col: 8, index: 23, keycode: 'CUSTOM(23)', label: 'Fn+8 → Show picture page' },
  { row: 1, col: 9, index: 24, keycode: 'CUSTOM(22)', label: 'Fn+9 → Show main page' },
  { row: 1, col: 10, index: 25, keycode: 'CUSTOM(24)', label: 'Fn+0 → Show GIF page' },
]);

/**
 * Stamp the three LCD view-switch keycodes onto layer 1 (Fn) of a keymap state,
 * mutating and returning it. Everything else on every layer is left untouched.
 * @param {{layers:string[][]}} state internal keymap state (from importKeymap/emptyKeymap)
 * @returns {{layers:string[][]}} the same state, with layer 1's 8/9/0 slots set
 */
export function applyLcdViewKeys(state) {
  if (!state || !Array.isArray(state.layers) || !Array.isArray(state.layers[1])) {
    throw new TypeError('applyLcdViewKeys: expected keymap state with a layer 1 array');
  }
  for (const b of LCD_VIEW_BINDINGS) state.layers[1][b.index] = b.keycode;
  return state;
}

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
 * The AL80 factory default base layer (layer 0), all 90 matrix positions in flat
 * order. Lets the Keymap editor show a real, editable, exportable layout offline
 * instead of a blank grid. Reading from the device overwrites it with the board's
 * actual keys. Source: the factory base of keymaps/al80-lcd-view.json.
 * @readonly
 */
export const AL80_FACTORY_LAYER0 = Object.freeze([
  'KC_ESC', 'KC_F1', 'KC_F2', 'KC_F3', 'KC_F4', 'KC_F5', 'KC_F6', 'KC_F7', 'KC_F8', 'KC_F9',
  'KC_F10', 'KC_F11', 'KC_F12', 'KC_DEL', 'KC_MUTE', 'KC_GRV', 'KC_1', 'KC_2', 'KC_3', 'KC_4',
  'KC_5', 'KC_6', 'KC_7', 'KC_8', 'KC_9', 'KC_0', 'KC_MINS', 'KC_EQL', 'KC_BSPC', 'KC_PGUP',
  'KC_TAB', 'KC_Q', 'KC_W', 'KC_E', 'KC_R', 'KC_T', 'KC_Y', 'KC_U', 'KC_I', 'KC_O',
  'KC_P', 'KC_LBRC', 'KC_RBRC', 'KC_BSLS', 'KC_PGDN', 'KC_CAPS', 'KC_A', 'KC_S', 'KC_D', 'KC_F',
  'KC_G', 'KC_H', 'KC_J', 'KC_K', 'KC_L', 'KC_SCLN', 'KC_QUOT', 'KC_NO', 'KC_ENT', 'KC_NO',
  'KC_LSFT', 'KC_NO', 'KC_Z', 'KC_X', 'KC_C', 'KC_V', 'KC_B', 'KC_N', 'KC_M', 'KC_COMM',
  'KC_DOT', 'KC_SLSH', 'KC_RSFT', 'KC_UP', 'KC_NO', 'KC_LCTL', 'KC_LGUI', 'KC_LALT', 'KC_NO', 'KC_NO',
  'KC_NO', 'KC_SPC', 'KC_NO', 'KC_NO', 'KC_NO', 'MO(1)', 'KC_RCTL', 'KC_LEFT', 'KC_DOWN', 'KC_RGHT',
]);

/**
 * Like emptyKeymap(), but layer 0 is seeded with the AL80 factory default so the
 * offline editor opens on a meaningful base layer. Upper layers stay transparent.
 * @returns {{name:string, vendorProductId:number, macros:string[], layers:string[][], encoders:string[][][]}}
 */
export function factoryKeymap() {
  const k = emptyKeymap();
  k.layers[0] = AL80_FACTORY_LAYER0.slice();
  return k;
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

// ---------------------------------------------------------------------------
// Keycode string <-> 16-bit VIA number
//
// The wire protocol (dynamic_keymap_get/set_keycode, encoders, buffer) speaks
// 16-bit numbers; the JSON model and presets speak VIA strings. These two
// functions bridge them. They cover the basic HID set, media/consumer keys,
// mod-wrapped keys (LGUI/LCTL/LALT/LSFT + right-hand), MO/TG/TO/DF/TT/OSL,
// LT(), MT(), MACRO(n) and CUSTOM(n). Everything is best-effort and defensive:
// an unknown string encodes to null (skip the live write), and an unknown
// number decodes to a "0xXXXX" token (still shows something in the UI).
//
// Ranges follow modern QMK / VIA v3 quantum keycodes (quantum_keycodes.h).
// ---------------------------------------------------------------------------

/** @type {Record<string, number>} canonical basic name -> number (num->name reverse built from this) */
const BASIC = (() => {
  const m = {
    KC_NO: 0x00, KC_TRNS: 0x01,
    KC_ENT: 0x28, KC_ESC: 0x29, KC_BSPC: 0x2a, KC_TAB: 0x2b, KC_SPC: 0x2c,
    KC_MINS: 0x2d, KC_EQL: 0x2e, KC_LBRC: 0x2f, KC_RBRC: 0x30, KC_BSLS: 0x31,
    KC_NUHS: 0x32, KC_SCLN: 0x33, KC_QUOT: 0x34, KC_GRV: 0x35, KC_COMM: 0x36,
    KC_DOT: 0x37, KC_SLSH: 0x38, KC_CAPS: 0x39,
    KC_PSCR: 0x46, KC_SCRL: 0x47, KC_PAUS: 0x48, KC_INS: 0x49, KC_HOME: 0x4a,
    KC_PGUP: 0x4b, KC_DEL: 0x4c, KC_END: 0x4d, KC_PGDN: 0x4e,
    KC_RGHT: 0x4f, KC_LEFT: 0x50, KC_DOWN: 0x51, KC_UP: 0x52,
    KC_NUM: 0x53, KC_PSLS: 0x54, KC_PAST: 0x55, KC_PMNS: 0x56, KC_PPLS: 0x57,
    KC_PENT: 0x58, KC_PDOT: 0x63, KC_NUBS: 0x64, KC_APP: 0x65,
    KC_LCTL: 0xe0, KC_LSFT: 0xe1, KC_LALT: 0xe2, KC_LGUI: 0xe3,
    KC_RCTL: 0xe4, KC_RSFT: 0xe5, KC_RALT: 0xe6, KC_RGUI: 0xe7,
    // media / consumer (QMK internal keycodes)
    KC_PWR: 0xa5, KC_MUTE: 0xa8, KC_VOLU: 0xa9, KC_VOLD: 0xaa,
    KC_MNXT: 0xab, KC_MPRV: 0xac, KC_MSTP: 0xad, KC_MPLY: 0xae, KC_MSEL: 0xaf,
    KC_EJCT: 0xb0, KC_MAIL: 0xb1, KC_CALC: 0xb2, KC_MYCM: 0xb3, KC_WSCH: 0xb4,
    KC_WHOM: 0xb5, KC_WBAK: 0xb6, KC_WFWD: 0xb7, KC_WSTP: 0xb8, KC_WREF: 0xb9,
    KC_WFAV: 0xba, KC_BRIU: 0xbd, KC_BRID: 0xbe,
  };
  for (let i = 0; i < 26; i++) m['KC_' + String.fromCharCode(65 + i)] = 0x04 + i; // KC_A..KC_Z
  for (let i = 1; i <= 9; i++) m['KC_' + i] = 0x1e + (i - 1); // KC_1..KC_9
  m['KC_0'] = 0x27;
  for (let i = 1; i <= 12; i++) m['KC_F' + i] = 0x3a + (i - 1); // KC_F1..KC_F12
  for (let i = 13; i <= 24; i++) m['KC_F' + i] = 0x68 + (i - 13); // KC_F13..KC_F24
  for (let i = 1; i <= 9; i++) m['KC_P' + i] = 0x59 + (i - 1); // KC_P1..KC_P9
  m['KC_P0'] = 0x62;
  return m;
})();

/** Aliases accepted on the way IN (name -> number) but never emitted on the way out. */
const BASIC_ALIASES = {
  KC_TRANSPARENT: 0x01, KC_ENTER: 0x28, KC_ESCAPE: 0x29, KC_BACKSPACE: 0x2a,
  KC_SPACE: 0x2c, KC_MINUS: 0x2d, KC_EQUAL: 0x2e, KC_CAPS_LOCK: 0x39,
  KC_AUDIO_MUTE: 0xa8, KC_AUDIO_VOL_UP: 0xa9, KC_AUDIO_VOL_DOWN: 0xaa,
  KC_MEDIA_NEXT_TRACK: 0xab, KC_MEDIA_PREV_TRACK: 0xac,
  KC_MEDIA_PLAY_PAUSE: 0xae, KC_RIGHT: 0x4f,
};

/** number -> canonical basic name (0x00..0xff range only). */
const BASIC_REV = (() => {
  const r = {};
  for (const [name, n] of Object.entries(BASIC)) if (!(n in r)) r[n] = name;
  return r;
})();

/** Modifier-wrap tokens -> [modNibble, isRight]. Nibble bits: CTL=1 SFT=2 ALT=4 GUI=8. */
const MOD_WRAP = {
  LCTL: [0x1, 0], C: [0x1, 0], LSFT: [0x2, 0], S: [0x2, 0],
  LALT: [0x4, 0], A: [0x4, 0], LGUI: [0x8, 0], G: [0x8, 0],
  RCTL: [0x1, 1], RSFT: [0x2, 1], RALT: [0x4, 1], RGUI: [0x8, 1],
};

/** MT() mod bitfield tokens. Right-hand sets bit 4 (0x10). */
const MOD_BITS = {
  MOD_LCTL: 0x01, MOD_LSFT: 0x02, MOD_LALT: 0x04, MOD_LGUI: 0x08,
  MOD_RCTL: 0x11, MOD_RSFT: 0x12, MOD_RALT: 0x14, MOD_RGUI: 0x18,
};

/**
 * Encode a VIA keycode string to its 16-bit number, or null when unrecognized.
 * @param {string} kc VIA keycode token (e.g. "KC_A", "MO(1)", "LT(1,KC_ESC)", "LGUI(KC_1)")
 * @returns {number|null}
 */
export function keycodeToNumber(kc) {
  if (typeof kc !== 'string') return null;
  const s = kc.trim();
  if (s === '') return null;

  // basic / alias
  if (s in BASIC) return BASIC[s];
  if (s in BASIC_ALIASES) return BASIC_ALIASES[s];

  // hex passthrough (round-trips unknown decodes)
  if (/^0x[0-9a-f]{1,4}$/i.test(s)) return parseInt(s, 16) & 0xffff;

  const fn = s.match(/^([A-Z_]+)\((.*)\)$/i);
  if (!fn) return null;
  const name = fn[1].toUpperCase();
  const arg = fn[2].trim();

  // layer ops with a single numeric layer arg
  const layerBase = { MO: 0x5220, TG: 0x5260, TO: 0x5200, DF: 0x5240, TT: 0x52c0, OSL: 0x5280 };
  if (name in layerBase && /^\d+$/.test(arg)) return layerBase[name] + (parseInt(arg, 10) & 0x1f);

  if (name === 'MACRO' && /^\d+$/.test(arg)) return 0x7700 + (parseInt(arg, 10) & 0xff);
  if (name === 'CUSTOM' && /^\d+$/.test(arg)) return 0x7e00 + (parseInt(arg, 10) & 0xff);

  if (name === 'LT') {
    const p = splitArgs(arg);
    if (p.length === 2 && /^\d+$/.test(p[0])) {
      const inner = keycodeToNumber(p[1]);
      if (inner == null) return null;
      return 0x4000 | ((parseInt(p[0], 10) & 0xf) << 8) | (inner & 0xff);
    }
    return null;
  }

  if (name === 'MT') {
    const p = splitArgs(arg);
    if (p.length === 2) {
      let mod = 0;
      for (const t of p[0].split('|').map((x) => x.trim())) {
        if (!(t in MOD_BITS)) return null;
        mod |= MOD_BITS[t];
      }
      const inner = keycodeToNumber(p[1]);
      if (inner == null) return null;
      return 0x2000 | ((mod & 0x1f) << 8) | (inner & 0xff);
    }
    return null;
  }

  // modifier wrap (possibly nested): LGUI(KC_1), LCTL(LSFT(KC_A))
  if (name in MOD_WRAP) {
    const inner = keycodeToNumber(arg);
    if (inner == null) return null;
    const [nibble, right] = MOD_WRAP[name];
    // Combine with any mod bits already present on the inner QK_MODS value.
    const innerNibble = (inner >> 8) & 0xf;
    const innerRight = (inner >> 12) & 0x1;
    const base = inner & 0xff;
    const r = right || innerRight;
    return ((r & 1) << 12) | (((nibble | innerNibble) & 0xf) << 8) | base;
  }

  return null;
}

/** Split "a, b" respecting nested parens: "MOD_LCTL, KC_ESC" or "1, LT(2,KC_A)". */
function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

/**
 * Decode a 16-bit VIA keycode number to a readable string. Never throws;
 * unknown values come back as "0xXXXX" (still round-trips via keycodeToNumber).
 * @param {number} n
 * @returns {string}
 */
export function numberToKeycode(n) {
  n &= 0xffff;
  if (n in BASIC_REV) return BASIC_REV[n];
  if (n <= 0xff) return '0x' + n.toString(16).padStart(2, '0');

  // CUSTOM / MACRO
  if (n >= 0x7e00 && n <= 0x7fff) return `CUSTOM(${n - 0x7e00})`;
  if (n >= 0x7700 && n <= 0x777f) return `MACRO(${n - 0x7700})`;

  // single-layer ops
  const layerRanges = [
    [0x5200, 'TO'], [0x5220, 'MO'], [0x5240, 'DF'], [0x5260, 'TG'],
    [0x5280, 'OSL'], [0x52c0, 'TT'],
  ];
  for (const [base, fn] of layerRanges) {
    if (n >= base && n < base + 0x20) return `${fn}(${n - base})`;
  }

  // LT(layer, kc)
  if (n >= 0x4000 && n <= 0x4fff) {
    return `LT(${(n >> 8) & 0xf},${numberToKeycode(n & 0xff)})`;
  }
  // MT(mod, kc)
  if (n >= 0x2000 && n <= 0x3fff) {
    const mod = (n >> 8) & 0x1f;
    const modName = Object.keys(MOD_BITS).find((k) => MOD_BITS[k] === mod);
    return `MT(${modName || '0x' + mod.toString(16)},${numberToKeycode(n & 0xff)})`;
  }
  // QK_MODS: mod-wrapped basic keycode
  if (n >= 0x0100 && n <= 0x1fff) {
    const nibble = (n >> 8) & 0xf;
    const right = (n >> 12) & 0x1;
    const names = { 0x1: right ? 'RCTL' : 'LCTL', 0x2: right ? 'RSFT' : 'LSFT', 0x4: right ? 'RALT' : 'LALT', 0x8: right ? 'RGUI' : 'LGUI' };
    // Emit one wrap per set mod bit, nesting the basic keycode inside.
    let inner = numberToKeycode(n & 0xff);
    for (const bit of [0x8, 0x4, 0x2, 0x1]) {
      if (nibble & bit) inner = `${names[bit]}(${inner})`;
    }
    return inner;
  }

  return '0x' + n.toString(16).padStart(4, '0');
}

export default {
  AL80,
  AL80_LAYOUT,
  PRESETS,
  LCD_VIEW_BINDINGS,
  applyLcdViewKeys,
  matrixIndex,
  emptyKeymap,
  importKeymap,
  exportKeymap,
  buildAppLauncherMacro,
  keycodeToNumber,
  numberToKeycode,
};
