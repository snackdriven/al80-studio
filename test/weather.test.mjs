// Weather pure-logic tests — no hardware, no Open-Meteo network. Covers the WMO code map, the
// forecast-URL builder, the forecast parse (both units), the geocoding-response shaper, and that the
// card renderer produces a valid buildImageTransfer-ready frame. Run: node test/weather.test.mjs
import assert from 'node:assert/strict';
import {
  weatherCodeInfo, normalizeUnits, buildForecastUrl, parseForecast, getWeatherMock, shapeGeocode, loadLocation, saveLocation, DEFAULT_LOCATION, getWeather
} from '../src/weather/weather.js';
import { render as renderCard } from '../src/weather/card.js';
import { buildImageTransfer, FRAME_BYTES } from '../src/protocol.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };
const okAsync = async (name, fn) => { await fn(); pass++; console.log('  ok -', name); };

console.log('Weather pure-logic tests\n');

// ── WMO CODE -> CONDITION + ICON ──────────────────────────────────────────────────
ok('weatherCodeInfo maps clear codes by day/night, and buckets the WMO ranges', () => {
  assert.deepEqual(weatherCodeInfo(0, true), { condition: 'CLEAR', icon: 'sun' });
  assert.deepEqual(weatherCodeInfo(0, false), { condition: 'CLEAR', icon: 'moon' });
  assert.deepEqual(weatherCodeInfo(1, true), { condition: 'MOSTLY CLEAR', icon: 'sun' });
  assert.deepEqual(weatherCodeInfo(2), { condition: 'PARTLY CLOUDY', icon: 'cloud' });
  assert.deepEqual(weatherCodeInfo(3), { condition: 'OVERCAST', icon: 'cloud' });
  assert.deepEqual(weatherCodeInfo(48), { condition: 'FOG', icon: 'fog' });
  assert.deepEqual(weatherCodeInfo(53), { condition: 'DRIZZLE', icon: 'rain' });
  assert.deepEqual(weatherCodeInfo(63), { condition: 'RAIN', icon: 'rain' });
  assert.deepEqual(weatherCodeInfo(73), { condition: 'SNOW', icon: 'snow' });
  assert.deepEqual(weatherCodeInfo(81), { condition: 'SHOWERS', icon: 'rain' });
  assert.deepEqual(weatherCodeInfo(86), { condition: 'SNOW SHOWERS', icon: 'snow' });
  assert.deepEqual(weatherCodeInfo(95), { condition: 'THUNDERSTORM', icon: 'bolt' });
  assert.deepEqual(weatherCodeInfo(99), { condition: 'THUNDERSTORM', icon: 'bolt' });
  // unknown/future code -> neutral cloud, never throws
  assert.deepEqual(weatherCodeInfo(1234), { condition: '---', icon: 'cloud' });
});

// ── UNITS ─────────────────────────────────────────────────────────────────────────
ok('normalizeUnits collapses to F or C', () => {
  assert.equal(normalizeUnits('c'), 'C');
  assert.equal(normalizeUnits('Celsius'), 'C');
  assert.equal(normalizeUnits('f'), 'F');
  assert.equal(normalizeUnits('fahrenheit'), 'F');
  assert.equal(normalizeUnits(undefined), 'F'); // default
  assert.equal(normalizeUnits('nonsense'), 'F');
});

