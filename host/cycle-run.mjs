// Cycle-run: the ONE always-on host. Superset of nowplaying-run.mjs / weather-run.mjs — rotates
// clock / weather / now-playing on the AL80 screen and hosts the local alert intake (folds in
// daemon.js's role: connect -> loop { render active app, diff, paced send } -> recover, plus the
// 127.0.0.1:7333 alert hook). This is what host/autostart/run-nowplaying.vbs launches now — see
// "Autostart unification" in research/al80-buildout-flow-and-overnight-plan.md.
//
// Usage (close al80-studio / usevia first — one app owns the keyboard at a time):
//   node cycle-run.mjs                       rotate clock -> weather -> nowplaying, real screen
//   node cycle-run.mjs --live                 real Spotify + real Open-Meteo, real screen
//   node cycle-run.mjs --only=nowplaying      just that panel, forever (debug launcher parity
//   node cycle-run.mjs --only=weather          with the old single-panel *-run.mjs scripts)
//   node cycle-run.mjs --only=clock
//   node cycle-run.mjs --mock-device          dry run, no hardware (logs packet counts)
//
// --only=<panel> is what nowplaying-run.mjs / weather-run.mjs now are: thin single-panel debug
// launchers. They stay in the repo unchanged for that purpose; this file is the superset the
// always-on host actually runs.
//
// Alert intake: daemon.js/transport-hid.js are deprecated (kept for reference, not launched by
// anything) — their local-hook alert intake is folded in here via the same Scheduler +
// startLocalHook used previously by daemon.js.
import Device, { MockDevice } from './device.js';
import { clockApp } from './apps/clock.js';
import { makeWeatherApp } from './apps/weather.js';
import { makeNowPlayingApp } from './apps/nowplaying.js';
import { Scheduler } from './lib/scheduler.js';
import { startLocalHook } from './control/local-hook.js';
import { getAccessToken, getNowPlaying, getNowPlayingMock } from './lib/spotify.js';
import { decodeToRGB96 } from './lib/art.js';
import { getWeatherFromEnv, getWeatherMock } from './lib/weather.js';
import { writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PANELS = ['clock', 'weather', 'nowplaying'];
const ROTATE_MS = 20_000;       // how long each panel gets before rotating to the next
const NOWPLAYING_POLL_MS = 5000;
const WEATHER_POLL_MS = 10 * 60 * 1000;

/** Parse argv into cycle-run options. Exported for the arg-parsing test. */
export function parseArgs(argv = []) {
  const args = new Set(argv);
  let only = null;
  for (const a of argv) {
    const m = /^--only=(.+)$/.exec(a);
    if (m) only = m[1];
  }
  if (only && !PANELS.includes(only)) throw new Error(`--only must be one of ${PANELS.join(', ')} (got "${only}")`);
  return {
    live: args.has('--live'),
    mockDevice: args.has('--mock-device'),
    only,
    panels: only ? [only] : PANELS,
  };
}

const ENV_PATH = new URL('./.env', import.meta.url);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dev = opts.mockDevice ? new MockDevice() : new Device();
  try { dev.open(); }
  catch (e) {
    console.log('[cycle] waiting for device:', e.message);
    await dev.reopen();
  }
  console.log(`[cycle] ${opts.live ? 'LIVE' : 'MOCK'} data -> ${opts.mockDevice ? 'mock device' : 'AL80 screen'}. panels=${opts.panels.join(',')}. Ctrl-C to stop.`);

  // ── live state the apps read via getState() closures ──────────────────────────────────────
  let tokenCache = null;
  async function accessToken() {
    if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.accessToken;
    const t = await getAccessToken(process.env);
    tokenCache = { accessToken: t.accessToken, expiresAt: Date.now() + (t.expiresInSec || 3600) * 1000 };
    if (t.refreshToken && t.refreshToken !== process.env.SPOTIFY_REFRESH_TOKEN) {
      process.env.SPOTIFY_REFRESH_TOKEN = t.refreshToken;
      try { writeFileSync(ENV_PATH, `SPOTIFY_CLIENT_ID=${process.env.SPOTIFY_CLIENT_ID}\nSPOTIFY_REFRESH_TOKEN=${t.refreshToken}\n`); }
      catch (e) { console.log('[spotify] could not persist rotated refresh token:', e.message); }
    }
    return tokenCache.accessToken;
  }

  const artCache = new Map();
  let npState = {};
  async function pollNowPlaying() {
    try {
      let np;
      if (!opts.live) np = getNowPlayingMock(Date.now());
      else { const tok = await accessToken(); np = await getNowPlaying(tok); }
      if (!np || !np.title) { npState = {}; return; }
      let cached = artCache.get(np.trackId);
      if (!cached) {
        let artRGB = null;
        if (np.artUrl) { try { const res = await fetch(np.artUrl); artRGB = decodeToRGB96(Buffer.from(await res.arrayBuffer())); } catch { /* fall back to placeholder */ } }
        cached = { artRGB };
        artCache.set(np.trackId, cached);
      }
      const elapsed = np.elapsedMs ?? np.progressMs ?? 0;
      const progress = np.durationMs ? Math.max(0, Math.min(1, elapsed / np.durationMs)) : 0;
      npState = { title: np.title, artist: np.artist, artRGB: cached.artRGB, progress, paused: np.paused, elapsedMs: np.elapsedMs, durationMs: np.durationMs };
    } catch (e) {
      if (/invalid_grant/i.test(e.message || '')) console.log('\n[spotify] refresh token expired — re-auth with: node spotify-auth.mjs <clientId>\n');
      else console.log('[spotify]', e.message);
    }
  }

  let wxState = {};
  async function pollWeather() {
    try { wxState = opts.live ? await getWeatherFromEnv(process.env) : getWeatherMock(); }
    catch (e) { console.log('[weather]', e.message); }
  }

  const scheduler = new Scheduler(clockApp);
  const apps = {
    clock: clockApp,
    weather: makeWeatherApp(() => wxState),
    nowplaying: makeNowPlayingApp(() => npState),
  };
  scheduler.setBase(apps[opts.panels[0]]);
  const hook = startLocalHook(scheduler);
  console.log('[cycle] local alert intake on http://127.0.0.1:7333/alert');

  await pollNowPlaying();
  await pollWeather();

  process.on('SIGINT', async () => {
    try { hook.close(); } catch { /* already down */ }
    try { dev.close(); } catch { /* gone */ }
    console.log('\n[cycle] stopped');
    process.exit(0);
  });

  let panelIdx = 0;
  let lastRotateAt = Date.now();
  let lastNpPollAt = 0, lastWxPollAt = 0;
  let prevFrame = null;
  for (;;) {
    const now = Date.now();
    if (now - lastNpPollAt >= NOWPLAYING_POLL_MS) { await pollNowPlaying(); lastNpPollAt = now; }
    if (now - lastWxPollAt >= WEATHER_POLL_MS) { await pollWeather(); lastWxPollAt = now; }

    scheduler.update(now); // expire transient alerts
    if (opts.panels.length > 1 && now - lastRotateAt >= ROTATE_MS && !scheduler.alertCount) {
      panelIdx = (panelIdx + 1) % opts.panels.length;
      scheduler.setBase(apps[opts.panels[panelIdx]]);
      lastRotateAt = now;
    }

    const app = scheduler.active();
    try {
      const frame = app.render(new Date());
      await dev.sendCard(frame, { replacePrevious: prevFrame !== null });
      prevFrame = frame;
    } catch (e) {
      console.log('[cycle]', e.message);
      try { dev.close(); } catch { /* gone */ }
      await dev.reopen();
      prevFrame = null;
    }
    await sleep(Math.max(1000 / (app.fps || 1), 250));
  }
}

// Only auto-run when executed directly (so tests can import parseArgs without launching the loop).
if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((e) => { console.error('[cycle] fatal:', e); process.exit(1); });
}
