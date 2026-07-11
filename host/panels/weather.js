// weather panel — Panel interface (see cycle.js / the auto-cycle SPARC A2). Owns the Open-Meteo
// poll on its OWN cadence (default 10min), decoupled from the cycler's dwell. Extracted from
// weather-run.mjs (Phase 0 refactor). NEVER touches `dev`; the cycler owns every device call.
//
// [SPARC A2] the runner's `readingKey` change-gate is dropped here on purpose — it existed to avoid
// ring churn on re-push; the cycler only pushes weather when it takes the screen, so there's nothing
// to gate.
import { render } from '../apps/weather.js';
import { getWeatherFromEnv, getWeatherMock } from '../lib/weather.js';

const WEATHER_STALE_MS_DEFAULT = 40 * 60 * 1000; // 40min

/**
 * @param {object} [opts]
 * @param {boolean} [opts.live=false]
 * @param {object}  [opts.env=process.env]
 * @param {number}  [opts.staleMs=2400000]
 * @param {() => number} [opts.now=Date.now]
 */
export function makeWeatherPanel({ live = false, env = process.env, staleMs = WEATHER_STALE_MS_DEFAULT, now = () => Date.now() } = {}) {
  let state = null;
  let lastOkAt = 0;

  return {
    id: 'weather',
    page: 'picture',
    dwellMs: 15000,

    async poll() {
      try {
        state = live ? await getWeatherFromEnv(env) : getWeatherMock();
        lastOkAt = now();
      } catch (e) { console.log('[weather] poll:', e.message); /* keep last state */ }
    },

    available() { return state != null; },

    stale() { return lastOkAt === 0 || now() - lastOkAt > staleMs; },

    render() { return render(state || {}); },

    /** Not part of the formal Panel interface — the raw reading, for callers that need a change-key
     * (weather-run.mjs's single-panel launcher; the cycler never calls this). */
    state() { return state || {}; },
  };
}
