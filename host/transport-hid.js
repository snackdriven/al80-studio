// Real transport: drives the AL80 over USB via node-hid. Same send(packets) interface as
// MockTransport, so apps/diff/scheduler don't care which is wired. Proven by host/spike.mjs
// (node-hid opens 0xFF60/0x61 on Windows, 64-byte body, device ACKs every report with byte6=0x55).
//
// The echo channel is the health signal: every report we send comes back as an inputreport. If
// echoes stop arriving, the device is stalling — back off before it wedges (watchdog below).
import HID from 'node-hid';
import { VID, PID, USAGE_PAGE, USAGE } from '../src/protocol.js';

export class HidTransport {
  constructor() {
    this.dev = null;
    this.echoes = 0;
    this.lastEchoAt = 0;
    this.lastError = null;
  }

  static find() {
    return HID.devices().find(
      (d) => d.vendorId === VID && d.productId === PID && d.usagePage === USAGE_PAGE && d.usage === USAGE,
    );
  }

  /** Open the LCD interface. Throws if not found (enumerate) or not openable (held elsewhere). */
  open() {
    const info = HidTransport.find();
    if (!info) throw new Error('AL80 0xFF60/0x61 interface not enumerated (is the keyboard plugged in?)');
    this.dev = new HID.HID(info.path); // throws if another process holds it
    this.dev.on('data', () => { this.echoes++; this.lastEchoAt = Date.now(); });
    this.dev.on('error', (e) => { this.lastError = e; });
    this.lastEchoAt = Date.now();
    return this;
  }

  get opened() { return !!this.dev; }

  /** Send a list of 64-byte report bodies (from a protocol.js builder). Prepends reportId 0. */
  send(packets) {
    if (!this.dev) throw new Error('transport not open');
    for (const p of packets) {
      const body = p.subarray ? p.subarray(0, 64) : Uint8Array.from(p).subarray(0, 64);
      this.dev.write([0x00, ...Array.from(body)]);
    }
  }

  /** ms since the last ACK echo — a liveness/wedge signal. */
  echoAgeMs(now) { return now - this.lastEchoAt; }

  close() {
    if (this.dev) { try { this.dev.close(); } catch { /* already gone */ } this.dev = null; }
  }
}