// ── FORECAST URL ────────────────────────────────────────────────────────────────────
ok('buildForecastUrl carries lat/lon, the current+daily fields, unit, and timezone=auto', () => {
  const url = buildForecastUrl({ lat: 42.33, lon: -83.05, units: 'C' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(u.searchParams.get('latitude'), '42.33');
  assert.equal(u.searchParams.get('longitude'), '-83.05');
  assert.equal(u.searchParams.get('current'), 'temperature_2m,weather_code,is_day');
  assert.equal(u.searchParams.get('daily'), 'temperature_2m_max,temperature_2m_min');
  assert.equal(u.searchParams.get('temperature_unit'), 'celsius');
  assert.equal(u.searchParams.get('timezone'), 'auto');
  assert.equal(u.searchParams.get('forecast_days'), '1');
  // default unit is fahrenheit
  assert.equal(new URL(buildForecastUrl({ lat: 1, lon: 2 })).searchParams.get('temperature_unit'), 'fahrenheit');
});

// ── FORECAST PARSE ──────────────────────────────────────────────────────────────────
const sampleF = {
  current: { temperature_2m: 72, weather_code: 2, is_day: 1 },
  daily: { temperature_2m_max: [78], temperature_2m_min: [61] },
};

ok('parseForecast maps a fahrenheit payload and fills BOTH unit variants', () => {
  const s = parseForecast(sampleF, { units: 'F', label: 'detroit' });
  assert.equal(s.tempF, 72);
  assert.equal(s.tempC, 22);           // (72-32)*5/9 = 22.2 -> 22
  assert.equal(s.hiF, 78);
  assert.equal(s.loF, 61);
  assert.equal(s.hiC, 26);             // (78-32)*5/9 = 25.6 -> 26
  assert.equal(s.loC, 16);             // (61-32)*5/9 = 16.1 -> 16
  assert.equal(s.code, 2);
  assert.equal(s.condition, 'PARTLY CLOUDY');
  assert.equal(s.icon, 'cloud');
  assert.equal(s.isDay, true);
  assert.equal(s.label, 'DETROIT');    // uppercased for the caps-only font
  assert.equal(s.units, 'F');
});

ok('parseForecast maps a celsius payload and converts up to fahrenheit', () => {
  const s = parseForecast({
    current: { temperature_2m: 0, weather_code: 71, is_day: 0 },
    daily: { temperature_2m_max: [5], temperature_2m_min: [-3] },
  }, { units: 'C', label: 'oslo' });
  assert.equal(s.tempC, 0);
  assert.equal(s.tempF, 32);           // 0C -> 32F
  assert.equal(s.hiC, 5);
  assert.equal(s.loC, -3);
  assert.equal(s.hiF, 41);             // 5C -> 41F
  assert.equal(s.loF, 27);             // -3C -> 26.6 -> 27F
  assert.equal(s.condition, 'SNOW');
  assert.equal(s.icon, 'snow');
  assert.equal(s.isDay, false);        // is_day 0 at night
  assert.equal(s.units, 'C');
});

ok('parseForecast survives an empty/partial payload without throwing', () => {
  const s = parseForecast({}, {});
  assert.equal(s.code, 0);
  assert.equal(s.isDay, true);         // missing is_day defaults to day
  assert.equal(s.label, 'LOCAL');
  assert.equal(s.units, 'F');
});

// ── MOCK ─────────────────────────────────────────────────────────────────────────────
ok('getWeatherMock returns a complete state and honors overrides', () => {
  const m = getWeatherMock();
  assert.equal(m.condition, 'PARTLY CLOUDY');
  assert.equal(m.icon, 'cloud');
  assert.equal(m.units, 'F');
  // an override recomputes condition + icon from the new code
  const storm = getWeatherMock({ code: 95 });
  assert.equal(storm.condition, 'THUNDERSTORM');
  assert.equal(storm.icon, 'bolt');
});

// ── GEOCODE SHAPER ─────────────────────────────────────────────────────────────────
ok('shapeGeocode builds {lat,lon,label,detail} — label is the city (fits the card), detail carries the rest', () => {
  const g = shapeGeocode({
    results: [{ name: 'Detroit', admin1: 'Michigan', country_code: 'US', latitude: 42.33, longitude: -83.05 }],
  });
  assert.equal(g.lat, 42.33);
  assert.equal(g.lon, -83.05);
  assert.equal(g.label, 'DETROIT');            // city only — the 96px card can't fit region + country
  assert.equal(g.detail, 'MICHIGAN, US');      // fuller place for Studio's "Showing …" line
});

ok('shapeGeocode throws a clear error when nothing matches', () => {
  assert.throws(() => shapeGeocode({ results: [] }), /no place matched/i);
  assert.throws(() => shapeGeocode({}), /no place matched/i);
  assert.throws(() => shapeGeocode({ results: [{ name: 'X' }] }), /no place matched/i); // no lat/lon
});

// ── CARD RENDER (pure — no document) ───────────────────────────────────────────────
ok('renderCard produces a FRAME_BYTES frame that buildImageTransfer accepts (mock state)', () => {
  const frame = renderCard(getWeatherMock());
  assert.equal(frame.length, FRAME_BYTES);
  assert.doesNotThrow(() => buildImageTransfer(frame));
});

ok('renderCard handles every icon + a partial state without throwing', () => {
  for (const code of [0, 1, 2, 3, 45, 51, 61, 71, 80, 95]) {
    const frame = renderCard(getWeatherMock({ code, isDay: code % 2 === 0 }));
    assert.equal(frame.length, FRAME_BYTES);
  }
  // partial state (no hi/lo, no label) still renders
  const bare = renderCard({ tempF: 5, units: 'F', icon: 'moon' });
  assert.equal(bare.length, FRAME_BYTES);
});


// ── LOCATION PERSISTENCE ─────────────────────────────────────────────────────────────
ok('loadLocation throws/catches localStorage errors and falls back to default', () => {
  global.localStorage = {
    getItem: () => { throw new Error('Simulated localStorage error'); }
  };
  try {
    const loc = loadLocation();
    assert.equal(loc.label, 'DETROIT');
    assert.equal(loc.units, 'F');
    assert.equal(loc.lat, 42.33);
    assert.equal(loc.lon, -83.05);
  } finally {
    delete global.localStorage;
  }
});

ok('loadLocation and saveLocation handles normal persistence', () => {
  let store = {};
  global.localStorage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = String(v); }
  };
  try {
    const defaultLoc = loadLocation();
    assert.equal(defaultLoc.label, 'DETROIT');
    assert.equal(defaultLoc.units, 'F');

    const next = saveLocation({ lat: 40.71, lon: -74.00, label: 'New York', units: 'c' });
    assert.equal(next.lat, 40.71);
    assert.equal(next.lon, -74.00);
    assert.equal(next.label, 'NEW YORK');
    assert.equal(next.units, 'C');

    const loaded = loadLocation();
    assert.deepEqual(loaded, next);
  } finally {
    delete global.localStorage;
  }
});

