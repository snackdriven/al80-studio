// Mock transport: pretends to be the AL80, but reassembles the exact packets protocol.js sends
// into a 30720-byte framebuffer — the same thing the real device does (and the same thing our
// on-device echo test reassembled). So this VALIDATES the builders: if buildImageTransfer /
// buildImageRegion produce wrong offsets or checksums, the reassembled frame is wrong.
//
// Region updates work for free: we only write the blocks that arrive and keep the framebuffer
// persistent between sends, mirroring the device leaving un-sent blocks untouched.
import { writeFileSync } from 'node:fs';
import { FRAME_BYTES, WIDTH, HEIGHT, yne } from '../src/protocol.js';
import { encodePNG, rgb565ToRGB } from './lib/png.js';

export class MockTransport {
  constructor() {
    this.fb = new Uint8Array(FRAME_BYTES); // reassembled framebuffer (persistent, like the panel)
    this.stats = { sends: 0, packets: 0, dataBlocks: 0, bytesWritten: 0, badChecksums: 0 };
  }

  /** Accept a list of 64-byte report bodies (from a protocol.js builder). */
  send(packets) {
    this.stats.sends++;
    for (const raw of packets) {
      const p = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
      this.stats.packets++;
      // checksum sanity (catches builder bugs) — recompute yne with bytes[4,5]=0
      const chk = [...p]; const c4 = chk[4], c5 = chk[5]; chk[4] = 0; chk[5] = 0;
      const [y0, y1] = yne(chk);
      if (y0 !== c4 || y1 !== c5) this.stats.badChecksums++;
      // data block? 0x41 and NOT an A5 5A control/setup packet
      if (p[0] === 0x41 && !(p[7] === 0xa5 && p[8] === 0x5a)) {
        const off = p[1] | (p[2] << 8);
        const len = p[3];
        for (let i = 0; i < len && off + i < FRAME_BYTES; i++) this.fb[off + i] = p[7 + i];
        this.stats.dataBlocks++;
        this.stats.bytesWritten += len;
      }
    }
  }

  /** Save the current reassembled framebuffer as a PNG (integer nearest-neighbor zoom). */
  savePNG(path, scale = 3) {
    const { rgb, width, height } = rgb565ToRGB(this.fb, WIDTH, HEIGHT, scale);
    writeFileSync(path, encodePNG(width, height, rgb));
    return path;
  }

  frame() { return this.fb; }
}
