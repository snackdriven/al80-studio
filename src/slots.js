// AL80 Studio — slot cache + recents. Studio's client-side memory of what it PUSHED to each
// LCD area, persisted in IndexedDB so it survives unplugs and reloads.
//
// The LCD is write-only for content — no pixel read-back — so this is a MODEL of what Studio
// sent, never a mirror of the panel. Every surface that shows it must say "last pushed from
// Studio · <time>", not "on the device now". If another app or a reflash changes the screen,
// this record goes stale silently; that's the accepted tradeoff (design doc: chosen B + recents).
//
// We store the ORIGINAL source Blob + the processing settings + a small thumbnail Blob — NOT the
// multi-megabyte RGB565 frames. Re-push re-derives frames from source+settings through the same
// pipeline the Send buttons use.
//
// The pure logic (record shape, recents cap/evict, settings normalization) is exported separately
// from the IndexedDB layer so it can be unit-tested in Node without a DOM or a fake-indexeddb dep.

// ---- constants --------------------------------------------------------------
export const DB_NAME = 'al80studio';
export const DB_VERSION = 1;
export const STORE_SLOTS = 'slots';
export const STORE_RECENTS = 'recents';

// The four content areas Studio can own. Clock is excluded (it's generated, not a pushed asset).
export const SLOT_AREAS = Object.freeze(['main', 'picture', 'gif', 'startup']);

// Recents ring size. Oldest UNPINNED entries evict past this; pinned entries are kept even if that
// pushes the total over the cap.
export const RECENTS_CAP = 24;

// Only these keys are persisted from a settings object — drops transient UI cruft and keeps the
// stored record small and stable. (fit/fps/brightness/contrast/saturation/grayscale/dither/dest
// for images+gifs; interval for slideshows.)
export const SETTINGS_KEYS = Object.freeze([
  'fit', 'fps', 'brightness', 'contrast', 'saturation', 'grayscale', 'gray', 'dither', 'dest', 'interval',
]);

// ---- pure logic (unit-testable, no IndexedDB, no DOM) -----------------------

/** Short unique-ish id for a recent. Time-prefixed so ids sort roughly by creation. */
export function newId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Keep only the known settings keys, in a fresh plain object. Roundtrips through structured clone
 *  / JSON unchanged (values are primitives), so a saved slot reads back settings-equal. */
export function normalizeSettings(settings = {}) {
  const out = {};
  for (const k of SETTINGS_KEYS) {
    if (settings != null && settings[k] !== undefined) out[k] = settings[k];
  }
  return out;
}

/**
 * Build a normalized slot/recent record. Unknown fields are dropped; timestamps and counts default.
 * @param {object} d
 * @returns {object} { area, name, kind, sourceBlob, sources, settings, thumbBlob, frameCount, fps, pushedAt }
 */
export function makeRecord(d = {}) {
  const {
    area = null,
    name = '',
    kind = 'image',
    sourceBlob = null,
    sources = null,        // optional: slideshow keeps its whole file list here
    settings = {},
    thumbBlob = null,
    frameCount = 1,
    fps = 0,
    pushedAt = Date.now(),
  } = d;
  return {
    area,
    name: name || (area ? String(area) : 'untitled'),
    kind,
    sourceBlob,
    sources: Array.isArray(sources) ? sources : null,
    settings: normalizeSettings(settings),
    thumbBlob,
    frameCount,
    fps,
    pushedAt,
  };
}

/**
 * Decide which recents survive the cap. Evicts the OLDEST UNPINNED entries first; pinned entries
 * are never evicted (so a fully-pinned list can exceed the cap). Preserves input order in `kept`.
 * @param {Array<{id:string, pushedAt:number, pinned?:boolean}>} list
 * @param {number} [cap]
 * @returns {{kept: Array, evicted: Array}}
 */
export function capRecents(list, cap = RECENTS_CAP) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (arr.length <= cap) return { kept: arr, evicted: [] };
  const overBy = arr.length - cap;
  // Oldest unpinned first — those are the eviction candidates.
  const candidates = arr
    .filter((r) => !r.pinned)
    .sort((a, b) => (a.pushedAt || 0) - (b.pushedAt || 0));
  const evictIds = new Set(candidates.slice(0, overBy).map((r) => r.id));
  const kept = arr.filter((r) => !evictIds.has(r.id));
  const evicted = arr.filter((r) => evictIds.has(r.id));
  return { kept, evicted };
}

/** True if an error looks like an IndexedDB quota failure (name varies by engine). */
export function isQuotaError(e) {
  if (!e) return false;
  const name = e.name || (e.target && e.target.error && e.target.error.name) || '';
  return name === 'QuotaExceededError' || /quota/i.test(name) || /quota/i.test(e.message || '');
}

// ---- IndexedDB layer (browser only) -----------------------------------------

let dbPromise = null;

function openDB() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SLOTS)) db.createObjectStore(STORE_SLOTS, { keyPath: 'area' });
      if (!db.objectStoreNames.contains(STORE_RECENTS)) db.createObjectStore(STORE_RECENTS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Wrap an IDBRequest as a promise. */
function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function put(store, value) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readwrite').objectStore(store).put(value));
}
async function del(store, key) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}
async function getAll(store) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).getAll());
}
async function getOne(store, key) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).get(key));
}

// ---- slots CRUD -------------------------------------------------------------

