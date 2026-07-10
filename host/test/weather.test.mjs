// Offline weather-slide tests — no network, no device. Covers the pure logic: the WMO code -> icon
// mapping, the Open-Meteo JSON parse (incl. both-unit fill), and that render() produces a valid
// buildImageTransfer-ready frame. Mirrors host/test/nowplaying.test.mjs. Run: node host/test/weather.test.mjs
import assert from 'node:assert/strict';
import { weatherCodeInfo, parseForecast, getWeatherMock, buildForecastUrl, normalizeUnits } from '../lib/weather.js';
import { render } from '../apps/weather.js';
import { buildImageTransfer, FRAME_BYTES } from '../../src/protocol.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

console.log('AL80 Studio weather-slide / host tests\n');

// ── WMO CODE -> CONDITION + ICON ────────────────────────────────────────────────
ok('weatherCodeInfo maps sample codes to the right icon + text', () => {
  assert.deepEqual(weatherCodeInfo(0, true),  { condition: 'CLEAR', icon: 'sun' });
  assert.deepEqual(weatherCodeInfo(0, false), { condition: 'CLEAR', icon: 'moon' }); // is_day flips clear
  assert.equal(weatherCodeInfo(2).icon, 'cloud');   // partly cloudy
  assert.equal(weatherCodeInfo(3).icon, 'cloud');   // overcast
  assert.equal(weatherCodeInfo(45).icon, 'fog');
  assert.equal(weatherCodeInfo(48).icon, 'fog');
  assert.equal(weatherCodeInfo(51).icon, 'rain');   // drizzle
  assert.equal(weatherCodeInfo(65).icon, 'rain');   // heavy rain
  assert.equal(weatherCodeInfo(71).icon, 'snow');
  assert.equal(weatherCodeInfo(77).icon, 'snow');   // snow grains
  assert.equal(weatherCodeInfo(82).icon, 'rain');   // violent showers
  assert.equal(weatherCodeInfo(85).icon, 'snow');   // snow showers
  assert.equal(weatherCodeInfo(95).icon, 'bolt');
  assert.equal(weatherCodeInfo(99).icon, 'bolt');   // thunderstorm w/ hail
});

ok('weatherCodeInfo condition text is uppercase (font is caps-only)', () => {
  for (const code of [0, 2, 45, 61, 71, 95]) {
    const { condition } = weatherCodeInfo(code, true);
    assert.equal(condition, condition.toUpperCase());
  }
});

ok('weatherCodeInfo falls back to a neutral cloud for an unknown code', () => {
  assert.deepEqual(weatherCodeInfo(1234, true), { condition: '---', icon: 'cloud' });
});

// ── UNIT HELPERS ─────────────────────────────────────────────────────────────────
ok('normalizeUnits coerces to F/C', () => {
  assert.equal(normalizeUnits('c'), 'C');
  assert.equal(normalizeUnits('celsius'), 'C');
  assert.equal(normalizeUnits('F'), 'F');
  assert.equal(normalizeUnits(undefined), 'F');
});

ok('buildForecastUrl carries the no-key Open-Meteo params', () => {
  const u = new URL(buildForecastUrl({ lat: 42.33, lon: -83.05, units: 'F' }));
  assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(u.searchParams.get('latitude'), '42.33');
  assert.equal(u.searchParams.get('longitude'), '-83.05');
  assert.equal(u.searchParams.get('current'), 'temperature_2m,weather_code,is_day');
  assert.equal(u.searchParams.get('daily'), 'temperature_2m_max,temperature_2m_min');
  assert.equal(u.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.equal(u.searchParams.get('timezone'), 'auto');
  assert.equal(new URL(buildForecastUrl({ lat: 0, lon: 0, units: 'C' })).searchParams.get('temperature_unit'), 'celsius');
});

// ── OPEN-METEO PARSE ───────────────────────────────────────────────────────────────
ok('parseForecast normalizes current + daily and fills BOTH units (fetched °F)', () => {
  const data = {
    current: { temperature_2m: 72, weather_code: 2, is_day: 1 },
    daily: { temperature_2m_max: [78], temperature_2m_min: [61] },
  };
  const w = parseForecast(data, { units: 'F', label: 'detroit' });
  assert.equal(w.tempF, 72);
  assert.equal(w.tempC, Math.round((72 - 32) * 5 / 9)); // 22
  assert.equal(w.hiF, 78);
  assert.equal(w.loF, 61);
  assert.equal(w.code, 2);
  assert.equal(w.condition, 'PARTLY CLOUDY');
  assert.equal(w.icon, 'cloud');
  assert.equal(w.isDay, true);
  assert.equal(w.label, 'DETROIT'); // uppercased for the caps-only font
  assert.equal(w.units, 'F');
});

ok('parseForecast fills BOTH units when fetched in °C, and reads is_day=0 as night', () => {
  const data = {
    current: { temperature_2m: 0, weather_code: 0, is_day: 0 },
    daily: { temperature_2m_max: [5], temperature_2m_min: [-3] },
  };
  const w = parseForecast(data, { units: 'C' });
  assert.equal(w.tempC, 0);
  assert.equal(w.tempF, 32);      // 0°C -> 32°F
  assert.equal(w.hiF, 41);        // 5°C -> 41°F
  assert.equal(w.loF, Math.round(-3 * 9 / 5 + 32)); // 27
  assert.equal(w.isDay, false);
  assert.equal(w.icon, 'moon');   // clear + night
});

// ── MOCK ─────────────────────────────────────────────────────────────────────────
ok('getWeatherMock has the weather-state shape', () => {
  const m = getWeatherMock();
  for (const k of ['tempF', 'tempC', 'code', 'condition', 'icon', 'isDay', 'hiF', 'loF', 'label', 'units']) {
    assert.ok(k in m, `missing ${k}`);
  }
  assert.equal(m.icon, 'cloud'); // code 2
});

ok('getWeatherMock accepts overrides (preview any condition)', () => {
  const storm = getWeatherMock({ code: 95 });
  assert.equal(storm.condition, 'THUNDERSTORM');
  assert.equal(storm.icon, 'bolt');
});

// ── CARD RENDER ──────────────────────────────────────────────────────────────────
ok('render(getWeatherMock()) is a FRAME_BYTES frame buildImageTransfer accepts', () => {
  const frame = render(getWeatherMock());
  assert.equal(frame.length, FRAME_BYTES); // 30720
  assert.doesNotThrow(() => buildImageTransfer(frame));
});

ok('render tolerates a partial/empty state without throwing', () => {
  const frame = render({});
  assert.equal(frame.length, FRAME_BYTES);
  assert.doesNotThrow(() => buildImageTransfer(frame));
});

ok('render draws every icon variant at frame size', () => {
  for (const code of [0, 2, 45, 61, 71, 82, 95]) {
    for (const isDay of [true, false]) {
      const frame = render(getWeatherMock({ code, isDay }));
      assert.equal(frame.length, FRAME_BYTES);
      assert.doesNotThrow(() => buildImageTransfer(frame));
    }
  }
});

ok('render handles °C units and negative temps', () => {
  const frame = render(getWeatherMock({ units: 'C', tempC: -5, hiC: 0, loC: -12, code: 71 }));
  assert.equal(frame.length, FRAME_BYTES);
  assert.doesNotThrow(() => buildImageTransfer(frame));
});

console.log(`\n${pass} checks passed.`);
