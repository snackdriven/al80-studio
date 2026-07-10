// Now-playing on the AL80 screen: poll Spotify (or a mock) -> decode cover art -> render the
// 96x160 card -> push it over the native transport (device.js, with all the anti-banding fixes).
//
// Usage (close al80-studio / usevia first — one app owns the keyboard at a time):
//   node nowplaying-run.mjs                 MOCK track + real screen  (proves it with NO Spotify creds)
//   node nowplaying-run.mjs --live          real Spotify + real screen
//   node nowplaying-run.mjs --live --sync   also tint the RGB to the cover's dominant colour
//   node nowplaying-run.mjs --mock-device   dry run, no hardware (logs packet counts)
//
// Live mode needs SPOTIFY_CLIENT_ID + SPOTIFY_REFRESH_TOKEN in the environment — run
// `node spotify-auth.mjs` once to get them.
import Device, { MockDevice } from './device.js';
import { render } from './apps/nowplaying.js';
import { getAccessToken, getNowPlaying, getNowPlayingMock } from './lib/spotify.js';
import { decodeToRGB96, dominantColor } from './lib/art.js';
import { writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const SYNC_RGB = args.has('--sync');
const MOCK_DEVICE = args.has('--mock-device');
const POLL_MS = 5000;
const PROGRESS_REFRESH_MS = 15000; // re-push the frame this often to advance the progress bar, even mid-track

const artCache = new Map(); // trackId -> { artRGB, hueSat }

async function fetchArtRGB(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`art HTTP ${res.status}`);
    return decodeToRGB96(Buffer.from(await res.arrayBuffer()));
  } catch (e) { console.log('[art]', e.message); return null; }
}

const ENV_PATH = new URL('./.env', import.meta.url);
let tokenCache = null; // { accessToken, expiresAt } — access tokens last ~1h; do NOT refresh every poll

// PKCE rotates the refresh token on every refresh (Spotify docs): the response returns a NEW
// refresh_token that replaces the old, and reusing the old gets it revoked. So cache the access
// token, refresh only near expiry, and persist any rotated refresh token immediately.
async function accessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.accessToken;
  const t = await getAccessToken(process.env); // throws on invalid_grant (expired/revoked)
  tokenCache = { accessToken: t.accessToken, expiresAt: Date.now() + (t.expiresInSec || 3600) * 1000 };
  if (t.refreshToken && t.refreshToken !== process.env.SPOTIFY_REFRESH_TOKEN) {
    process.env.SPOTIFY_REFRESH_TOKEN = t.refreshToken;
    try { writeFileSync(ENV_PATH, `SPOTIFY_CLIENT_ID=${process.env.SPOTIFY_CLIENT_ID}\nSPOTIFY_REFRESH_TOKEN=${t.refreshToken}\n`); }
    catch (e) { console.log('[spotify] could not persist rotated refresh token:', e.message); }
  }
  return tokenCache.accessToken;
}

async function currentTrack() {
  if (!LIVE) return getNowPlayingMock(Date.now());
  let tok;
  try { tok = await accessToken(); }
  catch (e) {
    if (/invalid_grant/i.test(e.message)) {
      console.log('\n[spotify] refresh token expired or revoked — re-auth with: node spotify-auth.mjs <clientId>\n');
      process.exit(1); // don't retry-loop on a dead token (they expire at 6 months + rotate per use)
    }
    console.log('[spotify]', e.message); return null;
  }
  try { return await getNowPlaying(tok); } // tok is the access-token STRING — fixes the bearer 400
  catch (e) {
    if (/\b401\b/.test(e.message)) { tokenCache = null; return null; } // expired mid-cache; force one refresh
    console.log('[spotify]', e.message); return null;
  }
}

function progressOf(np) {
  if (typeof np.progress === 'number') return np.progress;
  const elapsed = np.elapsedMs ?? np.progressMs ?? 0;
  return np.durationMs ? Math.max(0, Math.min(1, elapsed / np.durationMs)) : 0;
}

