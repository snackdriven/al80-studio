// RecordingDevice — implements the exact Device API the cycler calls (open/sendCard/deletePicture/
// goHome/sendClock/setRGB/reopen/close/opened), appending each call to an ordered `ops[]` so tests
// can assert transition sequences (auto-cycle SPARC C2). Every picture frame is piped through a
// MockTransport (reassembled framebuffer + checksum validation, reused from roundtrip.test.mjs) so
// frame-correctness assertions come for free. Supports fault injection via failNextSend() for the
// reopen-recovery test.
//
// NEITHER MockTransport (byte-level reassembly) nor MockDevice (packet counting, device.js) alone
// models the ring/deletePicture/goHome/view semantics the cycler depends on — this is the missing
// recording layer the SPARC C2 calls for.
import { MockTransport } from '../transport-mock.js';
import { buildImageTransfer } from '../../src/protocol.js';

export class RecordingDevice {
  constructor() {
    this.ops = [];
    this.transport = new MockTransport();
    this._opened = true;
    this._failNext = false;
    this.reopenCount = 0;
  }

  get opened() { return this._opened; }

  open() { this._opened = true; return this; }
  close() { this._opened = false; }

  async reopen() {
    this._opened = true;
    this.reopenCount++;
    this.ops.push('reopen');
    return this;
  }

  /** Next state-changing call throws + drops the handle (mirrors a write error / unplug). */
  failNextSend() { this._failNext = true; }

  _maybeFail() {
    if (this._failNext) {
      this._failNext = false;
      this._opened = false;
      throw new Error('RecordingDevice: injected failure (simulated drop)');
    }
  }

  async deletePicture() {
    this._maybeFail();
    this.ops.push('deletePicture');
  }

  async goHome() {
    this._maybeFail();
    this.ops.push('goHome');
  }

  async sendClock() {
    this._maybeFail();
    this.ops.push('sendClock');
  }

  async setRGB(value) {
    this._maybeFail();
    this.ops.push({ op: 'setRGB', value });
  }

  /** Mirrors device.js Device#sendCard: replacePrevious -> delete-before-add, one recorded op each. */
  async sendCard(frame, { replacePrevious = false } = {}) {
    this._maybeFail();
    if (replacePrevious) this.ops.push('deletePicture');
    this.transport.send(buildImageTransfer(frame));
    this.ops.push({ op: 'sendCard', replacePrevious });
    return { packets: 0, dataBlocks: 0, acked: 0, fellBack: 0 };
  }

  /** The reassembled framebuffer of the LAST picture pushed (persists across sends, like the panel). */
  frame() { return this.transport.frame(); }

  /** Net ring growth this run: adds minus deletes (FR7 — should equal 0 or 1 depending on `committed`). */
  ringDelta() {
    let adds = 0, deletes = 0;
    for (const op of this.ops) {
      if (op === 'deletePicture') deletes++;
      else if (op && op.op === 'sendCard') adds++;
    }
    return adds - deletes;
  }
}
