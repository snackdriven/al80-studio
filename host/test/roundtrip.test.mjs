// Device-free validation: the mock reassembles protocol.js packets into a framebuffer; assert it
// matches the intended frame for both a full transfer and a region update, and that every packet
// checksum is valid. This tests the real builders without hardware.
import assert from 'node:assert/strict';
import { MockTransport } from '../transport-mock.js';
import { renderClock } from '../apps/clock.js';
import { diffRegion } from '../lib/diff.js';
import { buildImageTransfer, buildImageRegion } from '../../src/protocol.js';

const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

const mock = new MockTransport();

// 1) full transfer reassembles exactly, checksums valid
const a = renderClock(new Date(2026, 6, 2, 14, 9, 42));
mock.send(buildImageTransfer(a));
assert.ok(eq(mock.frame(), a), 'full transfer reassembles to the intended frame');
assert.equal(mock.stats.badChecksums, 0, 'all checksums valid after full transfer');

// 2) a one-second tick is a small partial region, and it reassembles exactly
const b = renderClock(new Date(2026, 6, 2, 14, 9, 43));
const d = diffRegion(a, b);
assert.ok(d.changed && !d.full, 'one-second tick is a partial region, not a full frame');
assert.ok(d.blocks < 120, `region should be small (got ${d.blocks} blocks)`);
mock.send(buildImageRegion(b, d.start, d.end));
assert.ok(eq(mock.frame(), b), 'region update reassembles to the intended frame');
assert.equal(mock.stats.badChecksums, 0, 'checksums still valid after region update');

// 3) identical frame -> no change
assert.equal(diffRegion(b, renderClock(new Date(2026, 6, 2, 14, 9, 43))).changed, false, 'identical frame -> no change');

console.log('host roundtrip tests passed (full transfer, region update, no-change; checksums valid)');
