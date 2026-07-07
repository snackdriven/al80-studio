// Slot-cache pure-logic tests — no IndexedDB, no DOM. Covers the record shape, the settings
// normalization roundtrip, and the recents cap/evict rules (oldest-unpinned-first, pinned kept).
// The IndexedDB CRUD and the canvas thumbnail helpers are browser-only and exercised on-device.
// Run: node test/slots.test.mjs
import assert from 'node:assert/strict';
import {
  SLOT_AREAS, RECENTS_CAP, SETTINGS_KEYS,
  newId, normalizeSettings, makeRecord, capRecents, isQuotaError,
} from '../src/slots.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

console.log('AL80 Studio slot-cache tests\n');

// ---- constants --------------------------------------------------------------
ok('SLOT_AREAS is the four content areas (clock excluded)', () => {
  assert.deepEqual([...SLOT_AREAS], ['main', 'picture', 'gif', 'startup']);
  assert.equal(SLOT_AREAS.includes('clock'), false);
});

// ---- ids --------------------------------------------------------------------
ok('newId is unique-ish and starts with r', () => {
  const a = newId();
  const b = newId();
  assert.match(a, /^r[0-9a-z]+$/);
  assert.notEqual(a, b);
});

// ---- settings normalization / roundtrip -------------------------------------
ok('normalizeSettings keeps known keys and drops unknown ones', () => {
  const s = normalizeSettings({
    fit: 'cover', brightness: 1.2, dither: true, dest: 'main',
    bogus: 'nope', mouseX: 5, // unknown -> dropped
  });
  assert.deepEqual(s, { fit: 'cover', brightness: 1.2, dither: true, dest: 'main' });
  for (const k of Object.keys(s)) assert.ok(SETTINGS_KEYS.includes(k));
});

ok('normalizeSettings roundtrips unchanged through JSON (structured-clone-safe primitives)', () => {
  const s = normalizeSettings({ fit: 'contain', fps: 30, grayscale: false, interval: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

ok('normalizeSettings tolerates null/undefined', () => {
  assert.deepEqual(normalizeSettings(), {});
  assert.deepEqual(normalizeSettings(null), {});
});

// ---- record shape -----------------------------------------------------------
ok('makeRecord fills the full shape with defaults', () => {
  const t0 = Date.now();
  const r = makeRecord({ area: 'gif', kind: 'gif', settings: { fps: 24 } });
  assert.equal(r.area, 'gif');
  assert.equal(r.kind, 'gif');
  assert.equal(r.name, 'gif'); // defaults to the area label
  assert.equal(r.sourceBlob, null);
  assert.equal(r.sources, null);
  assert.deepEqual(r.settings, { fps: 24 });
  assert.equal(r.thumbBlob, null);
  assert.equal(r.frameCount, 1);
  assert.equal(r.fps, 0);
  assert.ok(r.pushedAt >= t0);
});

ok('makeRecord preserves an explicit name, sources array, and pushedAt', () => {
  const r = makeRecord({ area: 'picture', name: 'sunset.png', sources: [1, 2, 3], pushedAt: 42 });
  assert.equal(r.name, 'sunset.png');
  assert.deepEqual(r.sources, [1, 2, 3]);
  assert.equal(r.pushedAt, 42);
});

ok('makeRecord settings roundtrip: only whitelisted keys survive', () => {
  const r = makeRecord({ area: 'main', settings: { fit: 'stretch', secret: 'x' } });
  assert.deepEqual(r.settings, { fit: 'stretch' });
});

// ---- recents cap / evict ----------------------------------------------------
const mk = (id, pushedAt, pinned = false) => ({ id, pushedAt, pinned });

ok('capRecents keeps everything when under the cap', () => {
  const list = [mk('a', 3), mk('b', 2), mk('c', 1)];
  const { kept, evicted } = capRecents(list, 24);
  assert.equal(kept.length, 3);
  assert.equal(evicted.length, 0);
});

ok('capRecents evicts the OLDEST unpinned first, down to the cap', () => {
  // 5 items, cap 3 -> evict the 2 oldest unpinned (pushedAt 1 and 2)
  const list = [mk('e', 5), mk('d', 4), mk('c', 3), mk('b', 2), mk('a', 1)];
  const { kept, evicted } = capRecents(list, 3);
  assert.deepEqual(evicted.map((r) => r.id).sort(), ['a', 'b']);
  assert.deepEqual(kept.map((r) => r.id), ['e', 'd', 'c']);
});

ok('capRecents never evicts pinned entries (may exceed the cap)', () => {
  // cap 2, but 3 pinned + 2 unpinned. Only the 2 unpinned can go, leaving 3 pinned > cap.
  const list = [
    mk('p1', 10, true), mk('p2', 9, true), mk('p3', 8, true),
    mk('u1', 7, false), mk('u2', 6, false),
  ];
  const { kept, evicted } = capRecents(list, 2);
  assert.deepEqual(evicted.map((r) => r.id).sort(), ['u1', 'u2']);
  assert.deepEqual(kept.map((r) => r.id).sort(), ['p1', 'p2', 'p3']);
  assert.ok(kept.length > 2); // pinned protection wins over the cap
});

ok('capRecents preserves input order in kept', () => {
  const list = [mk('a', 1), mk('b', 5), mk('c', 2), mk('d', 4)];
  const { kept } = capRecents(list, 3);
  // oldest unpinned is 'a' (pushedAt 1) -> evicted; order of the rest preserved
  assert.deepEqual(kept.map((r) => r.id), ['b', 'c', 'd']);
});

ok('capRecents handles empty / non-array input', () => {
  assert.deepEqual(capRecents([], 5), { kept: [], evicted: [] });
  assert.deepEqual(capRecents(null, 5), { kept: [], evicted: [] });
});

ok('RECENTS_CAP is the documented ~24', () => {
  assert.equal(RECENTS_CAP, 24);
});

// ---- quota detection --------------------------------------------------------
ok('isQuotaError recognizes QuotaExceededError by name and message', () => {
  assert.equal(isQuotaError({ name: 'QuotaExceededError' }), true);
  assert.equal(isQuotaError({ message: 'The quota has been exceeded.' }), true);
  assert.equal(isQuotaError({ name: 'AbortError' }), false);
  assert.equal(isQuotaError(null), false);
});

console.log(`\n${pass} checks passed.`);
