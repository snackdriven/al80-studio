// Local alert intake on 127.0.0.1 — the Claude-needs-you hook and any local/terminal notifier POST
// here (no internet round-trip). Internet-origin webhooks arrive via the ntfy relay instead; both
// feed the same scheduler.onAlert. Uses Node's built-in http — no dependency.
import http from 'node:http';
import { normalizeAlert } from '../apps/alert.js';

/**
 * @param {import('../lib/scheduler.js').Scheduler} scheduler
 * @param {{port?:number, now?:()=>number}} opts
 * @returns {import('node:http').Server}
 */
export function startLocalHook(scheduler, { port = 7333, now = () => Date.now() } = {}) {
  const server = http.createServer((req, res) => {
    const send = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg); };
    if (req.method === 'POST' && req.url === '/alert') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        try { scheduler.onAlert(normalizeAlert(JSON.parse(body)), now()); send(200, 'ok'); }
        catch { send(400, 'bad json'); }
      });
    } else if (req.method === 'POST' && req.url === '/ack') {
      scheduler.ack(); send(200, 'ok');
    } else if (req.method === 'GET' && req.url === '/status') {
      send(200, JSON.stringify({ active: scheduler.active().id, alerts: scheduler.alertCount }));
    } else {
      send(404, 'not found');
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
