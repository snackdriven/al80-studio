export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

export const cToF = (c) => (c == null ? null : c * 9 / 5 + 32);
export const fToC = (f) => (f == null ? null : (f - 32) * 5 / 9);
export const round = (n) => (n == null ? null : Math.round(n));

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
    default: return { condition: '---', icon: 'cloud' };
  }
}

export function normalizeUnits(u) {
  const s = String(u || 'F').trim().toUpperCase();
  return s.startsWith('C') ? 'C' : 'F';
}

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

export function parseForecast(data, { units = 'F', label = 'LOCAL' } = {}) {
  const cur = data?.current || {};
  const daily = data?.daily || {};
  const code = Number(cur.weather_code ?? 0);
  const isDay = cur.is_day == null ? true : !!cur.is_day;
  const temp = cur.temperature_2m;
  const hi = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : daily.temperature_2m_max;
  const lo = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : daily.temperature_2m_min;

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
