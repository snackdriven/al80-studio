// Open-Meteo "current weather" source for the in-app weather card — the browser port of
// host/lib/weather.js. Zero-credential: Open-Meteo needs NO API key and NO signup, and it sends
// permissive CORS headers, so the browser can fetch it directly with no proxy (same reason the host
// picked it — a run with nothing configured is possible, like the Spotify mock). getWeatherMock()
// runs the render pipeline with zero network too.
//
// Open-Meteo returns exactly one temperature unit per request. We fetch in the configured unit and
// convert to the other on our side, so the normalized state carries BOTH tempF/tempC (and hi/lo in
// both) no matter what was asked for. card.render() then draws whichever state.units names. Keeps the
// card pure and unit-agnostic; this lib owns the conversion.
//
// LOCATION: unlike the host scaffold (env lat/lon only), the browser tab lets the user type a place
// NAME. geocode(name) resolves it against Open-Meteo's free geocoding endpoint to {lat, lon, label},
// and loadLocation()/saveLocation() persist the pick in localStorage (mirrors spotify.js's
// loadRefreshToken/saveRefreshToken). Defaults to Detroit when nothing is saved.
//
// The pure helpers (weatherCodeInfo, normalizeUnits, buildForecastUrl, parseForecast, shapeGeocode)
// touch no DOM/network, so they unit-test under Node too.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Detroit — the default when no location is saved (matches the host's getWeatherFromEnv default).
export const DEFAULT_LOCATION = { lat: 42.33, lon: -83.05, label: 'DETROIT', units: 'F' };

const cToF = (c) => (c == null ? null : c * 9 / 5 + 32);
const fToC = (f) => (f == null ? null : (f - 32) * 5 / 9);
const round = (n) => (n == null ? null : Math.round(n));

// ── WMO WEATHER CODE -> CONDITION + ICON ──────────────────────────────────────────────────────────
// WMO code table (Open-Meteo's `weather_code`). Condition text is UPPERCASE because the 5x7 font is
// caps-only. icon is one of: sun|moon|cloud|rain|snow|bolt|fog (card.js knows how to draw each).
// is_day only changes the CLEAR codes (0/1) between sun and moon; everything else reads the same
// day or night, which keeps the map small. Ported verbatim from host/lib/weather.js.

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
 * Normalize an Open-Meteo forecast JSON payload to the weather state shape card.render() draws. Fills
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
 * poll loop can log and retry on the next tick.
 * @param {{lat:number|string, lon:number|string, units?:('F'|'C'), label?:string}} p
 * @returns {Promise<{tempF,tempC,code,condition,icon,isDay,hiF,loF,hiC,loC,label,units}>}
 */
export async function getWeather({ lat, lon, units = 'F', label = 'LOCAL' } = {}) {
  if (lat == null || lon == null || lat === '' || lon === '') {
    throw new Error('weather.js: getWeather needs lat and lon. Set a location, or use getWeatherMock() for a network-free run.');
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

// ── GEOCODING (place name -> lat/lon/label) ──────────────────────────────────────────────────────
// The key "set location" primitive: the user types a place name, we resolve it to a point + a
// human label. Open-Meteo's geocoding endpoint is also key-free and CORS-friendly.

/**
 * Shape one Open-Meteo geocoding result into our location record. Pure (no network) so it's testable.
 * The label is the place name plus its admin1/country for disambiguation ("DETROIT, MICHIGAN, US"),
 * uppercased for the caps-only font.
 * @param {object} data   parsed body of the geocoding search response
 * @returns {{lat:number, lon:number, label:string}}
 * @throws if there's no usable match
 */
export function shapeGeocode(data) {
  const hit = data?.results?.[0];
  if (!hit || hit.latitude == null || hit.longitude == null) {
    throw new Error('weather.js: no place matched that name — try a city, or add a state/country.');
  }
  const parts = [hit.name, hit.admin1, hit.country_code || hit.country].filter(Boolean);
  return {
    lat: hit.latitude,
    lon: hit.longitude,
    label: parts.join(', ').toUpperCase(),
  };
}

/**
 * Resolve a place name to {lat, lon, label}. Browser fetch against Open-Meteo's geocoder (no key).
 * @param {string} name   e.g. "Detroit", "Paris, France"
 * @returns {Promise<{lat:number, lon:number, label:string}>}
 * @throws if the name is empty, the request fails, or nothing matches
 */
export async function geocode(name) {
  const q = String(name || '').trim();
  if (!q) throw new Error('weather.js: geocode needs a place name.');
  const url = `${GEOCODE_URL}?${new URLSearchParams({ name: q, count: '1', language: 'en', format: 'json' })}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`weather.js: geocoding request failed (network): ${e.message}`);
  }
  if (!res.ok) throw new Error(`weather.js: geocoding HTTP ${res.status} ${await res.text()}`);
  return shapeGeocode(await res.json());
}

// ── LOCATION PERSISTENCE (localStorage; browser-only) ─────────────────────────────────────────────
// Mirrors spotify.js's loadRefreshToken/saveRefreshToken. One key holds the whole pick so a reload
// comes back to the same place + units.

const LS_LOCATION = 'al80.weather.location';

/**
 * The saved location, or the Detroit default if nothing's stored / storage is unavailable. Always
 * returns a complete {lat, lon, label, units} record with normalized units.
 * @returns {{lat:number, lon:number, label:string, units:('F'|'C')}}
 */
export function loadLocation() {
  try {
    const raw = localStorage.getItem(LS_LOCATION);
    if (!raw) return { ...DEFAULT_LOCATION };
    const o = JSON.parse(raw);
    if (o == null || o.lat == null || o.lon == null) return { ...DEFAULT_LOCATION };
    return {
      lat: Number(o.lat),
      lon: Number(o.lon),
      label: String(o.label || 'LOCAL').toUpperCase(),
      units: normalizeUnits(o.units),
    };
  } catch {
    return { ...DEFAULT_LOCATION };
  }
}

/**
 * Persist a location pick. Merges over whatever's saved so callers can update just units or just the
 * place without losing the rest.
 * @param {{lat?:number, lon?:number, label?:string, units?:('F'|'C')}} patch
 * @returns {{lat:number, lon:number, label:string, units:('F'|'C')}} the merged, saved record
 */
export function saveLocation(patch = {}) {
  const next = { ...loadLocation(), ...patch };
  next.units = normalizeUnits(next.units);
  if (next.label != null) next.label = String(next.label).toUpperCase();
  try { localStorage.setItem(LS_LOCATION, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}
