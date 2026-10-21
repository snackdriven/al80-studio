import assert from 'node:assert/strict';
import { getDevice, connect, disconnect } from '../src/hid.js';
import { VID, PID, USAGE_PAGE, USAGE } from '../src/protocol.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

console.log('AL80 Studio hid module tests\n');

// 1. Setup mock navigator for connect/disconnect
Object.defineProperty(globalThis, 'navigator', {
  value: {
    hid: {
      getDevices: async () => [],
      requestDevice: async () => [mockDevice],
      addEventListener: () => {},
      removeEventListener: () => {}
    }
  },
  writable: true,
  configurable: true
});

const mockDevice = {
  vendorId: VID,
  productId: PID,
  collections: [{ usagePage: USAGE_PAGE, usage: USAGE }],
  opened: false,
  open: async function() { this.opened = true; },
  close: async function() { this.opened = false; },
  productName: 'Mock AL80',
};

async function run() {
  ok('getDevice() initially returns null', () => {
    assert.equal(getDevice(), null);
  });

  await connect();

  ok('getDevice() returns the mocked device after connect()', () => {
    assert.equal(getDevice(), mockDevice);
  });

  await disconnect();

  ok('getDevice() returns null again after disconnect()', () => {
    assert.equal(getDevice(), null);
  });

  console.log(`\n# ok\n# pass ${pass}`);
}

run().catch(e => { console.error(e); process.exit(1); });
