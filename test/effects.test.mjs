// Effect-catalog pure-logic tests — no DOM, no localStorage. Covers catalog integrity, the
// enabled-set serialize/parse roundtrip, the Recommended preset, dropdown filter order, and the
// empty / selected-disabled guards. Run: node test/effects.test.mjs
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, EFFECT_CATEGORIES, EFFECT_CATALOG, ALL_IDS, RECOMMENDED_IDS,
  isEffectId, effectsInCategory, idsInCategory, filterEnabled,
  serializeEnabled, parseEnabled, guardEnabled, pickSelected,
} from '../src/effects.js';
import { VIALRGB_EFFECT } from '../src/protocol.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

console.log('AL80 Studio effect-catalog tests\n');

// ---- catalog integrity ------------------------------------------------------
ok('catalog has 31 effects with unique ids', () => {
  assert.equal(EFFECT_CATALOG.length, 31);
  const ids = EFFECT_CATALOG.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

ok('ALL_IDS mirrors the catalog ids in order', () => {
  assert.deepEqual([...ALL_IDS], EFFECT_CATALOG.map((e) => e.id));
});

ok('every catalog id is a real VialRGB effect id', () => {
  const known = new Set(Object.values(VIALRGB_EFFECT));
  for (const e of EFFECT_CATALOG) assert.ok(known.has(e.id), `unknown id ${e.id} (${e.name})`);
});

ok('PALETTE_CYCLE custom id 256 is present', () => {
  assert.equal(VIALRGB_EFFECT.PALETTE_CYCLE, 256);
  assert.ok(EFFECT_CATALOG.some((e) => e.id === 256));
});

ok('every effect belongs to a declared category, and every category is used', () => {
  const catKeys = new Set(EFFECT_CATEGORIES.map((c) => c.key));
  for (const e of EFFECT_CATALOG) assert.ok(catKeys.has(e.category), `bad category ${e.category}`);
  for (const c of EFFECT_CATEGORIES) assert.ok(effectsInCategory(c.key).length > 0, `empty category ${c.key}`);
});

ok('category membership partitions the catalog (no gaps, no overlap)', () => {
  const total = EFFECT_CATEGORIES.reduce((n, c) => n + idsInCategory(c.key).length, 0);
  assert.equal(total, EFFECT_CATALOG.length);
});

ok('every name is non-empty', () => {
  for (const e of EFFECT_CATALOG) assert.ok(e.name && e.name.length > 0);
});

ok('isEffectId accepts catalog ids and rejects others', () => {
  assert.equal(isEffectId(0), true);
  assert.equal(isEffectId(256), true);
  assert.equal(isEffectId('2'), true); // coerces
  assert.equal(isEffectId(999), false);
  assert.equal(isEffectId(1), false); // 1 is not in the catalog
});

// ---- Recommended preset -----------------------------------------------------
ok('RECOMMENDED_IDS is exactly the documented set', () => {
  assert.deepEqual([...RECOMMENDED_IDS].sort((a, b) => a - b), [0, 2, 6, 13, 21, 30, 31, 39, 41, 256]);
});

ok('every recommended id exists in the catalog', () => {
  for (const id of RECOMMENDED_IDS) assert.ok(isEffectId(id), `recommended id ${id} missing`);
});

// ---- filter order -----------------------------------------------------------
ok('filterEnabled returns catalog-order subset', () => {
  const set = new Set([256, 0, 13]); // out of order on purpose
  // catalog order: 0 and 256 are in "basic", 13 in "rainbow" (which follows) -> 0, 256, 13
  assert.deepEqual(filterEnabled(set).map((e) => e.id), [0, 256, 13]);
});

ok('filterEnabled with all ids returns the whole catalog in order', () => {
  const set = new Set(ALL_IDS);
  assert.deepEqual(filterEnabled(set).map((e) => e.id), [...ALL_IDS]);
});

ok('filterEnabled ignores ids not in the catalog', () => {
  const set = new Set([2, 999]);
  assert.deepEqual(filterEnabled(set).map((e) => e.id), [2]);
});

// ---- serialize / parse roundtrip -------------------------------------------
ok('STORAGE_KEY is the documented key', () => {
  assert.equal(STORAGE_KEY, 'al80.effects.enabled');
});

ok('serialize -> parse roundtrips an enabled set', () => {
  const set = new Set([6, 2, 0, 256]);
  const parsed = parseEnabled(serializeEnabled(set));
  assert.deepEqual([...parsed].sort((a, b) => a - b), [0, 2, 6, 256]);
});

ok('serializeEnabled is stable (sorted) and drops non-catalog ids', () => {
  assert.equal(serializeEnabled(new Set([256, 2, 0, 999])), '[0,2,256]');
});

ok('parseEnabled drops unknown ids', () => {
  const parsed = parseEnabled('[2, 6, 999, 1]');
  assert.deepEqual([...parsed].sort((a, b) => a - b), [2, 6]);
});

ok('parseEnabled returns null on null/garbage/empty', () => {
  assert.equal(parseEnabled(null), null);
  assert.equal(parseEnabled(''), null);
  assert.equal(parseEnabled('not json'), null);
  assert.equal(parseEnabled('{}'), null);         // not an array
  assert.equal(parseEnabled('[]'), null);          // empty
  assert.equal(parseEnabled('[999, 1]'), null);    // no valid ids
});

// ---- empty guard ------------------------------------------------------------
ok('guardEnabled keeps a non-empty set as-is', () => {
  const set = new Set([2, 6]);
  assert.equal(guardEnabled(set), set);
});

ok('guardEnabled falls back to Recommended when empty/null', () => {
  const g1 = guardEnabled(new Set());
  assert.deepEqual([...g1].sort((a, b) => a - b), [...RECOMMENDED_IDS].sort((a, b) => a - b));
  const g2 = guardEnabled(null);
  assert.ok(g2.size > 0);
});

// ---- selected-effect safety -------------------------------------------------
ok('pickSelected keeps the current id when still enabled', () => {
  const set = new Set([0, 2, 6]);
  assert.equal(pickSelected(set, 6), 6);
  assert.equal(pickSelected(set, '2'), 2); // coerces string
});

ok('pickSelected falls back to the first enabled effect (catalog order) when current is disabled', () => {
  const set = new Set([256, 13, 6]); // catalog order among these: 6, 13, 256
  assert.equal(pickSelected(set, 2), 6);
});

ok('pickSelected falls back to first catalog id when the set is empty', () => {
  assert.equal(pickSelected(new Set(), 5), EFFECT_CATALOG[0].id);
});

console.log(`\n${pass} checks passed.`);
