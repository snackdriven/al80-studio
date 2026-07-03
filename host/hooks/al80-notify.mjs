#!/usr/bin/env node
// Claude Code hook -> AL80 LCD. Fires the "Claude needs you" card on the keyboard.
//
// Install (in ~/.claude/settings.json):
//   "hooks": {
//     "Notification": [{ "hooks": [{ "type": "command",
//       "command": "node C:/Users/bette/al80-studio/host/hooks/al80-notify.mjs" }] }]
//   }
// The Notification hook fires when Claude needs attention (permission / waiting for input).
// (Optional: also add under "Stop" for a transient "done" card on long turns — noisier, so gate it.)
//
// Reads the hook JSON on stdin, POSTs an alert to the local daemon, and ALWAYS exits 0 quickly —
// a stopped/slow daemon must never delay or break Claude. Verify the exact hook payload fields
// against your Claude Code version; `message` and `cwd` are the ones we use.
import { basename } from 'node:path';

const PORT = process.env.AL80_PORT || 7333;
const isStop = process.argv.includes('--stop');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let ev = {};
  try { ev = JSON.parse(raw); } catch { /* no/!json payload */ }
  const project = basename(ev.cwd || process.cwd());
  const alert = isStop
    ? { source: 'claude:' + (ev.session_id || 'default'), level: 'ok', label: 'CLAUDE', title: 'Claude done', body: project, sticky: false, ttl: 6000 }
    : { source: 'claude:' + (ev.session_id || 'default'), level: 'warn', label: 'CLAUDE', title: 'Claude needs you', body: `${project} · ${ev.message || 'waiting for you'}`, sticky: true };
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 300);
    await fetch(`http://127.0.0.1:${PORT}/alert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(alert), signal: ctrl.signal });
    clearTimeout(to);
  } catch { /* daemon down/slow — silent, never block Claude */ }
  process.exit(0);
});
setTimeout(() => process.exit(0), 500); // exit even if no stdin arrives
