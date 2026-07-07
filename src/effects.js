// AL80 Studio — RGB effect catalog + curation logic. Pure, no DOM, no HID. Node-unit-testable.
//
// Single source of truth for the Lighting tab's built-in effect list. BOTH the #lightEffect
// dropdown and the "Customize effects" toggle list render from EFFECT_CATALOG, so they can't
// drift. The ids are the VialRGB effect ids (see VIALRGB_EFFECT in protocol.js); PALETTE_CYCLE
// is the al80's own custom id 256 (0x0100). Names match the historical dropdown text exactly.
//
// The user curates which effects show in the dropdown (display-only — the firmware still supports
// every effect; nothing about the send path or protocol changes). The enabled-id set persists in
// localStorage under STORAGE_KEY. Default is ALL enabled (nothing hidden until the user opts in).

export const STORAGE_KEY = 'al80.effects.enabled';

// Category order == dropdown order. Each catalog entry belongs to exactly one category.
export const EFFECT_CATEGORIES = Object.freeze([
  { key: 'basic', label: 'Basic / color' },
  { key: 'rainbow', label: 'Rainbow / hue cycles' },
  { key: 'reactive', label: 'Reactive (keypress)' },
  { key: 'splash', label: 'Splash (keypress)' },
  { key: 'rain', label: 'Rain' },
]);

// The catalog, in dropdown order. { id, name, category }. Names preserved verbatim from the
// original hardcoded <option>s — don't renumber, don't rename.
export const EFFECT_CATALOG = Object.freeze([
  // Basic / color — respect the chosen color.
  { id: 0, name: 'All Off', category: 'basic' },
  { id: 2, name: 'Solid Color', category: 'basic' },
  { id: 6, name: 'Breathing', category: 'basic' },
  { id: 8, name: 'Band Value', category: 'basic' },
  { id: 21, name: 'Dual Beacon', category: 'basic' },
  { id: 256, name: 'Palette Cycle (al80 custom)', category: 'basic' },
  // Rainbow / hue cycles — ignore the chosen color.
  { id: 13, name: 'Cycle All', category: 'rainbow' },
  { id: 14, name: 'Cycle Left/Right', category: 'rainbow' },
  { id: 15, name: 'Cycle Up/Down', category: 'rainbow' },
  { id: 17, name: 'Cycle Out/In', category: 'rainbow' },
  { id: 19, name: 'Cycle Pinwheel', category: 'rainbow' },
  { id: 20, name: 'Cycle Spiral', category: 'rainbow' },
  { id: 16, name: 'Rainbow Moving Chevron', category: 'rainbow' },
  { id: 22, name: 'Rainbow Beacon', category: 'rainbow' },
  { id: 26, name: 'Hue Breathing', category: 'rainbow' },
  { id: 28, name: 'Hue Wave', category: 'rainbow' },
  // Reactive — react to keypress.
  { id: 31, name: 'Reactive Simple (react to keypress)', category: 'reactive' },
  { id: 32, name: 'Reactive', category: 'reactive' },
  { id: 33, name: 'Reactive Wide', category: 'reactive' },
  { id: 34, name: 'Reactive Multi-Wide', category: 'reactive' },
  { id: 35, name: 'Reactive Cross', category: 'reactive' },
  { id: 36, name: 'Reactive Multi-Cross', category: 'reactive' },
  { id: 37, name: 'Reactive Nexus', category: 'reactive' },
  { id: 38, name: 'Reactive Multi-Nexus', category: 'reactive' },
  // Splash — react to keypress.
  { id: 39, name: 'Splash (react to keypress)', category: 'splash' },
  { id: 40, name: 'Multi-Splash', category: 'splash' },
  { id: 41, name: 'Solid Splash', category: 'splash' },
  { id: 42, name: 'Solid Multi-Splash', category: 'splash' },
  // Rain.
  { id: 24, name: 'Raindrops', category: 'rain' },
  { id: 30, name: 'Digital Rain', category: 'rain' },
  { id: 43, name: 'Pixel Rain', category: 'rain' },
]);

const ID_SET = new Set(EFFECT_CATALOG.map((e) => e.id));

/** Every catalog id, in catalog order. */
export const ALL_IDS = Object.freeze(EFFECT_CATALOG.map((e) => e.id));

// "Recommended": the color/reactive/splash effects that use the chosen color, one rain, one rainbow.
// 0 All Off, 2 Solid Color, 6 Breathing, 21 Dual Beacon, 256 Palette Cycle, 31 Reactive Simple,
// 39 Splash, 41 Solid Splash, 30 Digital Rain, 13 Cycle All.
export const RECOMMENDED_IDS = Object.freeze([0, 2, 6, 21, 256, 31, 39, 41, 30, 13]);

/** True if `id` is a real catalog effect id. */
export const isEffectId = (id) => ID_SET.has(Number(id));

/** Catalog entries in a category, in catalog order. */
export function effectsInCategory(key) {
  return EFFECT_CATALOG.filter((e) => e.category === key);
}
/** Ids in a category, in catalog order. */
export function idsInCategory(key) {
  return effectsInCategory(key).map((e) => e.id);
}

/** Catalog entries whose id is in `set`, in catalog order — the dropdown's contents. */
export function filterEnabled(set) {
  return EFFECT_CATALOG.filter((e) => set.has(e.id));
}

/** Serialize an enabled-id set to a stable JSON string (sorted, catalog ids only). */
export function serializeEnabled(set) {
  return JSON.stringify([...set].filter((id) => ID_SET.has(id)).sort((a, b) => a - b));
}

/**
 * Parse a stored enabled-id string back to a Set of valid ids. Unknown ids are dropped.
 * Returns null when there's nothing usable (null/garbage/empty) so the caller can fall back to
 * the default (all enabled).
 */
export function parseEnabled(raw) {
  if (!raw) return null;
  let arr;
  try { arr = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const valid = arr.map(Number).filter((id) => ID_SET.has(id));
  return valid.length ? new Set(valid) : null;
}

/** Never let the dropdown go empty: an empty/invalid set falls back to Recommended. */
export function guardEnabled(set) {
  if (set && set.size > 0) return set;
  return new Set(RECOMMENDED_IDS);
}

/**
 * Pick the dropdown's selected id: keep `currentId` if it's still enabled, otherwise the first
 * enabled effect in catalog order. Falls back to the first catalog id if `set` is somehow empty.
 */
export function pickSelected(set, currentId) {
  if (set.has(Number(currentId))) return Number(currentId);
  const first = EFFECT_CATALOG.find((e) => set.has(e.id));
  return first ? first.id : EFFECT_CATALOG[0].id;
}
