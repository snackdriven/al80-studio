// Offline keymap tests — no hardware. Covers the pure logic in src/keymap.js:
// matrix indexing, keycode <-> number round-trips, the empty/factory keymaps, the LCD
// view-key stamp, and import/export round-tripping.
import assert from 'node:assert/strict';
import {
  AL80, matrixIndex, emptyKeymap, factoryKeymap, AL80_FACTORY_LAYER0,
  applyLcdViewKeys, LCD_VIEW_BINDINGS, importKeymap, exportKeymap,
  keycodeToNumber, numberToKeycode,
} from '../src/keymap.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

console.log('AL80 Studio keymap tests\n');

// ---- matrix indexing --------------------------------------------------------
ok('matrixIndex = row * MATRIX_COLS + col', () => {
  assert.equal(matrixIndex(0, 0), 0);
  assert.equal(matrixIndex(1, 0), AL80.MATRIX_COLS);   // 15
  assert.equal(matrixIndex(1, 8), 23);                 // the Fn+8 view-key slot
  assert.equal(matrixIndex(AL80.MATRIX_ROWS - 1, AL80.MATRIX_COLS - 1), AL80.LAYER_SIZE - 1); // 89
});

// ---- keycode <-> number -----------------------------------------------------
ok('keycode round-trip: basics', () => {
  for (const kc of ['KC_A', 'KC_ESC', 'KC_ENT', 'KC_SPC', 'KC_VOLU', 'KC_VOLD',
    'KC_NO', 'KC_TRNS', 'KC_LSFT', 'KC_UP', 'KC_1', 'KC_MINS']) {
    assert.equal(numberToKeycode(keycodeToNumber(kc)), kc, `round-trip ${kc}`);
  }
});

ok('keycode round-trip: layer / macro / custom / LT', () => {
  for (const kc of ['MO(1)', 'TO(0)', 'TG(2)', 'DF(3)', 'MACRO(3)', 'CUSTOM(23)', 'LT(1,KC_ESC)']) {
    assert.equal(numberToKeycode(keycodeToNumber(kc)), kc, `round-trip ${kc}`);
  }
});

ok('keycode known 16-bit values', () => {
  assert.equal(keycodeToNumber('KC_ESC'), 0x29);
  assert.equal(keycodeToNumber('CUSTOM(23)'), 0x7e17);   // the picture-view keycode
  assert.equal(keycodeToNumber('MO(1)'), 0x5221);
  assert.equal(keycodeToNumber('LT(1,KC_ESC)'), 0x4000 | (1 << 8) | 0x29);
});

ok('bad keycode -> null; hex passthrough; number decode round-trips', () => {
  assert.equal(keycodeToNumber('KC_BOGUS'), null);
  assert.equal(keycodeToNumber(42), null);               // non-string
  assert.equal(keycodeToNumber('0x1234'), 0x1234);       // hex-string passthrough
  // Every decoded number re-encodes to itself (round-trip integrity). 0x1234 is a real
  // modifier-wrapped code (RSFT(KC_QUOT)), not an "unknown" value — the decoder covers a
  // wide space, so the invariant to test is number -> string -> same number.
  for (const n of [0x29, 0x1234, 0x4129, 0x5221, 0x7e17]) {
    assert.equal(keycodeToNumber(numberToKeycode(n)), n, `0x${n.toString(16)}`);
  }
});

// ---- empty vs factory keymap ------------------------------------------------
ok('emptyKeymap: layer 0 all KC_NO, upper layers KC_TRNS, encoder = volume', () => {
  const k = emptyKeymap();
  assert.equal(k.layers.length, AL80.LAYER_COUNT);
  assert.equal(k.layers[0].length, AL80.LAYER_SIZE);
  assert.ok(k.layers[0].every((x) => x === 'KC_NO'), 'layer 0 all KC_NO');
  assert.ok(k.layers[1].every((x) => x === 'KC_TRNS'), 'layer 1 all KC_TRNS');
  assert.equal(k.macros.length, AL80.MACRO_COUNT);
  assert.deepEqual(k.encoders[0][0], ['KC_VOLD', 'KC_VOLU']);
});

ok('factoryKeymap: layer 0 = factory base (ESC first, 80 real keys), upper layers still transparent', () => {
  const k = factoryKeymap();
  assert.equal(k.layers[0].length, AL80.LAYER_SIZE);
  assert.equal(k.layers[0][0], 'KC_ESC');
  const real = k.layers[0].filter((x) => x !== 'KC_NO' && x !== 'KC_TRNS').length;
  assert.equal(real, 80);
  assert.ok(k.layers[1].every((x) => x === 'KC_TRNS'));
  // factoryKeymap must not mutate the shared frozen constant
  assert.notEqual(k.layers[0], AL80_FACTORY_LAYER0);
});

ok('AL80_FACTORY_LAYER0 is a frozen 90-entry array', () => {
  assert.equal(AL80_FACTORY_LAYER0.length, AL80.LAYER_SIZE);
  assert.ok(Object.isFrozen(AL80_FACTORY_LAYER0));
});

// ---- LCD view-key stamp -----------------------------------------------------
ok('applyLcdViewKeys stamps the three view keys on layer 1 and leaves the rest', () => {
  const k = applyLcdViewKeys(emptyKeymap());
  for (const b of LCD_VIEW_BINDINGS) assert.equal(k.layers[1][b.index], b.keycode);
  assert.equal(k.layers[1][0], 'KC_TRNS');   // untouched slot
  // and it round-trips through the number layer (real device keycodes)
  for (const b of LCD_VIEW_BINDINGS) assert.equal(typeof keycodeToNumber(b.keycode), 'number');
});

// ---- import / export --------------------------------------------------------
ok('exportKeymap -> importKeymap round-trips layers, macros, encoders', () => {
  const a = factoryKeymap();
  const exported = exportKeymap(a);
  const parsed = typeof exported === 'string' ? JSON.parse(exported) : JSON.parse(JSON.stringify(exported));
  const b = importKeymap(parsed);
  assert.deepEqual(b.layers, a.layers);
  assert.deepEqual(b.macros, a.macros);
  assert.deepEqual(b.encoders, a.encoders);
});

console.log(`\n${pass} checks passed.`);
