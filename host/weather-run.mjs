// Weather slide on the AL80 screen: poll Open-Meteo (or a mock) -> render the 96x160 card -> push
// it over the native transport (device.js, with all the anti-banding fixes). Mirrors
// nowplaying-run.mjs — same device handling, same picture-ring safety.
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
// can't drive the panel at once (device.js throws "device busy" if another opener holds it).
// Coordinating the two is future scheduler work (see weather-DESIGN.md), out of scope here.
import Device, { MockDevice } from './device.js';
import { render } from './apps/weather.js';
import { getWeatherFromEnv, getWeatherMock } from './lib/weather.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const MOCK_DEVICE = args.has('--mock-device');
const POLL_MS = 10 * 60 * 1000; // weather is slow — 10 min keeps it fresh + polite to a free no-key API

async function currentWeather() {
  if (!LIVE) return getWeatherMock();
  return getWeatherFromEnv(process.env); // throws on network/HTTP error — caught by the loop
}

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
    // clean up the one card we left in the picture ring so stopping doesn't leave the slide behind
    try { if (committed && dev.opened) await dev.deletePicture(); } catch { /* best effort */ }
    try { dev.close(); } catch { /* gone */ }
    console.log('\n[weather] stopped');
    process.exit(0);
  });

  let lastKey = null;    // last drawn reading — skip a push when nothing changed
  let committed = false; // have WE committed a card to the ring? gates the delete-before-add (see device.sendCard)
  for (;;) {
    let w = null;
    try { w = await currentWeather(); } catch (e) { console.log('[weather]', e.message); }

    if (w) {
      const key = readingKey(w);
      if (key !== lastKey) {
        const frame = render(w);
        const t = w.units === 'C' ? w.tempC : w.tempF;
        console.log(`[weather] ${w.label} ${t}°${w.units} ${w.condition} (hi ${w.units === 'C' ? w.hiC : w.hiF}/lo ${w.units === 'C' ? w.loC : w.loF})`);
        try {
          // sendCard deletes the card we last committed (the slot on screen) before adding the new
          // one, so the picture ring doesn't grow past our single card. Don't replace on the first
          // push (nothing of ours yet).
          const r = await dev.sendCard(frame, { replacePrevious: committed });
          console.log(`[send] ${r.acked}/${r.dataBlocks} blocks acked, ${r.fellBack} fell back`);
          committed = true;
          lastKey = key; // only advance state on a real push
        } catch (e) {
          console.log('[send]', e.message);
          if (!dev.opened) { // unplug / sleep-resume dropped the handle — device.js closed it on the write error
            console.log('[weather] device dropped — reconnecting…');
            committed = false; // after a reconnect we can't be sure our card is still the displayed slot — don't delete blind
            try { await dev.reopen(); console.log('[weather] reconnected'); }
            catch (re) { console.log('[weather] reconnect failed:', re.message); }
          }
          // leave lastKey unchanged so this frame is re-attempted on the next poll
        }
      }
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error('[weather] fatal:', e.message); process.exit(1); });
