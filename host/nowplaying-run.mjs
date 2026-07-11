// Now-playing on the AL80 screen, as a single-panel launcher over panels/nowplaying.js (Phase 0
// refactor of the auto-cycle SPARC — same behavior as before the split: poll on the panel's own
// cadence, push/delete-before-add via device.js, rest on home when idle/paused-out). For the
// multi-panel always-on host (now-playing + weather + clock, alerts, smart rules) use cycle-run.mjs.
//
// Usage (close al80-studio / usevia first — one app owns the keyboard at a time):
//   node nowplaying-run.mjs                 MOCK track + real screen  (proves it with NO Spotify creds)
//   node nowplaying-run.mjs --live          real Spotify + real screen
//   node nowplaying-run.mjs --live --sync   also tint the RGB to the cover's dominant colour
//   node nowplaying-run.mjs --mock-device   dry run, no hardware (logs packet counts)
//
// Live mode needs SPOTIFY_CLIENT_ID + SPOTIFY_REFRESH_TOKEN in the environment — run
// `node spotify-auth.mjs` once to get them.
import Device, { MockDevice } from './device.js';
import { makeNowPlayingPanel } from './panels/nowplaying.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const SYNC_RGB = args.has('--sync');
const MOCK_DEVICE = args.has('--mock-device');
const POLL_MS = 5000;
const PROGRESS_REFRESH_MS = 15000; // re-push the frame this often to advance the progress bar, even mid-track

async function main() {
  const dev = MOCK_DEVICE ? new MockDevice() : new Device();
  try { dev.open(); }
  catch (e) {
    console.log('[nowplaying] waiting for device:', e.message); // at logon the keyboard often enumerates after us
    await dev.reopen(); // retries with backoff (1s,2s,…5s cap) until it's plugged in
  }
  console.log(`[nowplaying] ${LIVE ? 'LIVE (Spotify)' : 'MOCK track'} -> ${MOCK_DEVICE ? 'mock device' : 'AL80 screen'}. Ctrl-C to stop.`);

  const panel = makeNowPlayingPanel({ live: LIVE });
  let committed = false;  // have WE committed a card to the ring? gates the delete-before-add (device.sendCard)
  let showingHome = true; // start parked (matches the old runner's first-poll behavior)
  let lastSentAt = 0;     // drives the periodic progress-bar advance, same cadence as before the split

  process.on('SIGINT', async () => {
    try { if (committed && dev.opened) await dev.deletePicture(); } catch { /* best effort */ }
    try { dev.close(); } catch { /* gone */ }
    console.log('\n[nowplaying] stopped');
    process.exit(0);
  });

  for (;;) {
    try { await panel.poll(); } catch (e) { console.log('[nowplaying]', e.message); }
    const trackChanged = panel.wantsFocus(); // consume-once; also true on the very first available() poll

    if (panel.available()) {
      const progressDue = Date.now() - lastSentAt >= PROGRESS_REFRESH_MS;
      if (trackChanged || showingHome || progressDue) {
        const frame = panel.render();
        try {
          const r = await dev.sendCard(frame, { replacePrevious: committed });
          console.log(`[send] ${r.acked}/${r.dataBlocks} blocks acked, ${r.fellBack} fell back`);
          committed = true;
          showingHome = false;
          lastSentAt = Date.now();
          if (SYNC_RGB && !MOCK_DEVICE && trackChanged) {
            const rgb = panel.rgb?.();
            if (rgb) { try { await dev.setRGB({ effect: 1, color: rgb }); } catch { /* best effort */ } }
          }
        } catch (e) {
          console.log('[send]', e.message);
          if (!dev.opened) {
            console.log('[nowplaying] device dropped — reconnecting…');
            committed = false; // after a reconnect we can't be sure our card is still the displayed slot
            try { await dev.reopen(); console.log('[nowplaying] reconnected'); }
            catch (re) { console.log('[nowplaying] reconnect failed:', re.message); }
          }
          // leave showingHome/lastSentAt unchanged so this frame is re-attempted on the next poll
        }
      }
    } else if (!showingHome) {
      console.log('[nowplaying] nothing playing (or paused a while) — back to home');
      try {
        if (committed) await dev.deletePicture();
        await dev.goHome();
      } catch (e) { console.log('[nowplaying] home switch:', e.message); }
      committed = false;
      showingHome = true;
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error('[nowplaying] fatal:', e.message); process.exit(1); });
