import { normalizeUnits, buildForecastUrl, parseForecast } from "../../src/lib/weather-common.js";

// Open-Meteo "current weather" source for the weather slide. Zero-dep, zero-credential: global
// fetch (Node 18+) against https://api.open-meteo.com/v1/forecast, which needs NO API key and NO
// signup. That's the whole reason it's the pick over OpenWeatherMap/WeatherAPI/Tomorrow.io — same
// spirit as the Spotify mock, a run with nothing configured is possible. There's a MOCK function so
// the render pipeline runs with zero network too.
//
// ── CONFIG (env, no geocoding for the scaffold) ─────────────────────────────────────────────────
//   WEATHER_LAT    latitude  (default 42.33, Detroit)
//   WEATHER_LON    longitude (default -83.05)
//   WEATHER_UNITS  'F' or 'C' (default 'F')
//   WEATHER_LABEL  location text drawn on the card (default 'LOCAL')
// getWeatherFromEnv(env) reads these and calls getWeather() — mirrors spotify.getAccessToken(env).
// FUTURE: a geocode(name) helper against Open-Meteo's free geocoding endpoint so WEATHER_PLACE=Detroit
// resolves lat/lon/label automatically. Out of scope here — lat/lon come straight from env.
//
// Open-Meteo returns exactly one temperature unit per request. We fetch in the configured unit and
// convert to the other on our side, so the normalized state carries BOTH tempF/tempC (and hi/lo in
// both) no matter what was asked for. render() then draws whichever state.units names. Keeps the app
// pure and unit-agnostic; the lib owns the conversion.

/**
 * Fetch current weather for a point and normalize it. Throws clear messages on any failure so the
 * runner can log and retry on the next poll.
 * @param {{lat:number|string, lon:number|string, units?:('F'|'C'), label?:string}} p
 * @returns {Promise<{tempF,tempC,code,condition,icon,isDay,hiF,loF,hiC,loC,label,units}>}
 */
export async function getWeather({ lat, lon, units = 'F', label = 'LOCAL' } = {}) {
  if (lat == null || lon == null || lat === '' || lon === '') {
    throw new Error('weather.js: getWeather needs lat and lon (set WEATHER_LAT / WEATHER_LON). For a network-free run use getWeatherMock().');
  }
  const u = normalizeUnits(units);
  const url = buildForecastUrl({ lat: Number(lat), lon: Number(lon), units: u });
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`weather.js: Open-Meteo request failed (network): ${e.message}`, { cause: e });
  }
  if (!res.ok) throw new Error(`weather.js: Open-Meteo HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (data?.error) throw new Error(`weather.js: Open-Meteo error: ${data.reason || 'unknown'}`);
  return parseForecast(data, { units: u, label });
}

/**
 * Daemon-facing convenience: read WEATHER_LAT/LON/UNITS/LABEL from env and fetch. Mirrors
 * spotify.getAccessToken(env). Defaults to Detroit in Fahrenheit so a run with nothing set still
 * works (against the live API).
 * @param {object} [env=process.env]
 * @returns {Promise<object>} same shape as getWeather()
 */
export function getWeatherFromEnv(env = process.env) {
  return getWeather({
    lat: env.WEATHER_LAT ?? 42.33,
    lon: env.WEATHER_LON ?? -83.05,
    units: normalizeUnits(env.WEATHER_UNITS),
    label: env.WEATHER_LABEL || 'DETROIT',
  });
}

// Preserve the weather module API used by the UI, host previews, and tests.
export { weatherCodeInfo, normalizeUnits, buildForecastUrl, parseForecast, getWeatherMock } from '../../src/lib/weather-common.js';
