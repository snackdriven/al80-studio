// nowplaying panel — Panel interface (see cycle.js / the auto-cycle SPARC A2). Owns the Spotify
// poll (PKCE token cache, currentTrack, art cache/decode, idle+pause bookkeeping) on its OWN
// cadence, decoupled from the cycler's dwell. Extracted from nowplaying-run.mjs (Phase 0 refactor)
// — same PKCE/token/art logic, unchanged. NEVER touches `dev`; the cycler owns every device call.
import { render } from '../apps/nowplaying.js';
import { getAccessToken, getNowPlaying, getNowPlayingMock } from '../lib/spotify.js';
import { decodeToRGB96, dominantColor } from '../lib/art.js';
import { writeFileSync } from 'node:fs';

const PAUSE_HOME_MS = 5 * 60 * 1000; // after this long paused, drop (available()=false) -> rest on clock/weather
const ART_CACHE_MAX = 50; // bound memory on a long-running host — drop the oldest past this

async function fetchArtRGB(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`art HTTP ${res.status}`);
    return decodeToRGB96(Buffer.from(await res.arrayBuffer()));
  } catch (e) { console.log('[nowplaying] art:', e.message); return null; }
}

function progressOf(np) {
  if (typeof np.progress === 'number') return np.progress;
  const elapsed = np.elapsedMs ?? np.progressMs ?? 0;
  return np.durationMs ? Math.max(0, Math.min(1, elapsed / np.durationMs)) : 0;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.live=false]  real Spotify (PKCE) vs the credential-free mock track
 * @param {object}  [opts.env=process.env]
 * @param {URL}     [opts.envPath]     where to persist a rotated refresh token (defaults host/.env)
 * @param {() => number} [opts.now=Date.now]
 */
export function makeNowPlayingPanel({ live = false, env = process.env, envPath, now = () => Date.now() } = {}) {
  const ENV_PATH = envPath || new URL('../.env', import.meta.url);
  let tokenCache = null; // { accessToken, expiresAt } — access tokens last ~1h; don't refresh every poll
  const artCache = new Map(); // trackId -> { artRGB, hueSat }
  function cacheArt(id, val) {
    artCache.set(id, val);
    if (artCache.size > ART_CACHE_MAX) artCache.delete(artCache.keys().next().value);
  }

  // PKCE rotates the refresh token on every refresh (Spotify docs): cache the access token, refresh
  // only near expiry, and persist any rotated refresh token immediately.
  async function accessToken() {
    if (tokenCache && now() < tokenCache.expiresAt - 60_000) return tokenCache.accessToken;
    const t = await getAccessToken(env); // throws on invalid_grant (expired/revoked)
    tokenCache = { accessToken: t.accessToken, expiresAt: now() + (t.expiresInSec || 3600) * 1000 };
    if (t.refreshToken && t.refreshToken !== env.SPOTIFY_REFRESH_TOKEN) {
      env.SPOTIFY_REFRESH_TOKEN = t.refreshToken;
      try { writeFileSync(ENV_PATH, `SPOTIFY_CLIENT_ID=${env.SPOTIFY_CLIENT_ID}\nSPOTIFY_REFRESH_TOKEN=${t.refreshToken}\n`); }
      catch (e) { console.log('[nowplaying] could not persist rotated refresh token:', e.message); }
    }
    return tokenCache.accessToken;
  }

  async function currentTrack() {
    if (!live) return getNowPlayingMock(now());
    let tok;
    try { tok = await accessToken(); }
    catch (e) {
      if (/invalid_grant/i.test(e.message)) {
        // [CORRECTION vs the runner] a cycler must not die because one panel's creds lapsed — degrade
        // the panel (available()=false, rotate away) instead of process.exit(1).
        console.log('[nowplaying] refresh token expired or revoked — re-auth with: node spotify-auth.mjs <clientId>');
        return null;
      }
      console.log('[nowplaying]', e.message); return null;
    }
    try { return await getNowPlaying(tok); }
    catch (e) {
      if (/\b401\b/.test(e.message)) { tokenCache = null; return null; } // expired mid-cache; force one refresh
      console.log('[nowplaying]', e.message); return null;
    }
  }

  let state = null;        // { title, artist, artRGB, progress, paused, elapsedMs, durationMs }
  let lastTrackId = null;
  let pausedSince = null;
  let wantsFocusFlag = false;

  return {
    id: 'nowplaying',
    page: 'picture',
    dwellMs: 30000,

    async poll() {
      let np = null;
      try { np = await currentTrack(); } catch (e) { console.log('[nowplaying] poll:', e.message); }
      if (np && np.title) {
        pausedSince = np.paused ? (pausedSince ?? now()) : null;
        let cached = artCache.get(np.trackId);
        if (!cached) {
          const artRGB = await fetchArtRGB(np.artUrl);
          cached = { artRGB, hueSat: artRGB ? dominantColor(artRGB) : null };
          cacheArt(np.trackId, cached);
        }
        state = {
          title: np.title, artist: np.artist, artRGB: cached.artRGB,
          progress: progressOf(np), paused: np.paused,
          elapsedMs: np.elapsedMs, durationMs: np.durationMs,
          _hueSat: cached.hueSat, _trackId: np.trackId,
        };
        if (np.trackId !== lastTrackId) { wantsFocusFlag = true; lastTrackId = np.trackId; }
      } else {
        state = null;
        pausedSince = null;
      }
    },

    available() {
      if (state == null) return false;
      if (state.paused && pausedSince != null && now() - pausedSince >= PAUSE_HOME_MS) return false; // FR4-adjacent: long-paused -> drop
      return true;
    },

    stale() { return false; }, // Spotify's 5s poll owns freshness (SPARC A2)

    wantsFocus() { const w = wantsFocusFlag; wantsFocusFlag = false; return w; }, // consume-once (FR5)

    render() { return render(state || {}); },

    /** Hue/sat seed for Phase-3 RGB sync — not consumed by the Phase 1/2 cycler. */
    rgb() { return state?._hueSat ? { hue: Math.round((state._hueSat.hue / 360) * 255), sat: Math.round(state._hueSat.sat * 255) } : null; },
  };
}
