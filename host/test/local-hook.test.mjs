import assert from 'node:assert/strict';
import { Scheduler } from '../lib/scheduler.js';
import { startLocalHook } from '../control/local-hook.js';

const server = startLocalHook(new Scheduler(null), { port: 0 });
await new Promise((resolve) => server.on('listening', resolve));

try {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { active: null, alerts: 0 });
  console.log('local-hook: idle /status ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
