// Spotify "currently playing" source for the in-app now-playing card — the browser PKCE port of
// host/lib/spotify.js. No client secret (public PKCE app). Uses WebCrypto (crypto.subtle) instead of
// node:crypto, and browser fetch. The pure helpers (base64url, buildAuthUrl, parseNowPlaying,
// needsRefresh, pickArtUrl) touch no DOM/network so they unit-test under Node too.
//
// AUTH FLOW (Authorization Code + PKCE, entirely in the browser):
//   1. generateCodeVerifier() + codeChallenge() -> redirect the tab to buildAuthUrl(...).
//   2. Spotify redirects back to REDIRECT_URI?code=...&state=...; exchangeCodeForToken() trades the
//      code (with the stored verifier) for {accessToken, refreshToken, expiresInSec}.
//   3. PKCE ROTATES the refresh token on every refresh — persist the newest one (localStorage) and
//      never reuse the old (reuse gets it revoked). Cache the access token ~1h; refresh near expiry
//      or on a 401.

// Public PKCE client id (ships in the auth URL — not a secret). Scopes: read what's playing.
export const CLIENT_ID = '4d8da9ff46054c45934a9f508d6928a8';
export const DEFAULT_SCOPES = ['user-read-currently-playing', 'user-read-playback-state'];

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const NOW_PLAYING_URL = 'https://api.spotify.com/v1/me/player/currently-playing';

// ── PKCE HELPERS ────────────────────────────────────────────────────────────────────────────────

/** base64url (RFC 4648 §5): standard base64 with +/ -> -_ and no '=' padding. */
export function base64url(bytes) {
  let bin = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** High-entropy PKCE code verifier: 64 base64url chars from 48 random bytes. */
export function generateCodeVerifier() {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** S256 code challenge for a verifier: base64url(SHA256(verifier)). */
export async function codeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}

/**
 * Build the Spotify authorize URL the user opens once to grant access.
 * @param {{clientId,redirectUri,codeChallenge,scopes?,state?}} p
 * @returns {string} full https URL
 */
export function buildAuthUrl({ clientId, redirectUri, codeChallenge, scopes = DEFAULT_SCOPES, state }) {
  if (!clientId) throw new Error('spotify: buildAuthUrl needs a clientId.');
  if (!redirectUri) throw new Error('spotify: buildAuthUrl needs a redirectUri.');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    scope: scopes.join(' '),
  });
  if (state) q.set('state', state);
  return `${AUTH_URL}?${q.toString()}`;
}

/** The exact redirect URI this app registers/uses: origin + path (no query/hash). Browser-only. */
export function redirectUri() {
  return window.location.origin + window.location.pathname;
}

/** Normalize Spotify's token JSON to our camelCase shape. */
function shapeToken(j) {
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,   // present on exchange; rotated on refresh (PKCE)
    expiresInSec: j.expires_in,
    scope: j.scope,
    tokenType: j.token_type,
  };
}

/** Exchange the one-time authorization code for tokens (sends code_verifier, no secret). */
export async function exchangeCodeForToken({ clientId, code, redirectUri, codeVerifier }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`spotify: code exchange failed ${res.status} ${await res.text()}`);
  return shapeToken(await res.json());
}

/**
 * Mint a fresh access token from the stored refresh token (PKCE refresh — client_id, no secret).
 * Spotify usually returns a NEW refresh_token; the caller must persist it.
 * @returns {Promise<{accessToken,refreshToken,expiresInSec,...}>}
 */
