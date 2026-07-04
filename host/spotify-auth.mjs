// One-time Spotify auth (PKCE — no client secret). Run once to get your refresh token.
//
//   1. Create a free app at https://developer.spotify.com/dashboard
//        - copy the CLIENT ID
//        - under "Redirect URIs" add EXACTLY:  http://127.0.0.1:8888/callback
//   2. Run:   SPOTIFY_CLIENT_ID=your_id node spotify-auth.mjs      (or pass the id as the first arg)
//   3. Open the printed URL, approve; this prints your SPOTIFY_REFRESH_TOKEN.
//   4. Put both values in your environment (or a .env), then:  node nowplaying-run.mjs --live
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import {
  generateCodeVerifier, codeChallenge, buildAuthUrl, exchangeCodeForToken, DEFAULT_SCOPES,
} from './lib/spotify.js';

const clientId = process.env.SPOTIFY_CLIENT_ID || process.argv[2];
const REDIRECT = 'http://127.0.0.1:8888/callback';
if (!clientId) {
  console.error('Set SPOTIFY_CLIENT_ID (env var or first arg). Get it from https://developer.spotify.com/dashboard');
  process.exit(1);
}

const verifier = generateCodeVerifier();
const challenge = await codeChallenge(verifier);
const state = Math.random().toString(36).slice(2);
const url = buildAuthUrl({ clientId, redirectUri: REDIRECT, codeChallenge: challenge, scopes: DEFAULT_SCOPES, state });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (!u.pathname.startsWith('/callback')) { res.writeHead(404).end(); return; }
  const code = u.searchParams.get('code');
  const err = u.searchParams.get('error');
  if (err || !code) {
    res.writeHead(400).end(`Auth failed: ${err || 'no code'}`);
    console.error('\nAuth failed:', err || 'no code returned');
    server.close(); process.exit(1);
  }
  try {
    const tok = await exchangeCodeForToken({ clientId, code, redirectUri: REDIRECT, codeVerifier: verifier });
    writeFileSync(new URL('./.env', import.meta.url), `SPOTIFY_CLIENT_ID=${clientId}\nSPOTIFY_REFRESH_TOKEN=${tok.refreshToken}\n`);
    res.writeHead(200, { 'content-type': 'text/html' }).end('<h2>Done &mdash; close this tab and return to your terminal.</h2>');
    console.log('\n=== SUCCESS — creds written to host/.env (gitignored). Run: node nowplaying-run.mjs --live ===');
    server.close(); process.exit(0);
  } catch (e) {
    res.writeHead(500).end('Token exchange failed: ' + e.message);
    console.error('\nToken exchange failed:', e.message);
    server.close(); process.exit(1);
  }
});

server.listen(8888, '127.0.0.1', () => {
  writeFileSync(new URL('./.spotify-auth-url.txt', import.meta.url), url);
  console.log('\nOpen this URL in your browser, approve access, then come back here:\n');
  console.log(url + '\n');
  console.log('(Listening for the redirect on http://127.0.0.1:8888/callback …)');
});
