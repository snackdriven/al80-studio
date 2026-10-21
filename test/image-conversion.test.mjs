import assert from 'node:assert/strict';
import { frameToRGBA } from '../src/image.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

console.log('AL80 Studio image conversion tests\n');

ok('frameToRGBA correctly expands RGB565-BE array to RGBA', () => {
  // RGB565 is 16 bits (2 bytes).
  // Red is 5 bits, Green is 6 bits, Blue is 5 bits.

  // Test cases:
  // Black: 0x0000 -> 0000 0000 0000 0000 -> R=0, G=0, B=0
  // White: 0xFFFF -> 1111 1111 1111 1111 -> R=31, G=63, B=31 -> expand -> R=255, G=255, B=255
  // Red: 0xF800 -> 1111 1000 0000 0000 -> R=31, G=0, B=0 -> expand -> R=255, G=0, B=0
  // Green: 0x07E0 -> 0000 0111 1110 0000 -> R=0, G=63, B=0 -> expand -> R=0, G=255, B=0
  // Blue: 0x001F -> 0000 0000 0001 1111 -> R=0, G=0, B=31 -> expand -> R=0, G=0, B=255

  const frame = new Uint8Array([
    0x00, 0x00, // Black
    0xFF, 0xFF, // White
    0xF8, 0x00, // Red
    0x07, 0xE0, // Green
    0x00, 0x1F  // Blue
  ]);

  const rgba = frameToRGBA(frame);

  assert.equal(rgba.length, 5 * 4);

  // Black
  assert.equal(rgba[0], 0);
  assert.equal(rgba[1], 0);
  assert.equal(rgba[2], 0);
  assert.equal(rgba[3], 255); // Alpha is always 255

  // White
  assert.equal(rgba[4], 255);
  assert.equal(rgba[5], 255);
  assert.equal(rgba[6], 255);
  assert.equal(rgba[7], 255);

  // Red
  assert.equal(rgba[8], 255);
  assert.equal(rgba[9], 0);
  assert.equal(rgba[10], 0);
  assert.equal(rgba[11], 255);

  // Green
  assert.equal(rgba[12], 0);
  assert.equal(rgba[13], 255);
  assert.equal(rgba[14], 0);
  assert.equal(rgba[15], 255);

  // Blue
  assert.equal(rgba[16], 0);
  assert.equal(rgba[17], 0);
  assert.equal(rgba[18], 255);
  assert.equal(rgba[19], 255);
});

console.log(`\n# pass ${pass}`);