export async function refreshAccessToken({ clientId, refreshToken }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`spotify: token refresh failed ${res.status} ${body}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  const t = shapeToken(await res.json());
  // Fall back to the old refresh token if the response didn't rotate (some refreshes omit it).
  return { ...t, refreshToken: t.refreshToken || refreshToken };
}

// ── TOKEN-EXPIRY DECISION (pure) ──────────────────────────────────────────────────────────────

/**
 * Should we mint a new access token? True when we have none, or it's within `skewMs` of expiry.
 * Access tokens last ~1h; refreshing every poll would rotate the refresh token needlessly and risk
 * revocation, so we only refresh near expiry (or on a 401, handled by the caller).
 * @param {{accessToken?:string, expiresAt?:number}} state
 * @param {number} now   Date.now()
 * @param {number} [skewMs=60000]
 * @returns {boolean}
 */
export function needsRefresh(state, now, skewMs = 60_000) {
  if (!state || !state.accessToken || !state.expiresAt) return true;
  return now >= state.expiresAt - skewMs;
}

// ── NOW PLAYING ─────────────────────────────────────────────────────────────────────────────────

/** Pick the album image nearest ~targetPx (Spotify returns 640/300/64). */
export function pickArtUrl(images, targetPx = 300) {
  if (!Array.isArray(images) || images.length === 0) return null;
  return images
    .slice()
    .sort((a, b) => Math.abs((a.width || 0) - targetPx) - Math.abs((b.width || 0) - targetPx))[0].url;
}

/**
 * Parse the currently-playing JSON body into our card state (pure — no network).
 * @param {object|null} data   parsed body of /me/player/currently-playing, or null for 204
 * @returns {null | {title,artist,artUrl,trackId,isPlaying,progress,elapsedMs,durationMs}}
 *          null when nothing is playing or the item isn't a track (ad/podcast).
 */
export function parseNowPlaying(data) {
  if (!data) return null;
  const item = data.item;
  if (!item || !item.album) return null;
  const elapsedMs = data.progress_ms ?? 0;
  const durationMs = item.duration_ms ?? 0;
  return {
    title: item.name,
    artist: (item.artists || []).map((a) => a.name).join(', '),
    artUrl: pickArtUrl(item.album.images, 300),
    trackId: item.id,
    isPlaying: !!data.is_playing,
    progress: durationMs ? elapsedMs / durationMs : 0,
    elapsedMs,
    durationMs,
  };
}

/**
 * GET the user's currently-playing track, normalized. Throws {status:401} on an expired token so
 * the caller can force one refresh + retry.
 * @param {string} accessToken  the access-token STRING (Bearer <token>)
 * @returns {Promise<null | ReturnType<typeof parseNowPlaying>>}
 */
export async function getNowPlaying(accessToken) {
  const res = await fetch(NOW_PLAYING_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 204) return null;            // nothing playing
  if (res.status === 401) { const e = new Error('spotify: 401 — access token expired'); e.status = 401; throw e; }
  if (!res.ok) throw new Error(`spotify: currently-playing failed ${res.status} ${await res.text()}`);
  return parseNowPlaying(await res.json());
}

// ── TOKEN + PKCE STATE PERSISTENCE (localStorage; browser-only) ──────────────────────────────────

const LS_REFRESH = 'al80.spotify.refreshToken';
const LS_VERIFIER = 'al80.spotify.pkceVerifier';
const LS_STATE = 'al80.spotify.authState';

export function loadRefreshToken() { try { return localStorage.getItem(LS_REFRESH) || null; } catch { return null; } }
export function saveRefreshToken(t) { try { if (t) localStorage.setItem(LS_REFRESH, t); } catch { /* private mode */ } }
export function clearRefreshToken() { try { localStorage.removeItem(LS_REFRESH); } catch { /* ignore */ } }

// The verifier + state must survive the redirect round-trip (full page navigation to Spotify + back).
export function savePendingAuth(verifier, state) {
  try { localStorage.setItem(LS_VERIFIER, verifier); localStorage.setItem(LS_STATE, state); } catch { /* ignore */ }
}
export function loadPendingAuth() {
  try { return { verifier: localStorage.getItem(LS_VERIFIER), state: localStorage.getItem(LS_STATE) }; }
  catch { return { verifier: null, state: null }; }
}
export function clearPendingAuth() {
  try { localStorage.removeItem(LS_VERIFIER); localStorage.removeItem(LS_STATE); } catch { /* ignore */ }
}
