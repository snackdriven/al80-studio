// Device-free validation of the transport layer. Uses the mock (no HID, no writes) to assert the
// packet accounting is exactly what the builders produce, and that setRGB / sendClock build without
// throwing. NO real hardware is touched here.
import assert from 'node:assert/strict';
import { Device, MockDevice } from '../device.js';
import { FRAME_BYTES, BLOCK_COUNT } from '../../src/protocol.js';

const dev = new MockDevice({ log: () => {} }); // silence the [mock] chatter
await dev.open();
assert.equal(dev.opened, true, 'mock device reports opened');

// 1) sendFrame packet accounting: announce + setup + BLOCK_COUNT data + finish.
//    30720-byte frame => 1 + 1 + 549 + 1 = 552 packets, 549 of them data blocks.
const frame = new Uint8Array(FRAME_BYTES); // zeros are a valid 96x160 RGB565 frame
const r = await dev.sendFrame(frame);
assert.equal(r.packets, 552, `expected 552 packets, got ${r.packets}`);
assert.equal(r.dataBlocks, BLOCK_COUNT, `expected ${BLOCK_COUNT} data blocks, got ${r.dataBlocks}`);
assert.equal(r.packets, 1 + 1 + BLOCK_COUNT + 1, 'packet count = announce + setup + data + finish');

// 2) sendFrame rejects a wrong-sized frame (builder guard is surfaced, not swallowed).
await assert.rejects(() => dev.sendFrame(new Uint8Array(100)), /30720/, 'wrong-sized frame is rejected');

// 3) setRGB builds without throwing and only emits packets for the fields given.
const rgbAll = await dev.setRGB({ effect: 1, color: { hue: 200, sat: 255 }, brightness: 180, speed: 90 });
assert.equal(rgbAll.packets, 8, 'effect+brightness+speed+color = 4 set+save pairs = 8 packets');
const rgbNone = await dev.setRGB({});
assert.equal(rgbNone.packets, 0, 'setRGB with no fields sends nothing');
const rgbOne = await dev.setRGB({ color: { hue: 10, sat: 240 } });
assert.equal(rgbOne.packets, 2, 'a single field is one set+save pair');

// 4) sendClock builds without throwing (clock is sent 3x of 6 = 18 packets).
const clk = await dev.sendClock(new Date(2026, 6, 3, 14, 9, 42));
assert.equal(clk.packets, 18, 'clock builds to 18 packets (3 repeats of the 6-packet block)');

// 5) mock never allocates a real HID handle.
assert.equal(dev.dev, null, 'mock holds no HID handle');
dev.close();
assert.equal(dev.opened, false, 'closed mock reports not opened');

// 6) a non-mock Device stays un-opened until open(); construction alone touches no hardware.
const real = new Device();
assert.equal(real.opened, false, 'a fresh real Device is not open');

console.log('host device dry-run tests passed (sendFrame=552 packets/549 data, setRGB, sendClock; no hardware touched)');
