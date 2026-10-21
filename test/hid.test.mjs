// HID transport layer tests. Covers isSupported and its reliance on the global navigator object.
import assert from 'node:assert/strict';
import { isSupported } from '../src/hid.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

console.log('AL80 Studio hid tests\n');

// Keep original descriptor to restore properly, as required by tests pollution memory guideline
const originalNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

ok('isSupported returns true when navigator.hid is present', () => {
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { hid: {} },
      configurable: true,
    });
    assert.equal(isSupported(), true);
  } finally {
    if (originalNav) {
      Object.defineProperty(globalThis, 'navigator', originalNav);
    } else {
      delete globalThis.navigator;
    }
  }
});

ok('isSupported returns false when navigator is present but hid is missing', () => {
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {}, // no hid
      configurable: true,
    });
    assert.equal(isSupported(), false);
  } finally {
    if (originalNav) {
      Object.defineProperty(globalThis, 'navigator', originalNav);
    } else {
      delete globalThis.navigator;
    }
  }
});

ok('isSupported returns false when navigator is undefined', () => {
  try {
    // Some environments restrict deleting globals, so we override to undefined
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      configurable: true,
    });
    assert.equal(isSupported(), false);
  } finally {
    if (originalNav) {
      Object.defineProperty(globalThis, 'navigator', originalNav);
    } else {
      delete globalThis.navigator;
    }
  }
});

console.log(`\n${pass} checks passed.`);
