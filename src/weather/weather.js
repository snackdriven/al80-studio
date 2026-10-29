import { normalizeUnits, buildForecastUrl, parseForecast } from "../lib/weather-common.js";
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

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Detroit — the default when no location is saved (matches the host's getWeatherFromEnv default).
export const DEFAULT_LOCATION = { lat: 42.33, lon: -83.05, label: 'DETROIT', units: 'F' };

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
    throw new Error(`weather.js: Open-Meteo request failed (network): ${e.message}`, { cause: e });
  }
  if (!res.ok) throw new Error(`weather.js: Open-Meteo HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (data?.error) throw new Error(`weather.js: Open-Meteo error: ${data.reason || 'unknown'}`);
  return parseForecast(data, { units: u, label });
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
  // label = just the city (it's drawn on the 96px card, ~15 chars max — region + country overflow it).
  // detail (region, country) rides along for the fuller "Showing …" line in Studio, not the card.
  return {
    lat: hit.latitude,
    lon: hit.longitude,
    label: String(hit.name).toUpperCase(),
    detail: [hit.admin1, hit.country_code || hit.country].filter(Boolean).join(', ').toUpperCase() || null,
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
    throw new Error(`weather.js: geocoding request failed (network): ${e.message}`, { cause: e });
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

// Preserve the weather module API used by the UI, host previews, and tests.
export { weatherCodeInfo, normalizeUnits, buildForecastUrl, parseForecast, getWeatherMock } from '../lib/weather-common.js';
