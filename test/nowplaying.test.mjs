// Now-playing pure-logic tests — no hardware, no Spotify network. Covers the PKCE helpers,
// the token-expiry decision, the currently-playing JSON parse, and that the card renderer produces
// a valid buildImageTransfer-ready frame. Run: node test/nowplaying.test.mjs
import assert from 'node:assert/strict';
import {
  base64url, generateCodeVerifier, codeChallenge, buildAuthUrl, DEFAULT_SCOPES, needsRefresh, pickArtUrl, parseNowPlaying, CLIENT_ID, refreshAccessToken, getNowPlaying, exchangeCodeForToken, clearPendingAuth
} from '../src/nowplaying/spotify.js';
import { render as renderCard } from '../src/nowplaying/card.js';
import { buildImageTransfer, FRAME_BYTES } from '../src/protocol.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };
const okAsync = async (name, fn) => { await fn(); pass++; console.log('  ok -', name); };

console.log('Now Playing pure-logic tests\n');

// ── PKCE ──────────────────────────────────────────────────────────────────────
ok('base64url encodes bytes with -_ alphabet and no padding', () => {
  // 0xFB 0xFF 0xFE -> standard base64 "+//+", base64url "-__-"
  assert.equal(base64url(new Uint8Array([0xfb, 0xff, 0xfe])), '-__-');
  // no '=' padding ever
  assert.equal(/[+/=]/.test(base64url(new Uint8Array([1, 2, 3, 4, 5]))), false);
});

ok('generateCodeVerifier is 43-128 chars from the unreserved set', () => {
  const v = generateCodeVerifier();
  assert.ok(v.length >= 43 && v.length <= 128, `verifier length ${v.length} out of PKCE range`);
  assert.match(v, /^[A-Za-z0-9\-_]+$/);
  assert.notEqual(v, generateCodeVerifier()); // random each call
});

await okAsync('codeChallenge matches the RFC 7636 S256 test vector', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(await codeChallenge(verifier), expected);
});

ok('buildAuthUrl carries client_id, redirect, S256 challenge, scopes, state', () => {
  const url = buildAuthUrl({
    clientId: CLIENT_ID, redirectUri: 'https://example.test/app/', codeChallenge: 'CHAL', state: 'xyz',
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://example.test/app/');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code_challenge'), 'CHAL');
  assert.equal(u.searchParams.get('state'), 'xyz');
  assert.equal(u.searchParams.get('scope'), DEFAULT_SCOPES.join(' '));
});

ok('buildAuthUrl throws without clientId or redirectUri', () => {
  assert.throws(() => buildAuthUrl({ redirectUri: 'x', codeChallenge: 'c' }));
  assert.throws(() => buildAuthUrl({ clientId: 'x', codeChallenge: 'c' }));
});

// ── TOKEN REFRESH ───────────────────────────────────────────────────────────────
await okAsync('refreshAccessToken uses the new refresh token if Spotify rotates it', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://accounts.spotify.com/api/token');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');

    // URLSearchParams from body string
    const bodyParams = new URLSearchParams(init.body);
    assert.equal(bodyParams.get('grant_type'), 'refresh_token');
    assert.equal(bodyParams.get('refresh_token'), 'old-rt');
    assert.equal(bodyParams.get('client_id'), 'test-client');

    return {
      ok: true,
      json: async () => ({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    };
  };

  try {
    const t = await refreshAccessToken({ clientId: 'test-client', refreshToken: 'old-rt' });
    assert.equal(t.accessToken, 'new-at');
    assert.equal(t.refreshToken, 'new-rt');
    assert.equal(t.expiresInSec, 3600);
    assert.equal(t.tokenType, 'Bearer');
  } finally {
    global.fetch = originalFetch;
  }
});

await okAsync('refreshAccessToken falls back to the old refresh token if not rotated', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      access_token: 'new-at',
      expires_in: 3600,
    }),
  });

  try {
    const t = await refreshAccessToken({ clientId: 'c', refreshToken: 'old-rt' });
    assert.equal(t.accessToken, 'new-at');
    assert.equal(t.refreshToken, 'old-rt'); // fallback applied
  } finally {
    global.fetch = originalFetch;
  }
});

