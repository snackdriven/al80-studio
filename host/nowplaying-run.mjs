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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const SYNC_RGB = args.has('--sync');
const MOCK_DEVICE = args.has('--mock-device');
const POLL_MS = 5000;

const artCache = new Map(); // trackId -> { artRGB, hueSat }

async function fetchArtRGB(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`art HTTP ${res.status}`);
    return decodeToRGB96(Buffer.from(await res.arrayBuffer()));
  } catch (e) { console.log('[art]', e.message); return null; }
}

async function currentTrack() {
  if (!LIVE) return getNowPlayingMock(Date.now());
  const token = await getAccessToken(process.env); // reads SPOTIFY_CLIENT_ID + SPOTIFY_REFRESH_TOKEN
  if (!token) { console.log('[spotify] no token — set SPOTIFY_CLIENT_ID + SPOTIFY_REFRESH_TOKEN (run spotify-auth.mjs)'); return null; }
  return getNowPlaying(token);
}

function progressOf(np) {
  if (typeof np.progress === 'number') return np.progress;
  const elapsed = np.elapsedMs ?? np.progressMs ?? 0;
  return np.durationMs ? Math.max(0, Math.min(1, elapsed / np.durationMs)) : 0;
}

async function main() {
  const dev = MOCK_DEVICE ? new MockDevice() : new Device();
  await dev.open();
  console.log(`[nowplaying] ${LIVE ? 'LIVE (Spotify)' : 'MOCK track'} -> ${MOCK_DEVICE ? 'mock device' : 'AL80 screen'}. Ctrl-C to stop.`);
  process.on('SIGINT', () => { try { dev.close(); } catch { /* gone */ } console.log('\n[nowplaying] stopped'); process.exit(0); });

  let lastKey = null; // trackId + paused — only push a new frame (and its brief homepage flicker) on a real change
  for (;;) {
    let np = null;
    try { np = await currentTrack(); } catch (e) { console.log('[spotify]', e.message); }

    if (np && np.title) {
      const key = `${np.trackId}|${np.paused ? 'p' : 'r'}`;
      if (key !== lastKey) {
        let cached = artCache.get(np.trackId);
        if (!cached) {
          const artRGB = await fetchArtRGB(np.artUrl);
          cached = { artRGB, hueSat: artRGB ? dominantColor(artRGB) : null };
          artCache.set(np.trackId, cached);
        }
        const frame = render({ title: np.title, artist: np.artist, artRGB: cached.artRGB, progress: progressOf(np), paused: np.paused });
        console.log(`[nowplaying] ${np.paused ? '⏸' : '▶'} ${np.title} — ${np.artist}`);
        try {
          const t0 = Date.now();
          const r = await dev.sendFrame(frame);
          console.log(`[send] ${r.acked}/${r.dataBlocks} blocks acked, ${r.fellBack} fell back, ${Date.now() - t0}ms`);
        } catch (e) { console.log('[send]', e.message); }
        if (SYNC_RGB && cached.hueSat && !MOCK_DEVICE) {
          const hue = Math.round((cached.hueSat.hue / 360) * 255), sat = Math.round(cached.hueSat.sat * 255);
          try { await dev.setRGB({ effect: 1 /* Solid Color */, color: { hue, sat } }); } catch { /* best effort */ }
        }
        lastKey = key;
      }
    } else if (lastKey !== 'idle') {
      console.log('[nowplaying] nothing playing');
      lastKey = 'idle';
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error('[nowplaying] fatal:', e.message); process.exit(1); });
