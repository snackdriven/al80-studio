// sendCard must not grow the 16-slot picture ring. PK_ADD_PIC always commits a NEW slot, so a
// now-playing loop that pushes a frame every poll fills the ring with album art and wraps over the
// user's saved pictures. The fix: delete the card we last committed (it's the slot on screen) BEFORE
// committing the new one — net ring growth zero. First push (and post-reconnect) must NOT delete,
// because there's nothing of ours to delete and PK_DEL_PIC would hit whatever else is displayed.
import assert from 'node:assert';
import Device from '../device.js';

function makeStub() {
  const calls = [];
  const dev = new Device({ mock: true });
  dev.deletePicture = async () => { calls.push('del'); };
  dev.sendFrame = async () => { calls.push('add'); return { packets: 0, dataBlocks: 0, acked: 0, fellBack: 0 }; };
  return { dev, calls };
}

// First push: nothing of ours on screen yet — add only.
{
  const { dev, calls } = makeStub();
  await dev.sendCard(new Uint8Array(1), { replacePrevious: false });
  assert.deepEqual(calls, ['add'], 'first card must not delete anything');
}

// Subsequent push: delete the on-screen card, THEN add the new one — net-zero ring growth.
{
  const { dev, calls } = makeStub();
  await dev.sendCard(new Uint8Array(1), { replacePrevious: true });
  assert.deepEqual(calls, ['del', 'add'], 'replace must delete the displayed slot before adding');
}

console.log('ok — sendCard keeps the picture ring net-zero');
