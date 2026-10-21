import assert from 'node:assert/strict';
import { fitDraw } from '../src/image.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

console.log('AL80 Studio image.js tests\n');

class MockContext {
  constructor() {
    this.fillStyle = '';
    this.fillRects = [];
    this.drawImages = [];
  }
  fillRect(x, y, w, h) {
    this.fillRects.push({ x, y, w, h, fillStyle: this.fillStyle });
  }
  drawImage(img, x, y, w, h) {
    this.drawImages.push({ img, x, y, w, h });
  }
}

const mockImg = (w, h) => ({ naturalWidth: w, naturalHeight: h });

ok('fitDraw stretch', () => {
  const ctx = new MockContext();
  const img = mockImg(100, 100);
  fitDraw(ctx, img, 200, 300, 'stretch', '#000');
  assert.equal(ctx.drawImages.length, 1);
  assert.deepEqual(ctx.drawImages[0], { img, x: 0, y: 0, w: 200, h: 300 });
});

ok('fitDraw contain', () => {
  const ctx = new MockContext();
  const img = mockImg(100, 50); // aspect ratio 2
  fitDraw(ctx, img, 200, 200, 'contain', '#123456');

  assert.equal(ctx.fillRects.length, 1);
  assert.deepEqual(ctx.fillRects[0], { x: 0, y: 0, w: 200, h: 200, fillStyle: '#123456' });

  assert.equal(ctx.drawImages.length, 1);
  // scale = min(200/100, 200/50) = min(2, 4) = 2
  // dw = 200, dh = 100
  // x = (200 - 200)/2 = 0, y = (200 - 100)/2 = 50
  assert.deepEqual(ctx.drawImages[0], { img, x: 0, y: 50, w: 200, h: 100 });
});

ok('fitDraw cover', () => {
  const ctx = new MockContext();
  const img = mockImg(100, 50); // aspect ratio 2
  fitDraw(ctx, img, 200, 200, 'cover', '#000');

  assert.equal(ctx.fillRects.length, 0);

  assert.equal(ctx.drawImages.length, 1);
  // scale = max(200/100, 200/50) = max(2, 4) = 4
  // dw = 400, dh = 200
  // x = (200 - 400)/2 = -100, y = (200 - 200)/2 = 0
  assert.deepEqual(ctx.drawImages[0], { img, x: -100, y: 0, w: 400, h: 200 });
});

console.log(`\n${pass} checks passed.`);