await okAsync('refreshAccessToken throws an error with status and body on failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => '{"error":"invalid_grant"}',
  });

  try {
    await assert.rejects(
      refreshAccessToken({ clientId: 'c', refreshToken: 'rt' }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.body, '{"error":"invalid_grant"}');
        assert.match(err.message, /400 \{"error":"invalid_grant"\}/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

// ── TOKEN-EXPIRY DECISION ───────────────────────────────────────────────────────
ok('needsRefresh: true with no token, false when fresh, true within skew', () => {
  const now = 1_000_000;
  assert.equal(needsRefresh(null, now), true);
  assert.equal(needsRefresh({ accessToken: 't' }, now), true);              // no expiresAt
  assert.equal(needsRefresh({ accessToken: 't', expiresAt: now + 3600_000 }, now), false); // ~1h left
  assert.equal(needsRefresh({ accessToken: 't', expiresAt: now + 30_000 }, now), true);    // 30s left < 60s skew
  assert.equal(needsRefresh({ accessToken: 't', expiresAt: now - 1 }, now), true);         // already expired
});

// ── NOW-PLAYING PARSE ────────────────────────────────────────────────────────────
ok('pickArtUrl picks the image nearest ~300px', () => {
  const images = [
    { url: 'big', width: 640 }, { url: 'mid', width: 300 }, { url: 'small', width: 64 },
  ];
  assert.equal(pickArtUrl(images, 300), 'mid');
  assert.equal(pickArtUrl([], 300), null);
  assert.equal(pickArtUrl(null, 300), null);
});

ok('parseNowPlaying maps a playing track to {title,artist,artUrl,isPlaying,...}', () => {
  const data = {
    is_playing: true,
    progress_ms: 60_000,
    item: {
      id: 'track123',
      name: 'Get Lucky',
      duration_ms: 240_000,
      artists: [{ name: 'Daft Punk' }, { name: 'Pharrell Williams' }],
      album: { images: [{ url: 'u640', width: 640 }, { url: 'u300', width: 300 }] },
    },
  };
  const np = parseNowPlaying(data);
  assert.equal(np.title, 'Get Lucky');
  assert.equal(np.artist, 'Daft Punk, Pharrell Williams');
  assert.equal(np.artUrl, 'u300');
  assert.equal(np.trackId, 'track123');
  assert.equal(np.isPlaying, true);
  assert.equal(np.elapsedMs, 60_000);
  assert.equal(np.durationMs, 240_000);
  assert.ok(Math.abs(np.progress - 0.25) < 1e-9);
});

ok('parseNowPlaying returns null for 204 (null), ads, and bare non-track items', () => {
  assert.equal(parseNowPlaying(null), null);
  assert.equal(parseNowPlaying({ is_playing: true, item: null }), null);       // ad break
  assert.equal(parseNowPlaying({ is_playing: true, item: { name: 'x' } }), null); // no album/show/images
});

ok('parseNowPlaying maps a podcast episode via show name + episode art', () => {
  const np = parseNowPlaying({
    is_playing: true,
    progress_ms: 30_000,
    currently_playing_type: 'episode',
    item: {
      id: 'ep123', name: 'The One About Testing', duration_ms: 1_800_000,
      images: [{ url: 'ep300', width: 300 }, { url: 'ep64', width: 64 }],
      show: { name: 'QA Radio', images: [{ url: 'show300', width: 300 }] },
    },
  });
  assert.equal(np.title, 'The One About Testing');
  assert.equal(np.artist, 'QA Radio');          // show name stands in for the artist
  assert.equal(np.artUrl, 'ep300');             // episode images preferred over show images
  assert.equal(np.trackId, 'ep123');
  assert.equal(np.durationMs, 1_800_000);
  // an episode with no images of its own falls back to the show's art
  const np2 = parseNowPlaying({
    is_playing: false, progress_ms: 0, currently_playing_type: 'episode',
    item: { id: 'ep2', name: 'E2', duration_ms: 60_000, show: { name: 'S', images: [{ url: 'show300', width: 300 }] } },
  });
  assert.equal(np2.artUrl, 'show300');
  assert.equal(np2.isPlaying, false);
});

ok('parseNowPlaying flags paused state', () => {
  const np = parseNowPlaying({
    is_playing: false, progress_ms: 0,
    item: { id: 'i', name: 't', duration_ms: 1000, artists: [{ name: 'A' }], album: { images: [] } },
  });
  assert.equal(np.isPlaying, false);
  assert.equal(np.artUrl, null); // empty images -> null
});

// ── CARD RENDER ──────────────────────────────────────────────────────────────────
ok('renderCard produces a FRAME_BYTES frame that buildImageTransfer accepts (placeholder art)', () => {
  const frame = renderCard({ title: 'Some Long Song Title That Wraps', artist: 'An Artist', progress: 0.5, paused: false });
  assert.equal(frame.length, FRAME_BYTES);
  assert.doesNotThrow(() => buildImageTransfer(frame));
});

ok('renderCard blits real 96x96 art without changing frame size', () => {
  const artRGB = new Uint8Array(96 * 96 * 3);
  for (let i = 0; i < artRGB.length; i += 3) { artRGB[i] = 200; artRGB[i + 1] = 40; artRGB[i + 2] = 90; }
  const frame = renderCard({ title: 'X', artist: 'Y', artRGB, progress: 0.1, paused: true, elapsedMs: 12000, durationMs: 200000 });
  assert.equal(frame.length, FRAME_BYTES);
  assert.doesNotThrow(() => buildImageTransfer(frame));
});

// ── GET NOW PLAYING ──────────────────────────────────────────────────────────────
await okAsync('getNowPlaying returns null on 204 (nothing playing)', async () => {
  const origFetch = global.fetch;
  try {
    global.fetch = async () => ({ status: 204 });
    const result = await getNowPlaying('fake-token');
    assert.equal(result, null);
  } finally {
    global.fetch = origFetch;
  }
});

await okAsync('getNowPlaying throws 401 error on 401 status', async () => {
  const origFetch = global.fetch;
  try {
    global.fetch = async () => ({ status: 401 });
    await assert.rejects(
      async () => await getNowPlaying('fake-token'),
      (err) => err.status === 401 && err.message.includes('401')
    );
  } finally {
    global.fetch = origFetch;
  }
});

await okAsync('getNowPlaying throws detailed error on non-ok status', async () => {
  const origFetch = global.fetch;
  try {
    global.fetch = async () => ({
      status: 500,
      ok: false,
      text: async () => 'Internal Server Error'
    });
    await assert.rejects(
      async () => await getNowPlaying('fake-token'),
      (err) => err.message.includes('failed 500 Internal Server Error')
    );
  } finally {
    global.fetch = origFetch;
  }
});

await okAsync('getNowPlaying parses and returns playing track on 200', async () => {
  const origFetch = global.fetch;
  try {
    const mockData = {
      is_playing: true,
      progress_ms: 60000,
      item: {
        id: 'track123',
        name: 'Get Lucky',
        duration_ms: 240000,
        artists: [{ name: 'Daft Punk' }, { name: 'Pharrell Williams' }],
        album: { images: [{ url: 'u640', width: 640 }, { url: 'u300', width: 300 }] },
      },
    };
    global.fetch = async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer fake-token');
      assert.ok(url.includes('currently-playing'));
      return {
        status: 200,
        ok: true,
        json: async () => mockData
      };
    };
    const result = await getNowPlaying('fake-token');
    assert.ok(result);
    assert.equal(result.title, 'Get Lucky');
    assert.equal(result.artist, 'Daft Punk, Pharrell Williams');
    assert.equal(result.artUrl, 'u300');
  } finally {
    global.fetch = origFetch;
  }
});


// ── TOKEN EXCHANGE ───────────────────────────────────────────────────────────────
await okAsync('exchangeCodeForToken calls fetch correctly and shapes token', async () => {
  const originalFetch = global.fetch;
  try {
    let fetchArgs = null;
    global.fetch = async (url, options) => {
      fetchArgs = { url, options };
      return {
        ok: true,
        json: async () => ({
          access_token: 'acc', refresh_token: 'ref', expires_in: 3600, scope: 'sc', token_type: 'Bearer'
        })
      };
    };

    const token = await exchangeCodeForToken({
      clientId: 'cid', code: 'c', redirectUri: 'r', codeVerifier: 'v'
    });

    assert.equal(fetchArgs.url, 'https://accounts.spotify.com/api/token');
    assert.equal(fetchArgs.options.method, 'POST');
    assert.equal(fetchArgs.options.headers['Content-Type'], 'application/x-www-form-urlencoded');

    const body = fetchArgs.options.body;
    assert.ok(body instanceof URLSearchParams);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'c');
    assert.equal(body.get('redirect_uri'), 'r');
    assert.equal(body.get('client_id'), 'cid');
    assert.equal(body.get('code_verifier'), 'v');

    assert.deepEqual(token, {
      accessToken: 'acc', refreshToken: 'ref', expiresInSec: 3600, scope: 'sc', tokenType: 'Bearer'
    });
  } finally {
    global.fetch = originalFetch;
  }
});

await okAsync('exchangeCodeForToken throws on non-ok fetch response', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'Bad Request'
    });

    await assert.rejects(
      exchangeCodeForToken({ clientId: 'cid', code: 'c', redirectUri: 'r', codeVerifier: 'v' }),
      (err) => {
        assert.match(err.message, /spotify: code exchange failed 400 Bad Request/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

ok('clearPendingAuth removes verifier and state from localStorage', () => {
  const originalLocalStorage = global.localStorage;
  try {
    const removedItems = [];
    global.localStorage = {
      removeItem: (key) => removedItems.push(key)
    };
    clearPendingAuth();
    assert.deepEqual(removedItems, ['al80.spotify.pkceVerifier', 'al80.spotify.authState']);
  } finally {
    global.localStorage = originalLocalStorage;
  }
});

ok('clearPendingAuth silently ignores localStorage errors', () => {
  const originalLocalStorage = global.localStorage;
  try {
    global.localStorage = {
      removeItem: () => { throw new Error('localStorage is disabled'); }
    };
    assert.doesNotThrow(() => clearPendingAuth());
  } finally {
    global.localStorage = originalLocalStorage;
  }
});
console.log(`\n${pass} checks passed.`);
