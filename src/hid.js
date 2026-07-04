// AL80 Studio — WebHID transport layer. No DOM, no protocol logic, no dependencies.
// This module only moves 64-byte reports over the wire; packet building lives in protocol.js.
//
// ┌─ CAVEAT: sendReport data length (VERIFY ON-DEVICE) ─────────────────────────┐
// │ For an unnumbered output report (reportId 0), sendReport(reportId, data)     │
// │ takes the report body WITHOUT the report-id byte. MDN confirms: pass 0 as    │
// │ reportId, and `data` is the raw report bytes. We send the full 64-byte body  │
// │ (SEND_LEN = 64) to match protocol.js, which builds 64-byte reports.          │
// │                                                                              │
// │ The OLD browser snippet (yunzii-game.com) sent 63 bytes — it dropped the     │
// │ last pad byte. Some firmware expects the descriptor's exact report length.   │
// │ If the device REJECTS 64-byte writes (sendReport throws / NotAllowedError    │
// │ on a report the descriptor sized at 63), flip SEND_LEN to 63 below. That     │
// │ truncates each packet's trailing pad byte, which protocol.js zero-fills, so  │
// │ dropping it is lossless for our packets.                                     │
// │                                                                              │
// │ MUST be verified on real hardware with the CLOCK transfer first (buildClock  │
// │ in protocol.js) before trusting image transfers — clock is the smallest,     │
// │ safest write to prove the wire length.                                       │
// └──────────────────────────────────────────────────────────────────────────────┘

import { VID, PID, USAGE_PAGE, USAGE } from './protocol.js';

/**
 * Report body length written per packet. Default 64 (matches protocol.js reports).
 * One-line fallback: set to 63 if the device rejects 64-byte unnumbered reports.
 * @type {number}
 */
export const SEND_LEN = 64;

/** The single open HIDDevice, or null when disconnected. @type {HIDDevice|null} */
let device = null;

/** Registered status callbacks. @type {Set<(s: {connected: boolean, name?: string}) => void>} */
const statusCallbacks = new Set();

/** Guards against double-wiring navigator.hid connect/disconnect listeners. */
let eventsWired = false;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True when the current browser exposes the WebHID API.
 * @returns {boolean}
 */
