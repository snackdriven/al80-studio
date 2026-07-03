// Spotify "currently playing" source for the now-playing app. Zero-dep: global fetch (Node 18+) and
// node:crypto for PKCE. No secrets baked in — a desktop app that can't keep a secret uses the PKCE
// flow (Authorization Code with Proof Key for Code Exchange), so there is NO client secret anywhere
// in this file. You register an app, drop in its Client ID, authorize once, and store the refresh
// token. There's also a MOCK mode so the whole render pipeline runs with zero credentials.
//
// ── ONE-TIME OAUTH SETUP (PKCE — no client secret) ────────────────────────────────────────────────
//   1. Create an app at https://developer.spotify.com/dashboard.
//        - Note the Client ID.  (You do NOT need the Client Secret for PKCE.)
//        - Add a Redirect URI, e.g. http://127.0.0.1:8888/callback, and save.
//   2. >>> TODO: put your Client ID here (or in env SPOTIFY_CLIENT_ID). It is not a secret; it ships
//        in the auth URL. The refresh token IS sensitive — keep that in env/.env, never in git. <<<
//   3. Authorize once (PKCE auth-code flow):
//        const verifier  = generateCodeVerifier();
//        const challenge = await codeChallenge(verifier);
//        const url = buildAuthUrl({ clientId, redirectUri, codeChallenge: challenge });
//      Open `url` in a browser, approve. Spotify redirects to <redirectUri>?code=AUTH_CODE&state=...
//      Copy AUTH_CODE, then exchange it (same `verifier` from this run):
//        const tok = await exchangeCodeForToken({ clientId, code: AUTH_CODE, redirectUri, codeVerifier: verifier });
//      `tok.refreshToken` is the long-lived credential. Save it.
//   4. Put these in env (or .env loaded by the daemon):
//        SPOTIFY_CLIENT_ID, SPOTIFY_REFRESH_TOKEN
//
// From then on getAccessToken() trades the refresh token for a short-lived access token (no human
// step, no secret), and getNowPlaying(token) reads what's playing.

import { createHash, randomBytes } from 'node:crypto';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const NOW_PLAYING_URL = 'https://api.spotify.com/v1/me/player/currently-playing';

// Reading "what's playing" only needs these two scopes.
export const DEFAULT_SCOPES = ['user-read-currently-playing', 'user-read-playback-state'];

// ── PKCE HELPERS ──────────────────────────────────────────────────────────────────────────────────

/** base64url (RFC 4648 §5): standard base64 with +/ -> -_ and no '=' padding. */
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A high-entropy PKCE code verifier: 43–128 chars from the unreserved set. We emit 64 base64url
 * chars from 48 random bytes. Keep it for the duration of one authorize->exchange round trip.
 * @returns {string}
 */
export function generateCodeVerifier() {
  return base64url(randomBytes(48)); // 48 bytes -> 64 base64url chars
}

/**
 * S256 code challenge for a verifier: base64url(SHA256(verifier)). Async only to keep a uniform
 * signature with WebCrypto ports; the work is synchronous under the hood.
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function codeChallenge(verifier) {
  return base64url(createHash('sha256').update(verifier).digest());
}

/**
 * Build the Spotify authorize URL the user opens once to grant access.
 * @param {object} p
 * @param {string} p.clientId
 * @param {string} p.redirectUri      must EXACTLY match a Redirect URI registered on the app
 * @param {string} p.codeChallenge    from codeChallenge(generateCodeVerifier())
 * @param {string[]} [p.scopes]
 * @param {string} [p.state]          opaque CSRF token you verify on the callback
 * @returns {string} full https URL
 */
export function buildAuthUrl({ clientId, redirectUri, codeChallenge, scopes = DEFAULT_SCOPES, state }) {
  if (!clientId) throw new Error('spotify.js: buildAuthUrl needs a clientId (register an app, see header TODO).');
  if (!redirectUri) throw new Error('spotify.js: buildAuthUrl needs a redirectUri matching your app config.');
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

/** Normalize Spotify's token JSON to our camelCase shape. */
function shapeToken(j) {
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,      // present on code exchange; sometimes rotated on refresh
    expiresInSec: j.expires_in,
    scope: j.scope,
    tokenType: j.token_type,
  };
}

/**
 * Exchange the one-time authorization code for tokens (PKCE — sends code_verifier, no secret).
 * @param {object} p
 * @param {string} p.clientId
 * @param {string} p.code           the AUTH_CODE from the redirect
 * @param {string} p.redirectUri    same value used in buildAuthUrl
 * @param {string} p.codeVerifier   the verifier whose challenge you sent to buildAuthUrl
 * @returns {Promise<{accessToken,refreshToken,expiresInSec,scope,tokenType}>}
 */
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
  if (!res.ok) throw new Error(`spotify.js: code exchange failed ${res.status} ${await res.text()}`);
  return shapeToken(await res.json());
}

