// AL80 host daemon — reusable native HID transport (SPARC Phase 0 "device layer").
//
// One opener owns the LCD/VIA raw-HID interface (usagePage 0xFF60, usage 0x61, interface MI_01)
// and drives it through the pure builders in ../src/protocol.js. This is the ONLY place node-hid
// is touched; apps / render / scheduler stay device-agnostic.
//
// Why ACK-gating (proven in host/spike.mjs): the device echoes every report back on an inputreport
// with byte[6] = 0x55 (ready) or 0x0F (busy). Blasting all 549 pixel blocks without waiting drops
// bytes and shears the image into red/blue banding. So after each 0x41 DATA block we wait (~60ms)
// for the echo whose byte[0]/byte[1] match the report we just sent, then send the next. If no echo
// arrives (echo channel quiet on some units), we fall back to a small fixed delay — still paced.
//
// mock:true skips HID entirely and just counts packets, so the daemon + tests run with no hardware.
import HID from 'node-hid';
import { EventEmitter } from 'node:events';
import {
  VID, PID, USAGE_PAGE, USAGE,
  buildImageTransfer, clockFromDate,
  buildLightBrightness, buildLightEffect, buildLightSpeed, buildLightColor,
} from '../src/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A 0x41 report is a PIXEL data block iff its payload doesn't start with the A5 5A control marker. */
function isDataBlock(p) {
  return p[0] === 0x41 && !(p[7] === 0xa5 && p[8] === 0x5a);
}

