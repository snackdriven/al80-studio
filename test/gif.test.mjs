import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifFrameCount } from '../src/gif.js';

let decoderClosed = false;

// We use an explicit mock setup for each test because we're overriding global.ImageDecoder.
// To avoid pollution, we capture the original and restore it (even though it's likely undefined).
const originalImageDecoder = global.ImageDecoder;

test('gifFrameCount returns frameCount and closes decoder', async () => {
  try {
    decoderClosed = false;
    global.ImageDecoder = class ImageDecoder {
      constructor() {
        this.tracks = {
          ready: Promise.resolve(),
          selectedTrack: { frameCount: 42 }
        };
        this.completed = Promise.resolve();
      }
      static isTypeSupported() { return Promise.resolve(true); }
      close() { decoderClosed = true; }
    };

    const file = {
      type: 'image/gif',
      arrayBuffer: async () => new ArrayBuffer(0)
    };

    const count = await gifFrameCount(file);
    assert.equal(count, 42);
    assert.equal(decoderClosed, true);
  } finally {
    global.ImageDecoder = originalImageDecoder;
  }
});

test('gifFrameCount returns 0 when no selectedTrack', async () => {
  try {
    decoderClosed = false;
    global.ImageDecoder = class ImageDecoder {
      constructor() {
        this.tracks = {
          ready: Promise.resolve(),
          selectedTrack: null
        };
        this.completed = Promise.resolve();
      }
      static isTypeSupported() { return Promise.resolve(true); }
      close() { decoderClosed = true; }
    };

    const file = {
      type: 'image/gif',
      arrayBuffer: async () => new ArrayBuffer(0)
    };

    const count = await gifFrameCount(file);
    assert.equal(count, 0);
    assert.equal(decoderClosed, true);
  } finally {
    global.ImageDecoder = originalImageDecoder;
  }
});

test('gifFrameCount throws when unsupported type', async () => {
  try {
    decoderClosed = false;
    global.ImageDecoder = class ImageDecoder {
      static isTypeSupported() { return Promise.resolve(false); }
    };

    const file = {
      type: 'image/gif',
      arrayBuffer: async () => new ArrayBuffer(0)
    };

    await assert.rejects(gifFrameCount(file), /cannot decode/);
    assert.equal(decoderClosed, false);
  } finally {
    global.ImageDecoder = originalImageDecoder;
  }
});
