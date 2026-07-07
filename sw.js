// Service worker — network-first, no-store for same-origin GETs, so a normal reload always pulls
// the freshest HTML/JS/CSS. This app has no build step and no per-file version query, so the
// browser used to serve stale ES modules after a deploy; this fixes that without version-bumping.
// A cached copy is kept only as an offline fallback. Cross-origin requests (Spotify API, album
// art) are left completely alone.
const FALLBACK = 'al80-fallback-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // Spotify etc. pass straight through
  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(FALLBACK).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
