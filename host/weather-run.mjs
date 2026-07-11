// Weather slide on the AL80 screen, as a single-panel launcher over panels/weather.js (Phase 0
// refactor of the auto-cycle SPARC — same behavior as before the split: poll on the panel's own
// cadence, push/delete-before-add via device.js, only re-push when the reading actually changed).
// For the multi-panel always-on host (now-playing + weather + clock, alerts, smart rules) use
// cycle-run.mjs. Mirrors nowplaying-run.mjs — same device handling, same picture-ring safety.
//
// Usage (close al80-studio / usevia first — one app owns the keyboard at a time):
//   node weather-run.mjs                 MOCK weather + real screen  (proves it with NO network)
//   node weather-run.mjs --live          real Open-Meteo + real screen
//   node weather-run.mjs --mock-device   dry run, no hardware (logs packet counts)
//   node weather-run.mjs --live --mock-device   real data, no hardware (prints the reading)
//
// Live mode reads location from env (all optional — defaults to Detroit, Fahrenheit):
//   WEATHER_LAT  WEATHER_LON  WEATHER_UNITS(F|C)  WEATHER_LABEL
// Open-Meteo needs NO API key, so --live works with nothing configured.
//
// ONE SCREEN, ONE OWNER: the LCD is a single surface. Run weather OR now-playing, not both — they
// can't drive the panel at once (device.js throws "device busy" if another opener holds it). For
// both together, use cycle-run.mjs.
import Device, { MockDevice } from './device.js';
import { makeWeatherPanel } from './panels/weather.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const MOCK_DEVICE = args.has('--mock-device');
const POLL_MS = 10 * 60 * 1000; // weather is slow — 10 min keeps it fresh + polite to a free no-key API

/** A change key so we only re-push when the drawn reading actually moves (avoids ring churn). */
function readingKey(w) {
  return `${w.units}|${w.tempF}|${w.code}|${w.hiF}|${w.loF}|${w.label}`;
}

async function main() {
  const dev = MOCK_DEVICE ? new MockDevice() : new Device();
  try { dev.open(); }
  catch (e) {
    console.log('[weather] waiting for device:', e.message); // at logon the keyboard often enumerates after us
    await dev.reopen(); // retries with backoff (1s,2s,…5s cap) until it's plugged in
  }
  console.log(`[weather] ${LIVE ? 'LIVE (Open-Meteo)' : 'MOCK weather'} -> ${MOCK_DEVICE ? 'mock device' : 'AL80 screen'}. Ctrl-C to stop.`);
  process.on('SIGINT', async () => {
    try { if (committed && dev.opened) await dev.deletePicture(); } catch { /* best effort */ }
    try { dev.close(); } catch { /* gone */ }
    console.log('\n[weather] stopped');
    process.exit(0);
  });

  const panel = makeWeatherPanel({ live: LIVE });
  let lastKey = null;    // last drawn reading — skip a push when nothing changed
  let committed = false; // have WE committed a card to the ring? gates the delete-before-add (device.sendCard)

  for (;;) {
    try { await panel.poll(); } catch (e) { console.log('[weather]', e.message); }

    if (panel.available()) {
      // panels/weather.js drops the daemon's internal state on poll(); read it back for the change-key
      // via a fresh render (pure) and gate the push the same way the pre-split runner did.
      const frame = panel.render();
      const key = readingKey(panel.state ? panel.state() : {});
      if (key !== lastKey) {
        try {
          const r = await dev.sendCard(frame, { replacePrevious: committed });
          console.log(`[send] ${r.acked}/${r.dataBlocks} blocks acked, ${r.fellBack} fell back`);
          committed = true;
          lastKey = key;
        } catch (e) {
          console.log('[send]', e.message);
          if (!dev.opened) {
            console.log('[weather] device dropped — reconnecting…');
            committed = false;
            try { await dev.reopen(); console.log('[weather] reconnected'); }
            catch (re) { console.log('[weather] reconnect failed:', re.message); }
          }
        }
      }
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error('[weather] fatal:', e.message); process.exit(1); });