export class Device extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.mock=false]        log packet counts instead of writing (no hardware)
   * @param {number}  [opts.ackTimeoutMs=60]   how long to wait for a data-block echo before falling back
   * @param {number}  [opts.fallbackDelayMs=2] pace when no echo arrives (keeps writes from blasting)
   * @param {(...a:any[])=>void} [opts.log]    logger (defaults to console.log; used by mock mode)
   */
  constructor(opts = {}) {
    super();
    this.mock = !!opts.mock;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 60;
    this.fallbackDelayMs = opts.fallbackDelayMs ?? 2;
    this.log = opts.log || console.log;

    this.dev = null;
    this._mockOpen = false;
    this._down = false;          // guards single 'disconnect' emit per drop
    this._pending = null;        // one-shot echo matcher { match, resolve }
    this.echoes = 0;             // total inputreports seen (liveness signal)
    this.lastEchoAt = 0;
    this.lastError = null;
  }

  /** Enumerate the AL80 LCD/VIA interface (vid 0x28E9, pid 0x30AF, usagePage 0xFF60, usage 0x61). */
  static find() {
    return HID.devices().find(
      (d) => d.vendorId === VID && d.productId === PID && d.usagePage === USAGE_PAGE && d.usage === USAGE,
    );
  }

  get opened() {
    return this.mock ? this._mockOpen : !!this.dev;
  }

  /** Open the interface by path. Throws a clear message if not enumerated or held by another opener. */
  open() {
    if (this.mock) { this._mockOpen = true; return this; }
    const info = Device.find();
    if (!info) throw new Error('AL80 0xFF60/0x61 interface not enumerated — is the keyboard plugged in?');
    try {
      this.dev = new HID.HID(info.path); // throws if another process already holds the single opener
    } catch (e) {
      throw new Error(`AL80 device busy (single-opener) — close al80-studio/usevia (${e.message})`);
    }
    this._down = false;
    this.dev.on('data', (buf) => this._onData(buf));
    this.dev.on('error', (e) => this._fail(e));
    this.lastEchoAt = Date.now();
    return this;
  }

  // ---- echo channel -----------------------------------------------------------

  _onData(buf) {
    this.echoes++;
    this.lastEchoAt = Date.now();
    // byte[6]: 0x55 = ready, 0x0F = busy. We match on byte[0]/byte[1] (opcode + offset-lo) so an
    // echo is tied to the block that produced it; the ready/busy nibble is informational here.
    if (this._pending && this._pending.match(buf)) {
      const p = this._pending;
      this._pending = null;
      p.resolve(true);
    }
  }

  /** Resolve true when an echo matching this sent report arrives, false on timeout. */
  _waitAck(sent, timeoutMs) {
    return new Promise((resolve) => {
      const b0 = sent[0], b1 = sent[1];
      const timer = setTimeout(() => {
        if (this._pending && this._pending.resolve === wrapped) this._pending = null;
        resolve(false);
      }, timeoutMs);
      const wrapped = (v) => { clearTimeout(timer); resolve(v); };
      this._pending = { match: (e) => e[0] === b0 && e[1] === b1, resolve: wrapped };
    });
  }

  /** ms since the last inputreport — a wedge/liveness signal for a watchdog. */
  echoAgeMs(now = Date.now()) { return now - this.lastEchoAt; }

  // ---- writing ----------------------------------------------------------------

  _write(p) {
    const body = p.subarray ? p.subarray(0, 64) : Uint8Array.from(p).subarray(0, 64);
    try {
      // node-hid on Windows: prepend reportId 0 for the unnumbered report.
      this.dev.write([0x00, ...Array.from(body)]);
    } catch (e) {
      this._fail(e);
      throw new Error(`AL80 write failed (${e.message}) — device unplugged or wedged; call reopen()`);
    }
  }

  /** Drop the handle, emit 'disconnect' once. Called on write error / node-hid 'error' (unplug). */
  _fail(e) {
    this.lastError = e;
    if (this._down) return;
    this._down = true;
    if (this._pending) { const p = this._pending; this._pending = null; p.resolve(false); }
    try { this.dev?.close(); } catch { /* already gone */ }
    this.dev = null;
    this.emit('disconnect', e);
  }

  /**
   * Write a list of 64-byte report bodies. In mock mode, only counts. With `gate`, each 0x41 DATA
   * block is ACK-gated (wait for its echo, else fall back to a fixed delay) — the anti-banding pace.
   * @returns {{packets:number, dataBlocks:number, acked:number, fellBack:number}}
   */
  async _send(packets, { gate = false } = {}) {
    let dataBlocks = 0, acked = 0, fellBack = 0;
    for (const p of packets) if (isDataBlock(p)) dataBlocks++;

    if (this.mock) {
      this.log(`[mock] send ${packets.length} packets (${dataBlocks} data blocks)`);
      return { packets: packets.length, dataBlocks, acked, fellBack };
    }
    if (!this.dev) throw new Error('AL80 device not open — call open() or reopen() first');

    for (const p of packets) {
      if (gate && isDataBlock(p)) {
        this._write(p);
        const ok = await this._waitAck(p, this.ackTimeoutMs);
        if (ok) acked++;
        else { fellBack++; await sleep(this.fallbackDelayMs); }
      } else {
        this._write(p);
      }
    }
    return { packets: packets.length, dataBlocks, acked, fellBack };
  }

  // ---- public API -------------------------------------------------------------

  /** Push a full 96x160 row-major RGB565 frame (30720 bytes). ACK-gated per data block. */
  async sendFrame(frame) {
    const packets = buildImageTransfer(frame); // validates 30720 bytes; transposes to col-major inside
    return this._send(packets, { gate: true });
  }

  /**
   * Set RGB lighting. Only the fields you pass are written (each is a set+save pair).
   * @param {object} p
   * @param {number} [p.effect]                 QMK RGB-matrix effect id
   * @param {{hue:number,sat:number}} [p.color] 0-255 each
   * @param {number} [p.brightness]             0-255
   * @param {number} [p.speed]                  0-255
   */
  async setRGB({ effect, color, brightness, speed } = {}) {
    const packets = [];
    if (effect !== undefined) packets.push(...buildLightEffect(effect));
    if (brightness !== undefined) packets.push(...buildLightBrightness(brightness));
    if (speed !== undefined) packets.push(...buildLightSpeed(speed));
    if (color) packets.push(...buildLightColor(color.hue, color.sat));
    if (!packets.length) return { packets: 0, dataBlocks: 0, acked: 0, fellBack: 0 };
    return this._send(packets); // VIA reports (0x07/0x09), not pixel blocks — no gate needed
  }

  /** Convenience: push the current time. The clock is the smallest safe write (proven in spike.mjs). */
  async sendClock(date = new Date(), is12hr = true) {
    return this._send(clockFromDate(date, is12hr));
  }

  /**
   * Reconnect after a drop, with backoff. Closes any stale handle, then retries open().
   * Emits 'reconnect' on success. Returns this, or throws after maxAttempts.
   */
  async reopen(maxAttempts = Infinity) {
    this.close();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.open();
        this.emit('reconnect');
        return this;
      } catch (e) {
        this.lastError = e;
        await sleep(Math.min(1000 * (attempt + 1), 5000)); // 1s,2s,3s,4s,5s,5s... cap
      }
    }
    throw new Error(`AL80 reopen failed after ${maxAttempts} attempts: ${this.lastError?.message}`);
  }

  /** Close the handle cleanly. Idempotent. */
  close() {
    if (this.mock) { this._mockOpen = false; return; }
    if (this._pending) { const p = this._pending; this._pending = null; p.resolve(false); }
    if (this.dev) { try { this.dev.close(); } catch { /* already gone */ } this.dev = null; }
    this._down = false;
  }
}

/** A no-hardware Device that only counts packets. Same API as Device; handy for tests/dev. */
export class MockDevice extends Device {
  constructor(opts = {}) { super({ ...opts, mock: true }); }
}

export default Device;