export function isSupported() {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

/**
 * Recursively test whether a device advertises the AL80 raw-HID collection
 * (usagePage 0xFF60 / usage 0x61). Collections can nest, so we walk children too.
 * @param {HIDDevice} dev
 * @returns {boolean}
 */
function hasTargetCollection(dev) {
  const walk = (collections) => {
    if (!collections) return false;
    for (const c of collections) {
      if (c.usagePage === USAGE_PAGE && c.usage === USAGE) return true;
      if (walk(c.children)) return true;
    }
    return false;
  };
  return walk(dev.collections);
}

/**
 * True when a device matches our VID/PID and exposes the target collection.
 * @param {HIDDevice} dev
 * @returns {boolean}
 */
function isTargetDevice(dev) {
  return dev.vendorId === VID && dev.productId === PID && hasTargetCollection(dev);
}

/**
 * Fire all registered status callbacks. Never lets a bad callback break the flow.
 * @param {{connected: boolean, name?: string}} status
 */
function emitStatus(status) {
  for (const cb of statusCallbacks) {
    try {
      cb(status);
    } catch {
      // a listener throwing must not stop other listeners or the transport
    }
  }
}

/**
 * Wire navigator.hid connect/disconnect events once. When our open device is
 * unplugged we drop the reference and emit a disconnected status.
 */
function wireDeviceEvents() {
  if (eventsWired || !isSupported()) return;
  eventsWired = true;

  navigator.hid.addEventListener('connect', (e) => {
    if (isTargetDevice(e.device)) {
      emitStatus({ connected: true, name: e.device.productName });
    }
  });

  navigator.hid.addEventListener('disconnect', (e) => {
    if (device && e.device === device) {
      device = null;
    }
    if (isTargetDevice(e.device)) {
      emitStatus({ connected: false, name: e.device.productName });
    }
  });
}

/**
 * Connect to the AL80 keyboard's LCD interface.
 *
 * Tries a silent reconnect via getDevices() first (devices the user already
 * granted). If none match, prompts the user with requestDevice(). Filters by
 * VID/PID, then narrows to the device exposing the 0xFF60/0x61 collection.
 * Opens the chosen device.
 *
 * @returns {Promise<HIDDevice>} the opened device
 * @throws {Error} when WebHID is unavailable, no matching device is found, or open fails
 */
export async function connect() {
  if (!isSupported()) {
    throw new Error('WebHID is not available in this browser. Use Chrome or Edge over HTTPS.');
  }

  wireDeviceEvents();

  // Reuse an already-open device.
  if (device && device.opened) return device;

  // 1) Silent reconnect: already-granted devices.
  let target = null;
  const granted = await navigator.hid.getDevices();
  target = granted.find(isTargetDevice) || null;

  // 2) Prompt the user. requestDevice returns an array; pick our collection.
  if (!target) {
    const picked = await navigator.hid.requestDevice({
      filters: [{ vendorId: VID, productId: PID }],
    });
    target = picked.find(isTargetDevice) || null;
  }

  if (!target) {
    throw new Error(
      `No AL80 LCD interface found (expected VID 0x${VID.toString(16)}, PID 0x${PID.toString(16)} ` +
        `with usagePage 0x${USAGE_PAGE.toString(16)}/usage 0x${USAGE.toString(16)}). ` +
        'Make sure the keyboard is plugged in and you selected it in the picker.',
    );
  }

  try {
    if (!target.opened) await target.open();
  } catch (err) {
    throw new Error(
      `Could not open the AL80 LCD interface: ${err && err.message ? err.message : err}. ` +
        'Close any other app or tab using the keyboard (yunzii-game.com, VIA) and try again.',
    );
  }

  device = target;
  emitStatus({ connected: true, name: device.productName });
  return device;
}

/**
 * The currently open device, or null.
 * @returns {HIDDevice|null}
 */
export function getDevice() {
  return device;
}

/**
 * Send a batch of 64-byte packets to the LCD.
 *
 * Each packet is written with sendReport(0, ...) as an unnumbered output report.
 * When `gap` > 0 the call sleeps between packets (some transfers need pacing).
 *
 * @param {(Uint8Array|number[])[]} packets 64-byte report bodies (from protocol.js builders)
 * @param {{gap?: number}} [opts] gap: milliseconds to wait between packets (default 0)
 * @returns {Promise<{sent: number, ms: number}>} count sent and elapsed milliseconds
 * @throws {Error} when no device is open, or a write fails (device busy / claimed elsewhere)
 */
export async function send(packets, { gap = 0 } = {}) {
  if (!device || !device.opened) {
    throw new Error('Not connected. Call connect() before send().');
  }

  const start = (typeof performance !== 'undefined' ? performance : Date).now();
  let sent = 0;

  for (const packet of packets) {
    // Normalize to the configured wire length. SEND_LEN=64 keeps the full body;
    // SEND_LEN=63 drops protocol.js's trailing zero pad byte (lossless).
    const body = new Uint8Array(SEND_LEN);
    const src = packet instanceof Uint8Array ? packet : Uint8Array.from(packet);
    body.set(src.subarray(0, SEND_LEN));

    try {
      await device.sendReport(0, body);
    } catch (err) {
      throw new Error(
        `Write failed after ${sent} packet(s): ${err && err.message ? err.message : err}. ` +
          'The keyboard only allows one app to write at a time — close the yunzii-game.com tab ' +
          'and VIA (or any other tab talking to the keyboard), then reconnect.',
      );
    }

    sent++;
    if (gap > 0) await sleep(gap);
  }

  const ms = (typeof performance !== 'undefined' ? performance : Date).now() - start;
  return { sent, ms };
}

/**
 * ACK-gated still-image send — the fix for the picture-page banding + white.
 *
 * Blasting the 549 pixel blocks overruns the display module's UART receive buffer; a dropped
 * byte flips hi/lo alignment for a stretch and you get a colour-swapped band (or, worse, a
 * frame that never renders = white). The module echoes each block back (bytes[0..1] mirrored,
 * byte[6]=0x55 ready), so we wait for that echo before sending the next — the same flow-control
 * the native spike proved (18/18 acks). Control packets (announce/setup/finish/view) aren't
 * echoed; they get a settle instead, with a generous pause after the announce + setup so the
 * module is ready before the first pixels (that's what kills the top-of-frame band).
 *
 * @param {(Uint8Array|number[])[]} packets  from buildImageTransfer (row-major)
 * @param {(fraction:number)=>void} [onFraction]
 * @param {{ackTimeout?:number, announceSettle?:number, setupSettle?:number}} [opts]
 */
export async function sendAckGated(packets, onFraction, { ackTimeout = 140, announceSettle = 300, setupSettle = 120 } = {}) {
  if (!device || !device.opened) throw new Error('Not connected. Call connect() before sendAckGated().');
  const start = (typeof performance !== 'undefined' ? performance : Date).now();
  for (let i = 0; i < packets.length; i++) {
    const src = packets[i] instanceof Uint8Array ? packets[i] : Uint8Array.from(packets[i]);
    const body = new Uint8Array(SEND_LEN);
    body.set(src.subarray(0, SEND_LEN));
    // a 0x41 packet whose payload is NOT an A5 5A control frame is a pixel data block → ACK-gate it.
    const isData = src[0] === 0x41 && !(src[7] === 0xa5 && src[8] === 0x5a);
    if (isData) {
      // Send, wait for the block's echo; if it doesn't come, RESEND (each block carries its own
      // offset, so resending is idempotent) up to a few times. A missed ack = the block may have
      // slipped, so retrying is what stops a stray mid-frame band, not just falling through.
      let acked = false;
      for (let attempt = 0; attempt < 4 && !acked; attempt++) {
        acked = await new Promise((resolve) => {
          const done = (ok) => { clearTimeout(to); device.removeEventListener('inputreport', onRep); resolve(ok); };
          const onRep = (e) => { const b = new Uint8Array(e.data.buffer); if (b[0] === src[0] && b[1] === src[1]) done(true); };
          const to = setTimeout(() => done(false), ackTimeout);
          device.addEventListener('inputreport', onRep);
          device.sendReport(0, body).catch(() => done(false));
        });
      }
      if (!acked) await sleep(15); // exhausted retries — give the module a breath before continuing
    } else {
      try { await device.sendReport(0, body); } catch (err) {
        throw new Error(`Write failed after ${i} packet(s): ${err && err.message ? err.message : err}. Close any other app talking to the keyboard and reconnect.`);
      }
      if (i === 0) await sleep(announceSettle);                 // after the announce
      else if (src[7] === 0xa5 && src[9] === 0x0c) await sleep(setupSettle); // after the setup descriptor
      else await sleep(2);
    }
    if (onFraction) onFraction((i + 1) / packets.length);
  }
  return { sent: packets.length, ms: (typeof performance !== 'undefined' ? performance : Date).now() - start };
}

/**
 * Send a mode-GIF/animation transfer with the VENDOR'S EXACT PACING. The device needs time to
 * commit each 1024-byte bank; sent back-to-back, banks overwrite each other and the GIF renders
 * as garbage bars (this is why blasting the vendor's own bytes failed). Decoded from `Ur`:
 *   - 30ms after the initial setup
 *   - after each per-frame header (0x10 sub 3): 3000ms on frame 0 / every 16th, else 30ms
 *   - 30ms after each bank (the 16-byte block at offset 0x3F0)
 *   - 30ms after each finish setup (type 0x12 / 0x13)
 * Use for buildMainPageGif / buildGifPage / buildStartupAnimation output.
 * @param {(Uint8Array|number[])[]} packets
 * @param {(fraction: number) => void} [onFraction]
 */
export async function sendGif(packets, onFraction) {
  if (!device || !device.opened) throw new Error('Not connected. Call connect() before sendGif().');
  const start = (typeof performance !== 'undefined' ? performance : Date).now();
  let sent = 0;
  let frameIdx = -1;
  for (const packet of packets) {
    const src = packet instanceof Uint8Array ? packet : Uint8Array.from(packet);
    const body = new Uint8Array(SEND_LEN);
    body.set(src.subarray(0, SEND_LEN));
    try {
      await device.sendReport(0, body);
    } catch (err) {
      throw new Error(
        `Write failed after ${sent} packet(s): ${err && err.message ? err.message : err}. ` +
          'Close the yunzii-game.com tab and VIA, then reconnect.',
      );
    }
    sent++;
    const magic = src[7] === 0xa5 && src[8] === 0x5a;
    const type = src[9];
    if (src[0] === 0x41 && magic && type === 0x10 && src[11] === 3) {
      frameIdx++;
      await sleep(frameIdx % 16 === 0 ? 3000 : 30); // per-frame header; big pause on frame 0 / every 16th
    } else if (src[0] === 0x41 && !magic && (src[1] | (src[2] << 8)) === 0x3f0 && src[3] === 0x10) {
      await sleep(30); // end of a 1024-byte bank
    } else if (src[0] === 0x41 && magic && (type === 0x12 || type === 0x13)) {
      await sleep(30); // initial setup + finish setups
    }
    if (onFraction) onFraction(sent / packets.length);
  }
  const ms = (typeof performance !== 'undefined' ? performance : Date).now() - start;
  return { sent, ms };
}

/**
 * Close the open device. Safe to call when nothing is open.
 * @returns {Promise<void>}
 */
export async function disconnect() {
  if (!device) return;
  const name = device.productName;
  try {
    if (device.opened) await device.close();
  } finally {
    device = null;
    emitStatus({ connected: false, name });
  }
}

/**
 * Register a status callback. Fired on connect, open, disconnect, and close with
 * {connected, name?}. Also wires navigator.hid connect/disconnect events so plug
 * events reach the callback even without an active connect() call.
 * @param {(s: {connected: boolean, name?: string}) => void} cb
 * @returns {() => void} an unsubscribe function
 */
export function onStatus(cb) {
  statusCallbacks.add(cb);
  wireDeviceEvents();
  return () => statusCallbacks.delete(cb);
}
