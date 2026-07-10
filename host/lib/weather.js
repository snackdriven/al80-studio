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

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const cToF = (c) => (c == null ? null : c * 9 / 5 + 32);
const fToC = (f) => (f == null ? null : (f - 32) * 5 / 9);
const round = (n) => (n == null ? null : Math.round(n));

// ── WMO WEATHER CODE -> CONDITION + ICON ──────────────────────────────────────────────────────────
// WMO code table (Open-Meteo's `weather_code`). Condition text is UPPERCASE because the 5x7 font is
// caps-only. icon is one of: sun|moon|cloud|rain|snow|bolt|fog (the app knows how to draw each).
// is_day only changes the CLEAR codes (0/1) between sun and moon; everything else reads the same
// day or night, which keeps the map small.

/**
 * Map a WMO weather_code (+ day/night) to display condition text and an icon id.
 * @param {number} code   Open-Meteo weather_code
 * @param {boolean} [isDay=true]  true for daytime (sun), false for night (moon) — clear codes only
 * @returns {{condition:string, icon:('sun'|'moon'|'cloud'|'rain'|'snow'|'bolt'|'fog')}}
 */
export function weatherCodeInfo(code, isDay = true) {
  const clearIcon = isDay ? 'sun' : 'moon';
  switch (code) {
    case 0:  return { condition: 'CLEAR', icon: clearIcon };
    case 1:  return { condition: 'MOSTLY CLEAR', icon: clearIcon };
    case 2:  return { condition: 'PARTLY CLOUDY', icon: 'cloud' };
    case 3:  return { condition: 'OVERCAST', icon: 'cloud' };
    case 45:
    case 48: return { condition: 'FOG', icon: 'fog' };
    case 51:
    case 53:
    case 55: return { condition: 'DRIZZLE', icon: 'rain' };
    case 56:
    case 57: return { condition: 'ICY DRIZZLE', icon: 'rain' };
    case 61:
    case 63:
    case 65: return { condition: 'RAIN', icon: 'rain' };
    case 66:
    case 67: return { condition: 'ICY RAIN', icon: 'rain' };
    case 71:
    case 73:
    case 75: return { condition: 'SNOW', icon: 'snow' };
    case 77: return { condition: 'SNOW GRAINS', icon: 'snow' };
    case 80:
    case 81:
    case 82: return { condition: 'SHOWERS', icon: 'rain' };
    case 85:
    case 86: return { condition: 'SNOW SHOWERS', icon: 'snow' };
    case 95: return { condition: 'THUNDERSTORM', icon: 'bolt' };
    case 96:
    case 99: return { condition: 'THUNDERSTORM', icon: 'bolt' };
    default: return { condition: '---', icon: 'cloud' }; // unknown/future code -> neutral cloud
  }
}

/** Normalize a units input to 'F' or 'C' (default 'F'). Accepts 'f'/'c'/'fahrenheit'/'celsius'. */
export function normalizeUnits(u) {
  const s = String(u || 'F').trim().toUpperCase();
  return s.startsWith('C') ? 'C' : 'F';
}

/**
 * Build the Open-Meteo forecast URL for one point. Requests current temp + weather_code + is_day and
 * today's daily max/min, in the requested unit, with timezone=auto so "today" is the location's day.
 * @param {{lat:number, lon:number, units:('F'|'C')}} p
 * @returns {string}
 */
export function buildForecastUrl({ lat, lon, units = 'F' }) {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,weather_code,is_day',
    daily: 'temperature_2m_max,temperature_2m_min',
    temperature_unit: units === 'C' ? 'celsius' : 'fahrenheit',
    timezone: 'auto',
    forecast_days: '1',
  });
  return `${FORECAST_URL}?${q.toString()}`;
}

/**
 * Normalize an Open-Meteo forecast JSON payload to the weather state shape render() draws. Fills
 * BOTH unit variants by converting from whatever unit was fetched. Pure — no network.
 * @param {object} data     parsed Open-Meteo response
 * @param {object} p        { units:'F'|'C', label:string }  the request context
 * @returns {{tempF,tempC,code,condition,icon,isDay,hiF,loF,hiC,loC,label,units}}
 */
export function parseForecast(data, { units = 'F', label = 'LOCAL' } = {}) {
  const cur = data?.current || {};
  const daily = data?.daily || {};
  const code = Number(cur.weather_code ?? 0);
  const isDay = cur.is_day == null ? true : !!cur.is_day;
  const temp = cur.temperature_2m;
  const hi = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : daily.temperature_2m_max;
  const lo = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : daily.temperature_2m_min;
  // convert to the other unit so both are always populated
  const asF = (v) => (units === 'C' ? cToF(v) : v);
  const asC = (v) => (units === 'C' ? v : fToC(v));
  const { condition, icon } = weatherCodeInfo(code, isDay);
  return {
    tempF: round(asF(temp)), tempC: round(asC(temp)),
    hiF: round(asF(hi)), loF: round(asF(lo)),
    hiC: round(asC(hi)), loC: round(asC(lo)),
    code, condition, icon, isDay,
    label: String(label || 'LOCAL').toUpperCase(),
    units,
  };
}

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
    throw new Error(`weather.js: Open-Meteo request failed (network): ${e.message}`);
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

/**
 * Mock weather — same shape as getWeather, zero network, zero config. Lets the render pipeline and
 * tests run with nothing set up. A mild-day partly-cloudy sample.
 * @param {object} [over]  optional field overrides (e.g. { code: 95 } to preview a thunderstorm)
 * @returns {{tempF,tempC,code,condition,icon,isDay,hiF,loF,hiC,loC,label,units}}
 */
export function getWeatherMock(over = {}) {
  const base = {
    tempF: 72, tempC: 22,
    hiF: 78, loF: 61,
    hiC: 26, loC: 16,
    code: 2, isDay: true,
    label: 'DETROIT',
    units: 'F',
  };
  const merged = { ...base, ...over };
  const info = weatherCodeInfo(merged.code, merged.isDay);
  return { ...merged, condition: info.condition, icon: info.icon };
}
