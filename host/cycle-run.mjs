// Always-on AL80 host: ONE process owns the LCD and rotates cached panel frames on a timer —
// now-playing while music plays, weather + clock otherwise, preempting to an alert card when one
// arrives. Set-and-forget, no browser tab. Generalizes "now-playing survives on its own" (abc3aea)
// to N panels. See al80-lcd/research/al80-lcd-panel-auto-cycle-SPARC.md.
//
// Usage:
//   node cycle-run.mjs                  MOCK now-playing + MOCK weather + real screen
//   node cycle-run.mjs --live           real Spotify + real Open-Meteo + real screen
//   node cycle-run.mjs --live --sync    also tint the RGB to the on-screen panel's accent color
//   node cycle-run.mjs --mock-device    dry run, no hardware (logs packet counts)
//   node cycle-run.mjs --mode=roundrobin   disable smart rules (fixed rotation, debug/demo — FR9)
//
// Env (all optional — see the SPARC A7 for the full list):
//   CYCLE_PANELS=nowplaying,weather,clock   CYCLE_MODE=smart|roundrobin   CYCLE_DWELL_MS=15000
//   CYCLE_DWELL_NOWPLAYING=30000   CYCLE_NP_FOCUS_ON_CHANGE=1   CYCLE_WEATHER_STALE_MS=2400000
//   CYCLE_TICK_MS=500   CYCLE_SYNC_RGB=0   CYCLE_ALERT_PORT=7333
//   plus the unchanged SPOTIFY_* / WEATHER_* read by the panels themselves.
import Device, { MockDevice } from './device.js';
import { Scheduler } from './lib/scheduler.js';
import { startLocalHook } from './control/local-hook.js';
import { makeCycler } from './cycle.js';
import { makeNowPlayingPanel } from './panels/nowplaying.js';
import { makeWeatherPanel } from './panels/weather.js';
import { makeClockPanel } from './panels/clock.js';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const SYNC_RGB = args.has('--sync') || process.env.CYCLE_SYNC_RGB === '1';
const MOCK_DEVICE = args.has('--mock-device');
const modeArg = [...args].find((a) => a.startsWith('--mode='));

/** A7 config schema. */
export function parseEnv(env = process.env, argv = []) {
  const modeFlag = argv.find((a) => a.startsWith('--mode='))?.split('=')[1];
  const onlyFlag = argv.find((a) => a.startsWith('--only='))?.split('=')[1]; // single-panel debug — overrides CYCLE_PANELS
  const panelIds = onlyFlag
    ? [onlyFlag.trim()] // buildPanels throws on an unknown name, so a bad --only= errors loudly (not a silent all-3 run)
    : (env.CYCLE_PANELS || 'nowplaying,weather,clock').split(',').map((s) => s.trim()).filter(Boolean);
  const dwellDefault = Math.max(8000, Number(env.CYCLE_DWELL_MS) || 15000); // floored 8s (NFR2)
  const dwellFor = (id) => {
    const key = `CYCLE_DWELL_${id.toUpperCase()}`;
    if (env[key]) return Math.max(8000, Number(env[key]));
    if (id === 'nowplaying') return Math.max(8000, Number(env.CYCLE_DWELL_NOWPLAYING) || 30000);
    return dwellDefault;
  };
  return {
    panelIds,
    mode: modeFlag || env.CYCLE_MODE || 'smart',
    dwellFor,
    npFocusOnChange: env.CYCLE_NP_FOCUS_ON_CHANGE !== '0',
    weatherStaleMs: Number(env.CYCLE_WEATHER_STALE_MS) || 40 * 60 * 1000,
    tickMs: Number(env.CYCLE_TICK_MS) || 500,
    syncRGB: env.CYCLE_SYNC_RGB === '1',
    alertPort: Number(env.CYCLE_ALERT_PORT) || 7333,
    pollMs: { nowplaying: 5000, weather: 10 * 60 * 1000, clock: Infinity },
  };
}