async function main() {
  const dev = MOCK_DEVICE ? new MockDevice() : new Device();
  try { dev.open(); }
  catch (e) {
    console.log('[nowplaying] waiting for device:', e.message); // at logon the keyboard often enumerates after us
    await dev.reopen(); // retries with backoff (1s,2s,…5s cap) until it's plugged in
  }
  console.log(`[nowplaying] ${LIVE ? 'LIVE (Spotify)' : 'MOCK track'} -> ${MOCK_DEVICE ? 'mock device' : 'AL80 screen'}. Ctrl-C to stop.`);
  process.on('SIGINT', async () => {
    // clean up the one card we left in the picture ring so stopping doesn't leave album art behind
    try { if (committed && dev.opened) await dev.deletePicture(); } catch { /* best effort */ }
    try { dev.close(); } catch { /* gone */ }
    console.log('\n[nowplaying] stopped');
    process.exit(0);
  });

  let lastKey = null;   // trackId + paused
  let lastSentAt = 0;   // last frame push — drives the periodic progress-bar advance
  let committed = false; // have WE committed a card to the ring? gates the delete-before-add (see device.sendCard)
  for (;;) {
    let np = null;
    try { np = await currentTrack(); } catch (e) { console.log('[spotify]', e.message); }

    if (np && np.title) {
      const key = `${np.trackId}|${np.paused ? 'p' : 'r'}`;
      const trackChanged = key !== lastKey;
      const progressDue = !np.paused && Date.now() - lastSentAt >= PROGRESS_REFRESH_MS; // nudge the bar forward
      if (trackChanged || progressDue) {
        let cached = artCache.get(np.trackId);
        if (!cached) {
          const artRGB = await fetchArtRGB(np.artUrl);
          cached = { artRGB, hueSat: artRGB ? dominantColor(artRGB) : null };
          artCache.set(np.trackId, cached);
        }
        const frame = render({ title: np.title, artist: np.artist, artRGB: cached.artRGB, progress: progressOf(np), paused: np.paused });
        if (trackChanged) console.log(`[nowplaying] ${np.paused ? '⏸' : '▶'} ${np.title} — ${np.artist}`);
        let sent = false;
        try {
          // sendCard deletes the card we last committed (the slot on screen) before adding the new
          // one, so the picture ring doesn't grow past our single card. Don't replace on the first
          // push (nothing of ours yet).
          const r = await dev.sendCard(frame, { replacePrevious: committed });
          if (trackChanged) console.log(`[send] ${r.acked}/${r.dataBlocks} blocks acked, ${r.fellBack} fell back`);
          sent = true;
          committed = true;
        } catch (e) {
          console.log('[send]', e.message);
          if (!dev.opened) { // unplug / sleep-resume dropped the handle — device.js closed it on the write error
            console.log('[nowplaying] device dropped — reconnecting…');
            committed = false; // after a reconnect we can't be sure our card is still the displayed slot — don't delete blind
            try { await dev.reopen(); console.log('[nowplaying] reconnected'); }
            catch (re) { console.log('[nowplaying] reconnect failed:', re.message); }
          }
          // leave lastKey/lastSentAt unchanged so this frame is re-attempted on the next poll
        }
        if (sent && SYNC_RGB && cached.hueSat && trackChanged && !MOCK_DEVICE) {
          const hue = Math.round((cached.hueSat.hue / 360) * 255), sat = Math.round(cached.hueSat.sat * 255);
          try { await dev.setRGB({ effect: 1 /* Solid Color */, color: { hue, sat } }); } catch { /* best effort */ }
        }
        if (sent) { lastKey = key; lastSentAt = Date.now(); } // only advance state on a real push
      }
    } else if (lastKey !== 'idle') {
      console.log('[nowplaying] nothing playing');
      lastKey = 'idle';
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error('[nowplaying] fatal:', e.message); process.exit(1); });