/**
 * Mint a fresh access token from the stored refresh token (PKCE refresh — client_id, no secret).
 * Spotify MAY return a new refresh_token; if it does, persist it (shapeToken surfaces it).
 * @param {object} p
 * @param {string} p.clientId
 * @param {string} p.refreshToken
 * @returns {Promise<{accessToken,refreshToken,expiresInSec,scope,tokenType}>}
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
  if (!res.ok) throw new Error(`spotify.js: token refresh failed ${res.status} ${await res.text()}`);
  return shapeToken(await res.json());
}

/**
 * Daemon-facing convenience: read SPOTIFY_CLIENT_ID + SPOTIFY_REFRESH_TOKEN from env and refresh.
 * Cache the returned accessToken until ~expiresInSec on the caller side (the daemon does this).
 * @param {object} [env=process.env]
 * @returns {Promise<{accessToken:string, expiresInSec:number}>}
 */
export async function getAccessToken(env = process.env) {
  const { SPOTIFY_CLIENT_ID: clientId, SPOTIFY_REFRESH_TOKEN: refreshToken } = env;
  if (!clientId || !refreshToken) {
    throw new Error('spotify.js: set SPOTIFY_CLIENT_ID and SPOTIFY_REFRESH_TOKEN (see header for one-time PKCE setup). For a credential-free run use getNowPlayingMock().');
  }
  const { accessToken, expiresInSec } = await refreshAccessToken({ clientId, refreshToken });
  return { accessToken, expiresInSec };
}

// ── NOW PLAYING ─────────────────────────────────────────────────────────────────────────────────

/** Pick the album image nearest ~targetPx (Spotify returns 640/300/64). */
function pickArtUrl(images, targetPx = 300) {
  if (!Array.isArray(images) || images.length === 0) return null;
  return images
    .slice()
    .sort((a, b) => Math.abs((a.width || 0) - targetPx) - Math.abs((b.width || 0) - targetPx))[0].url;
}

/**
 * GET the user's currently-playing track, normalized to the now-playing state shape (minus artRGB —
 * that comes from downloading artUrl and running it through art.decodeToRGB96).
 * @param {string} accessToken  a user access token from getAccessToken()
 * @returns {Promise<null | {title,artist,artUrl,trackId,progress,progressMs,elapsedMs,durationMs,paused}>}
 *          null when nothing is playing (204) or the item isn't a track (ad/podcast).
 */
export async function getNowPlaying(accessToken) {
  const res = await fetch(NOW_PLAYING_URL, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (res.status === 204) return null;          // nothing playing
  if (res.status === 401) throw new Error('spotify.js: 401 — access token expired/invalid, refresh it.');
  if (!res.ok) throw new Error(`spotify.js: currently-playing failed ${res.status} ${await res.text()}`);

  const data = await res.json();
  const item = data.item;
  if (!item || !item.album) return null;        // ad break or non-track item

  const elapsedMs = data.progress_ms ?? 0;
  const durationMs = item.duration_ms ?? 0;
  return {
    title: item.name,
    artist: (item.artists || []).map((a) => a.name).join(', '),
    artUrl: pickArtUrl(item.album.images, 300),
    trackId: item.id,                            // cache key for the decoded artRGB
    progress: durationMs ? elapsedMs / durationMs : 0,
    progressMs: elapsedMs,                        // alias — some callers want the raw ms
    elapsedMs,
    durationMs,
    paused: !data.is_playing,
  };
}

/**
 * Mock now-playing — same shape as getNowPlaying, zero network, zero credentials. Lets the render
 * pipeline (and the previews) run with nothing configured. Pass a wall-clock ms to make the bar
 * "play" (progress advances, wraps at the end); omit it for a fixed, deterministic sample.
 * @param {number} [nowMs]  e.g. Date.now() to animate; default gives a stable mid-track frame.
 * @returns {{title,artist,artUrl,trackId,progress,progressMs,elapsedMs,durationMs,paused}}
 */
export function getNowPlayingMock(nowMs) {
  const durationMs = 369_000;                    // ~6:09
  const elapsedMs = nowMs == null ? 129_000 : nowMs % durationMs; // fixed 2:09, or animated
  return {
    title: 'Get Lucky',
    artist: 'Daft Punk, Pharrell Williams, Nile Rodgers',
    artUrl: null,                                // no download in mock; previews supply artRGB directly
    trackId: 'mock-get-lucky',
    progress: elapsedMs / durationMs,
    progressMs: elapsedMs,
    elapsedMs,
    durationMs,
    paused: false,
  };
}