function buildPanels(ids, cfg, { live = false } = {}) {
  const factories = {
    nowplaying: () => { const p = makeNowPlayingPanel({ live }); p.dwellMs = cfg.dwellFor('nowplaying'); return p; },
    weather: () => { const p = makeWeatherPanel({ live, staleMs: cfg.weatherStaleMs }); p.dwellMs = cfg.dwellFor('weather'); return p; },
    clock: () => makeClockPanel({ dwellMs: cfg.dwellFor('clock') }),
  };
  return ids.map((id) => {
    if (!factories[id]) throw new Error(`cycle-run: unknown panel "${id}" (CYCLE_PANELS)`);
    return factories[id]();
  });
}

async function main() {
  const cfg = parseEnv(process.env, [...args, ...(modeArg ? [modeArg] : [])]);
  const dev = MOCK_DEVICE ? new MockDevice() : new Device();
  try { dev.open(); }
  catch (e) {
    console.log('[cycle] waiting for device:', e.message); // at logon the keyboard often enumerates after us
    await dev.reopen();
  }

  const panels = buildPanels(cfg.panelIds, cfg, { live: LIVE });
  const scheduler = new Scheduler(null); // base stays null — never rendered (A5)
  const hook = startLocalHook(scheduler, { port: cfg.alertPort });

  const cyc = makeCycler({
    dev, panels, mode: cfg.mode, npFocusOnChange: cfg.npFocusOnChange, syncRGB: SYNC_RGB || cfg.syncRGB, scheduler,
  });

  console.log(`[cycle] ${LIVE ? 'LIVE' : 'MOCK'} data -> ${MOCK_DEVICE ? 'mock device' : 'AL80 screen'}. Panels: ${cfg.panelIds.join(', ')} (${cfg.mode}). Alerts on :${cfg.alertPort}. Ctrl-C to stop.`);

  // Await every panel's first poll before the loop starts. [DISCOVERY] firing poll() without
  // awaiting let the very first tick land before an async panel (nowplaying: currentTrack() awaits
  // even in mock mode) had any state, so available() was still false and the FSM correctly-but-
  // visibly skipped to the next panel for one tick before focus-on-change self-corrected — a
  // one-tick wrong-panel flash on every cold start. See al80-buildout-discoveries.md.
  await Promise.all(panels.map((p) => p.poll().catch((e) => console.log(`[cycle] ${p.id} poll:`, e.message))));
  const timers = panels.map((p, i) => {
    const ms = cfg.pollMs[cfg.panelIds[i]] ?? 60000;
    if (!Number.isFinite(ms)) return null; // clock: no data pump
    return setInterval(() => { p.poll().catch((e) => console.log(`[cycle] ${p.id} poll:`, e.message)); }, ms);
  });

  let stopped = false;
  process.on('SIGINT', async () => {
    stopped = true;
    try { if (cyc.committed && dev.opened) await dev.deletePicture(); } catch { /* best effort */ }
    try { dev.close(); } catch { /* gone */ }
    try { hook.close(); } catch { /* gone */ }
    for (const t of timers) if (t) clearInterval(t);
    console.log('\n[cycle] stopped');
    process.exit(0);
  });

  while (!stopped) {
    // always-on host: contain an unexpected tick throw (non-drop bugs tick() rethrows) — log and keep
    // cycling; the next tick retries recovery. sleep() stays outside so cadence still paces the retry.
    try { await cyc.tick(Date.now()); }
    catch (e) { console.error('[cycle] tick threw — continuing:', e?.message ?? e); }
    await sleep(cfg.tickMs);
  }
}

// Exported for the --only=<panel> debug launchers (nowplaying-run.mjs / weather-run.mjs, Phase 0)
// and for tests (parseEnv is pure config parsing, device-free).
export { buildPanels };

// Only run the always-on loop when executed directly — importing parseEnv/buildPanels for tests
// must not open a device or start the alert HTTP server.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('[cycle] fatal:', e.message); process.exit(1); });
}
