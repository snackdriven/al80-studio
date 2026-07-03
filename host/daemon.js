// M1 daemon core: connect -> loop { render clock, diff, paced send, health-check } -> recover.
// Demonstrates the always-on loop + the no-admin recovery ladder (reopen + full re-sync) and uses
// the echo channel as a wedge watchdog. Pushes rendered frames to the picture-page store (no view
// switch here — visual needs the byte-swap banding fix first; this validates the pipeline).
//
//   node daemon.js [durationMs]   (omit duration to run until Ctrl-C)
import { HidTransport } from './transport-hid.js';
import { renderClock } from './apps/clock.js';
import { diffRegion } from './lib/diff.js';
import { buildImageTransfer, buildImageRegion } from '../src/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Daemon {
  constructor() { this.t = new HidTransport(); this.prev = null; this.stalls = 0; }

  async connect() {
    for (let attempt = 0; ; attempt++) {
      try { this.t.open(); this.prev = null; console.log('[daemon] connected'); return; }
      catch (e) {
        if (attempt === 0) console.log('[daemon] waiting for device:', e.message);
        await sleep(Math.min(1000 * (attempt + 1), 5000)); // backoff, keep trying
      }
    }
  }

  // Send with a tiny pace (avoids the blast that wedged us) and verify the device kept up via
  // the echo count. If echoes don't advance across a whole frame, the device is stalling.
  async send(packets) {
    const before = this.t.echoes;
    for (const p of packets) { this.t.send([p]); await sleep(1); }
    await sleep(30); // let trailing echoes arrive
    const got = this.t.echoes - before;
    return { sent: packets.length, echoed: got, healthy: got > 0 };
  }

  async pushFrame(fb) {
    const d = diffRegion(this.prev, fb);
    if (!d.changed) return { kind: 'skip' };
    const packets = d.full ? buildImageTransfer(fb) : buildImageRegion(fb, d.start, d.end);
    const r = await this.send(packets);
    if (!r.healthy) throw new Error('echo watchdog: device stopped ACKing (wedge?)');
    this.prev = fb; // device now matches fb
    return { kind: d.full ? 'FULL' : `region ${d.blocks}blk`, ...r };
  }

  // No-admin recovery: drop the handle, reopen, force a full re-sync (prev=null).
  async recover() {
    this.stalls++;
    console.log(`[daemon] recovering (#${this.stalls}) — reopen + full resync`);
    this.t.close(); await sleep(300);
    await this.connect(); // reopen (prev reset inside)
  }

  async run(durationMs) {
    await this.connect();
    const stopAt = durationMs ? Date.now() + durationMs : Infinity;
    let ticks = 0;
    while (Date.now() < stopAt) {
      const t0 = Date.now();
      try {
        const r = await this.pushFrame(renderClock(new Date()));
        if (r.kind !== 'skip') console.log(`[tick ${++ticks}] ${r.kind.padEnd(12)} echoed ${r.echoed}/${r.sent}`);
      } catch (e) {
        console.log('[daemon]', e.message);
        await this.recover();
      }
      await sleep(Math.max(0, 1000 - (Date.now() - t0))); // ~1 fps
    }
    this.t.close();
    console.log(`[daemon] stopped after ${ticks} ticks, ${this.stalls} recoveries, ${this.t.echoes} total echoes`);
  }
}

const dur = Number(process.argv[2]) || 0;
const d = new Daemon();
process.on('SIGINT', () => { d.t.close(); console.log('\n[daemon] closed on SIGINT'); process.exit(0); });
d.run(dur).then(() => process.exit(0));