ok('loadLocation recovers from missing/corrupt fields in localStorage', () => {
  let store = {};
  global.localStorage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = String(v); }
  };
  try {
    store['al80.weather.location'] = JSON.stringify({ label: 'Nowhere' }); // missing lat/lon
    const loaded = loadLocation();
    assert.equal(loaded.label, 'DETROIT'); // fell back to default
  } finally {
    delete global.localStorage;
  }
});

// ── STORAGE ────────────────────────────────────────────────────────────────────────
ok('saveLocation and loadLocation handle regular storage correctly', () => {
  const originalLocalStorage = global.localStorage;
  try {
    const store = {};
    global.localStorage = {
      getItem: (k) => store[k] || null,
      setItem: (k, v) => { store[k] = String(v); },
    };

    // Start empty, should be DEFAULT_LOCATION
    assert.deepEqual(loadLocation(), DEFAULT_LOCATION);

    // Save a full override
    const toSave = { lat: 10, lon: 20, label: 'test city', units: 'c' };
    const expected = { lat: 10, lon: 20, label: 'TEST CITY', units: 'C' };
    assert.deepEqual(saveLocation(toSave), expected);
    assert.deepEqual(loadLocation(), expected);

    // Save a partial override (just units)
    assert.deepEqual(saveLocation({ units: 'F' }), { ...expected, units: 'F' });
    assert.deepEqual(loadLocation(), { ...expected, units: 'F' });
  } finally {
    global.localStorage = originalLocalStorage;
  }
});

ok('saveLocation handles localStorage.setItem throwing (private mode edge case)', () => {
  const originalLocalStorage = global.localStorage;
  try {
    global.localStorage = {
      getItem: () => null, // always return empty, defaults to DEFAULT_LOCATION
      setItem: () => { throw new Error('QuotaExceededError'); },
    };

    const toSave = { lat: 99, lon: 88, label: 'nowhere', units: 'F' };
    const expected = { lat: 99, lon: 88, label: 'NOWHERE', units: 'F' };
    assert.deepEqual(saveLocation(toSave), expected); // should not throw, returns the merged object
  } finally {
    global.localStorage = originalLocalStorage;
  }
});

// ── GETWEATHER (async + fetch) ──────────────────────────────────────────────────────
await okAsync('getWeather validates required arguments before fetching', async () => {
  await assert.rejects(() => getWeather(), /needs lat and lon/i);
  await assert.rejects(() => getWeather({ lat: null, lon: null }), /needs lat and lon/i);
  await assert.rejects(() => getWeather({ lat: '', lon: '' }), /needs lat and lon/i);
});

await okAsync('getWeather handles network and HTTP errors gracefully', async () => {
  const originalFetch = global.fetch;
  try {
    // 1. Network failure
    global.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    await assert.rejects(() => getWeather({ lat: 1, lon: 1 }), /request failed \(network\): ECONNREFUSED/i);

    // 2. HTTP error response
    global.fetch = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('Server Error') });
    await assert.rejects(() => getWeather({ lat: 1, lon: 1 }), /HTTP 500 Server Error/i);

    // 3. Application-level error payload
    global.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ error: true, reason: 'Rate limited' })
    });
    await assert.rejects(() => getWeather({ lat: 1, lon: 1 }), /Open-Meteo error: Rate limited/i);
  } finally {
    global.fetch = originalFetch;
  }
});

await okAsync('getWeather returns parsed forecast on success', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      assert.match(url, /latitude=42/);
      assert.match(url, /longitude=-83/);
      return {
        ok: true,
        json: () => Promise.resolve({
          current: { temperature_2m: 72, weather_code: 2, is_day: 1 },
          daily: { temperature_2m_max: [78], temperature_2m_min: [61] }
        })
      };
    };
    const res = await getWeather({ lat: 42, lon: -83, units: 'F', label: 'Detroit' });
    assert.equal(res.tempF, 72);
    assert.equal(res.condition, 'PARTLY CLOUDY');
    assert.equal(res.label, 'DETROIT');
  } finally {
    global.fetch = originalFetch;
  }
});

console.log(`\n${pass} checks passed.`);
