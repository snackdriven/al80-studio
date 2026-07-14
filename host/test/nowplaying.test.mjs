// Offline now-playing / host tests — no network, no device. Covers the pure logic that bit us
// during the Spotify work: dominantColor's vivid-vs-white filter, HSV, and the PKCE helpers.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ART_RGB_BYTES, decodeToRGB96, dominantColor, rgbToHsv, hsvToRgb } from '../lib/art.js';
import { codeChallenge, buildAuthUrl, generateCodeVerifier, getNowPlayingMock } from '../lib/spotify.js';

const require = createRequire(import.meta.url);

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log('  ok -', name); };

// a flat RGB field of n pixels of one color
const field = (r, g, b, n = 64) => {
  const a = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = r; a[i * 3 + 1] = g; a[i * 3 + 2] = b; }
  return a;
};
const nearHue = (h, target, tol = 20) => { let d = Math.abs(h - target) % 360; if (d > 180) d = 360 - d; return d <= tol; };

console.log('AL80 Studio now-playing / host tests\n');

// ---- dominantColor: the vivid-vs-white filter (the bug we fixed) -------------
await ok('dominantColor: pure red / green / blue map to ~0 / 120 / 240', () => {
  assert.ok(nearHue(dominantColor(field(255, 0, 0)).hue, 0), 'red');
  assert.ok(nearHue(dominantColor(field(0, 255, 0)).hue, 120), 'green');
  assert.ok(nearHue(dominantColor(field(0, 0, 255)).hue, 240), 'blue');
});

await ok('dominantColor: white and black fall back to a quiet neutral, not a hard hue', () => {
  assert.deepEqual(dominantColor(field(255, 255, 255)), { hue: 175, sat: 0.12 });
  assert.deepEqual(dominantColor(field(0, 0, 0)), { hue: 175, sat: 0.12 });
});

await ok('dominantColor: a few vivid pixels beat a field of white (the near-white fix)', () => {
  const white = field(255, 255, 255, 200), red = field(255, 0, 0, 8);
  const both = new Uint8Array(white.length + red.length);
  both.set(white); both.set(red, white.length);
  // pure red is v=1.0 but must NOT be filtered as "white"; it should win the whole tile.
  assert.ok(nearHue(dominantColor(both).hue, 0), 'vivid red survives the white field');
});

// ---- HSV -------------------------------------------------------------------
await ok('rgbToHsv: primaries + white has zero saturation', () => {
  assert.equal(rgbToHsv(255, 0, 0).h, 0);
  assert.equal(Math.round(rgbToHsv(0, 255, 0).h), 120);
  assert.equal(Math.round(rgbToHsv(0, 0, 255).h), 240);
  assert.equal(rgbToHsv(255, 255, 255).s, 0);
});

await ok('hsvToRgb round-trips a primary through rgbToHsv', () => {
  const c = hsvToRgb(120, 1, 1); // pure green
  const arr = Array.isArray(c) ? c : [c.r, c.g, c.b];
  const hsv = rgbToHsv(arr[0], arr[1], arr[2]);
  assert.equal(Math.round(hsv.h), 120);
  assert.equal(Math.round(hsv.s), 1);
});

await ok('decodeToRGB96 decodes a JPEG through the installed jpeg-js dependency', () => {
  const jpeg = require('jpeg-js');
  const width = 12, height = 8;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = x * 20;
      data[o + 1] = y * 28;
      data[o + 2] = 180;
      data[o + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data, width, height }, 80).data;
  const art = decodeToRGB96(encoded);
  assert.equal(art.length, ART_RGB_BYTES);
  assert.ok(art.some((b) => b !== 0), 'decoded art should not be all black');
});

// ---- Spotify PKCE + mock ----------------------------------------------------
await ok('codeChallenge matches the RFC 7636 test vector', async () => {
  assert.equal(
    await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

await ok('buildAuthUrl carries the PKCE params', () => {
  const u = new URL(buildAuthUrl({
    clientId: 'abc', redirectUri: 'http://127.0.0.1:8888/callback', codeChallenge: 'xyz', state: 's1',
  }));
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'abc');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code_challenge'), 'xyz');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:8888/callback');
  assert.ok(u.searchParams.get('scope').includes('user-read-currently-playing'));
});

await ok('generateCodeVerifier is a 43-128 char url-safe string', () => {
  const v = generateCodeVerifier();
  assert.ok(v.length >= 43 && v.length <= 128, `len ${v.length}`);
  assert.match(v, /^[A-Za-z0-9\-._~]+$/);
});

await ok('getNowPlayingMock has the now-playing shape, progress in 0..1', () => {
  const m = getNowPlayingMock(0);
  for (const k of ['title', 'artist', 'trackId', 'progress', 'durationMs', 'paused']) assert.ok(k in m, `missing ${k}`);
  assert.equal(typeof m.progress, 'number');
  assert.ok(m.progress >= 0 && m.progress <= 1);
});

console.log(`\n${pass} checks passed.`);