/** Read one area's slot record, or null. */
export async function getSlot(area) {
  try { return (await getOne(STORE_SLOTS, area)) || null; }
  catch { return null; }
}

/** Read every stored slot, keyed by area. */
export async function allSlots() {
  try {
    const rows = await getAll(STORE_SLOTS);
    const map = {};
    for (const r of rows) map[r.area] = r;
    return map;
  } catch { return {}; }
}

/**
 * Persist what Studio just pushed to `area`. On quota-exceeded, retries WITHOUT the source blob
 * (and without the slideshow `sources`) — the thumbnail + settings are tiny, so the card still
 * displays, it just can't re-derive frames (re-push falls back to "source dropped").
 */
export async function saveSlot(area, data) {
  const rec = makeRecord({ ...data, area });
  try {
    await put(STORE_SLOTS, rec);
    return rec;
  } catch (e) {
    if (isQuotaError(e)) {
      const lite = { ...rec, sourceBlob: null, sources: null, sourceDropped: true };
      try { await put(STORE_SLOTS, lite); return lite; }
      catch { return lite; } // display-in-memory still works even if the write ultimately fails
    }
    throw e;
  }
}

/** Delete one area's slot record. */
export async function clearSlot(area) {
  try { await del(STORE_SLOTS, area); } catch { /* ignore */ }
}

// ---- recents ----------------------------------------------------------------

/** All recents, newest first. */
export async function listRecents() {
  try {
    const rows = await getAll(STORE_RECENTS);
    rows.sort((a, b) => (b.pushedAt || 0) - (a.pushedAt || 0));
    return rows;
  } catch { return []; }
}

/**
 * Record a push in the recents ring. De-dupes by (area + name + kind): an existing UNPINNED match
 * is refreshed in place (new thumb + timestamp) rather than duplicated. Then trims to the cap,
 * evicting oldest unpinned. Quota-safe like saveSlot.
 */
export async function addRecent(data) {
  const base = makeRecord(data);
  let rows = [];
  try { rows = await getAll(STORE_RECENTS); } catch { /* fresh */ }
  const dupe = rows.find((r) => !r.pinned && r.area === base.area && r.name === base.name && r.kind === base.kind);
  const rec = {
    ...base,
    id: (dupe && dupe.id) || data.id || newId(),
    pinned: dupe ? !!dupe.pinned : !!data.pinned,
  };
  try {
    await put(STORE_RECENTS, rec);
  } catch (e) {
    if (isQuotaError(e)) {
      const lite = { ...rec, sourceBlob: null, sources: null, sourceDropped: true };
      try { await put(STORE_RECENTS, lite); } catch { /* ignore */ }
      await evictRecents();
      return lite;
    }
    throw e;
  }
  await evictRecents();
  return rec;
}

/** Set/clear the pinned flag on a recent so the cap can't evict it. */
export async function pinRecent(id, pinned = true) {
  const rec = await getOne(STORE_RECENTS, id);
  if (!rec) return null;
  rec.pinned = !!pinned;
  await put(STORE_RECENTS, rec);
  return rec;
}

/** Remove one recent by id. */
export async function removeRecent(id) {
  try { await del(STORE_RECENTS, id); } catch { /* ignore */ }
}

/** Trim recents to the cap, evicting oldest unpinned. Returns the evicted rows. */
export async function evictRecents(cap = RECENTS_CAP) {
  let rows = [];
  try { rows = await getAll(STORE_RECENTS); } catch { return []; }
  const { evicted } = capRecents(rows, cap);
  for (const r of evicted) await removeRecent(r.id);
  return evicted;
}

// ---- thumbnail helpers (browser only) ---------------------------------------

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('thumb: image load failed'));
    im.src = url;
  });
}

/** Downscale a drawable to a bounded PNG Blob (keeps aspect; longest side <= maxDim). */
function downscaleToBlob(drawable, sw, sh, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(sw || maxDim, sh || maxDim));
  const w = Math.max(1, Math.round((sw || maxDim) * scale));
  const h = Math.max(1, Math.round((sh || maxDim) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(drawable, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

/** Thumbnail from an ImageData (e.g. a decoded frame 0). Returns a PNG Blob. */
export async function thumbFromImageData(imageData, maxDim = 128) {
  const full = document.createElement('canvas');
  full.width = imageData.width;
  full.height = imageData.height;
  full.getContext('2d').putImageData(imageData, 0, 0);
  return downscaleToBlob(full, imageData.width, imageData.height, maxDim);
}

/** Thumbnail from a Blob/File, a data-URL string, or any drawable. Returns a PNG Blob. */
export async function thumbFromSource(source, maxDim = 128) {
  if (source == null) return null;
  if (typeof source === 'string') {
    const im = await loadImage(source);
    return downscaleToBlob(im, im.naturalWidth, im.naturalHeight, maxDim);
  }
  if (source instanceof Blob) {
    const bmp = await createImageBitmap(source);
    try { return await downscaleToBlob(bmp, bmp.width, bmp.height, maxDim); }
    finally { bmp.close && bmp.close(); }
  }
  // assume a drawable (HTMLImageElement / canvas / ImageBitmap)
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  return downscaleToBlob(source, sw, sh, maxDim);
}

/** Make an object URL for a stored thumb Blob (caller revokes when replacing/removing). */
export function thumbURL(blob) {
  return blob ? URL.createObjectURL(blob) : null;
}
