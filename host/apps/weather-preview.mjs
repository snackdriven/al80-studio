// Device-free preview for the weather slide. Renders sample conditions to PNGs so the LAYOUT and
// each weather icon are visible with no hardware and no network, and runs every frame through
// buildImageTransfer to confirm the packet stream is valid.
//   node host/apps/weather-preview.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { render } from './weather.js';
import { getWeatherMock } from '../lib/weather.js';
import { buildImageTransfer, WIDTH, HEIGHT, FRAME_BYTES } from '../../src/protocol.js';
import { encodePNG, rgb565ToRGB } from '../lib/png.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Write a canonical (row-major) RGB565 frame to a PNG at integer zoom — the real visible layout. */
function savePNG(path, fb, scale = 3) {
  const { rgb, width, height } = rgb565ToRGB(fb, WIDTH, HEIGHT, scale);
  writeFileSync(path, encodePNG(width, height, rgb));
}

// One sample per icon so all seven are visible; getWeatherMock recomputes condition + icon from code.
const samples = [
  { file: 'weather-preview-1-partly.png',   label: 'partly cloudy (mock)', state: getWeatherMock() },
  { file: 'weather-preview-2-clear-day.png', label: 'clear day (sun)',      state: getWeatherMock({ code: 0, isDay: true, tempF: 84, hiF: 88, loF: 67 }) },
  { file: 'weather-preview-3-clear-night.png', label: 'clear night (moon)', state: getWeatherMock({ code: 0, isDay: false, tempF: 58, hiF: 84, loF: 55 }) },
  { file: 'weather-preview-4-rain.png',     label: 'rain',                  state: getWeatherMock({ code: 63, tempF: 51, hiF: 55, loF: 44 }) },
  { file: 'weather-preview-5-snow.png',     label: 'snow',                  state: getWeatherMock({ code: 73, tempF: 28, hiF: 31, loF: 19 }) },
  { file: 'weather-preview-6-thunder.png',  label: 'thunderstorm (bolt)',   state: getWeatherMock({ code: 95, tempF: 69, hiF: 75, loF: 60 }) },
  { file: 'weather-preview-7-fog-C.png',    label: 'fog, °C, negative',     state: getWeatherMock({ code: 45, units: 'C', tempC: -3, hiC: 1, loC: -6, label: 'OSLO' }) },
];

console.log('AL80 weather preview (no device)\n');
let allOk = true;
for (const s of samples) {
  const fb = render(s.state);
  const okSize = fb.length === FRAME_BYTES;
  let pkts = 0;
  try { pkts = buildImageTransfer(fb).length; } catch (e) { console.log('  build failed:', e.message); allOk = false; }
  savePNG(join(HERE, s.file), fb, 3); // PNG from the row-major frame = the visible layout
  allOk = allOk && okSize;
  console.log(`  ${s.label.padEnd(22)} ${okSize ? 'ok' : 'BAD SIZE ***'}  ${pkts} pkts  -> ${s.file}`);
}
console.log('\n' + (allOk ? 'ALL OK — weather layouts rendered (96x160, 30720B).' : '*** FAILURES ***'));
process.exit(allOk ? 0 : 1);
