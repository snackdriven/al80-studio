// AL80 Studio — UI shell. Vanilla ES module, no framework, no build step.
//
// WebHID only works over a secure context: serve this over HTTPS or from
// http://localhost / http://127.0.0.1. Opening index.html via file:// will NOT
// expose navigator.hid, and Connect will fail. GitHub Pages (HTTPS) is fine.
//
// Only Chrome / Edge (Chromium 89+) ship WebHID today.

import * as proto from './protocol.js';
import * as hid from './hid.js';
import * as image from './image.js';
import * as gif from './gif.js';
import * as keymap from './keymap.js';
import * as spotify from './nowplaying/spotify.js';
import { render as renderNowPlayingCard } from './nowplaying/card.js';
import { loadArtRGB } from './nowplaying/albumart.js';
import * as weather from './weather/weather.js';
import { render as renderWeatherCard } from './weather/card.js';
import * as slots from './slots.js';
import * as effects from './effects.js';
import * as music from './music.js';

// ---- tiny DOM helpers -------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Persist a control's value to localStorage and restore it on load. Preferences only — this
// never auto-sends to the device, it just remembers the UI choice across reloads. onRestore
// lets the caller re-sync a dependent display (e.g. a slider's <output>) after restoring.
function persist(el, key, onRestore) {
  if (!el) return;
  const k = 'al80.pref.' + key;
  try {
    const saved = localStorage.getItem(k);
    if (saved != null) {
      if (el.type === 'checkbox') el.checked = saved === 'true';
      else el.value = saved;
      onRestore?.(el);
    }
  } catch { /* storage unavailable */ }
  el.addEventListener('change', () => {
    try { localStorage.setItem(k, el.type === 'checkbox' ? String(el.checked) : el.value); } catch { /* ignore */ }
  });
}

// Same idea as persist(), but for a radio GROUP (a set of inputs sharing a name). Restores the
// checked radio by value on load and saves on change. onRestore lets the caller re-run whatever the
// radios drive (e.g. applyDest) so dependent display isn't stale — restore does NOT fire a change.
function persistRadio(name, key, onRestore) {
  const radios = $$(`input[name="${name}"]`);
  if (!radios.length) return;
  const k = 'al80.pref.' + key;
  try {
    const saved = localStorage.getItem(k);
    if (saved != null) {
      const match = radios.find((r) => r.value === saved);
      if (match && !match.checked) { match.checked = true; onRestore?.(); }
    }
  } catch { /* storage unavailable */ }
  radios.forEach((r) => r.addEventListener('change', () => {
    if (r.checked) { try { localStorage.setItem(k, r.value); } catch { /* ignore */ } }
  }));
}

function setStatus(el, msg, kind = '') {
  el.textContent = msg || '';
  el.className = 'statusline' + (kind ? ' ' + kind : '');
}

/** Normalize whatever hid.onStatus hands us into {state, text}. */
function normalizeStatus(s) {
  // Accepts a string ('connected'), a boolean, or an object {connected, message/state}.
  if (typeof s === 'string') {
    const connected = /connect(ed)?/i.test(s) && !/dis/i.test(s);
    return { connected, state: s, text: s.charAt(0).toUpperCase() + s.slice(1) };
  }
  if (typeof s === 'boolean') {
    return { connected: s, state: s ? 'connected' : 'disconnected', text: s ? 'Connected' : 'Disconnected' };
  }
  const o = s || {};
  const connected = o.connected ?? (o.state ? /connected/i.test(o.state) : false);
  return {
    connected,
    state: o.state || (connected ? 'connected' : 'disconnected'),
    text: o.message || o.text || (connected ? 'Connected' : 'Disconnected'),
  };
}

// ---- device log -------------------------------------------------------------
// Every command this app sends gets a timestamped line. The device is write-only
// (hid.send returns {sent, ms} — no reply is exposed), so we log what we sent and
// the outcome. window.__al80log mirrors the entries for live debugging in DevTools.
window.__al80log = window.__al80log || [];

function devLog(label, info = {}) {
  const now = new Date();
  const entry = {
    t: now.toISOString(),
    time: now.toLocaleTimeString(),
    label,
    ...info, // { packets, ok, ms, error, reply? }
  };
  window.__al80log.push(entry);
  renderLogEntry(entry);
  return entry;
}

function renderLogEntry(entry) {
  const list = $('#logList');
  const countEl = $('#logCount');
  if (!list) return;
  const li = document.createElement('li');
  li.className = entry.error ? 'err' : entry.ok ? 'ok' : '';

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = entry.time;

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  const parts = [entry.label];
  if (typeof entry.packets === 'number') parts.push(`${entry.packets} pkt${entry.packets === 1 ? '' : 's'}`);
  if (entry.error) parts.push('FAILED: ' + entry.error);
  else if (typeof entry.ms === 'number') parts.push(`ok in ${Math.round(entry.ms)}ms`);
  else if (entry.ok) parts.push('ok');
  if (entry.reply != null) parts.push('reply: ' + entry.reply);
  msg.textContent = parts.join(' · ');
  msg.title = msg.textContent;

  li.append(time, msg);
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
  if (countEl) countEl.textContent = String(window.__al80log.length);
}

function setupDeviceLog() {
  const clearBtn = $('#logClear');
  if (!clearBtn) return;
  clearBtn.addEventListener('click', () => {
    window.__al80log.length = 0;
    $('#logList').innerHTML = '';
    $('#logCount').textContent = '0';
  });
}

// ---- global connected state -------------------------------------------------
let connected = false;

function reflectConnection() {
  $$('.device-action').forEach((el) => {
    el.disabled = !connected;
  });
  // Mirror connection onto #app so CSS can gate device-only chrome (the live device bar).
  document.querySelector('#app')?.toggleAttribute('data-connected', connected);
  const gate = $('#lcdGate');
  if (gate) gate.hidden = connected;
  // if we just disconnected, stop clock sync, any running slideshow cycle, and any lighting effect
  if (!connected) {
    stopClockSync();
    slideshowCtl.stop();
    lightingFxCtl.stop();
    keymapTesterCtl.stop();
    nowPlayingCtl.stop();
    weatherCtl.stop();
  }
  nowPlayingCtl.sync?.(); // refresh Now Playing button gating on every connection change
  weatherCtl.sync?.();    // and the weather tab's status/self-arm
}

// Wrap a device action: catch errors (incl. the single-opener one), log, surface.
async function guardedSend(label, statusEl, packets, opts = {}) {
  try {
    const res = await hid.send(packets, { gap: 0, ...opts });
    devLog(label, { packets: packets.length, ok: true, ms: res && res.ms, reply: res && res.reply });
    return true;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    devLog(label, { packets: packets.length, error: msg });
    if (statusEl) setStatus(statusEl, 'Send failed: ' + msg, 'err');
    return false;
  }
}

// ---- VIA request/response ---------------------------------------------------
// The LCD/lighting path is write-only, but VIA keymap reads need the device's
// reply, which arrives on an 'inputreport' event. hid.js exposes the open
// HIDDevice via getDevice(); we attach a one-shot listener here, send the
// request, and resolve with the reply bytes. Defensive by construction: a
// match() predicate filters out unrelated reports (the firmware multiplexes LCD
// + VIA on one channel), and a timeout rejects rather than hanging the UI if the
// firmware never answers a given command.
//
// e.data is a DataView over the report BODY (report id 0 is unnumbered, so it's
// not present). VIA replies echo the request's command byte(s) in data[0..].
function viaTransact(requestReport, match, timeoutMs = 600) {
  const dev = hid.getDevice && hid.getDevice();
  if (!dev || !dev.opened) return Promise.reject(new Error('Not connected.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onReport = (e) => {
      const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      if (match(d)) { finish(); resolve(d); }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      dev.removeEventListener('inputreport', onReport);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('VIA read timed out (no reply from device)'));
    }, timeoutMs);
    dev.addEventListener('inputreport', onReport);
    hid.send([requestReport]).catch((err) => { finish(); reject(err); });
  });
}

// Chunked send so we can drive a progress bar without depending on an
// undocumented progress callback in hid.send. Each chunk is an independent
// batch of 64-byte reports; gap is applied inside hid.send per its contract.
async function sendWithProgress(label, statusEl, packets, onFraction, opts = {}) {
  const CHUNK = 20;
  const start = performance.now();
  try {
    for (let i = 0; i < packets.length; i += CHUNK) {
      await hid.send(packets.slice(i, i + CHUNK), { gap: 0, ...opts });
      onFraction(Math.min(packets.length, i + CHUNK) / packets.length);
    }
    devLog(label, { packets: packets.length, ok: true, ms: performance.now() - start });
    return true;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    devLog(label, { packets: packets.length, error: msg });
    if (statusEl) setStatus(statusEl, 'Send failed: ' + msg, 'err');
    return false;
  }
}

// GIF/animation send with the vendor's per-bank/per-frame pacing (hid.sendGif). Chunking would
// break that timing, so this is separate from sendWithProgress. The device needs those pauses to
// commit each bank; without them, GIFs render as garbage bars. Slower on purpose (seconds).
async function sendGifWithProgress(label, statusEl, packets, onFraction) {
  const start = performance.now();
  try {
    await hid.sendGif(packets, onFraction);
    devLog(label, { packets: packets.length, ok: true, ms: performance.now() - start });
    return true;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    devLog(label, { packets: packets.length, error: msg });
    if (statusEl) setStatus(statusEl, 'Send failed: ' + msg, 'err');
    return false;
  }
}

// Still-image send that ACK-gates each pixel block (hid.sendAckGated) — the fix for picture-page
// banding/white. Blasting drops bytes; waiting for each block's echo doesn't. Separate from
// sendWithProgress because chunking/gap-0 is exactly what causes the drops.
async function sendAckGatedWithProgress(label, statusEl, packets, onFraction) {
  const start = performance.now();
  try {
    await hid.sendAckGated(packets, onFraction);
    devLog(label, { packets: packets.length, ok: true, ms: performance.now() - start });
    return true;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    devLog(label, { packets: packets.length, error: msg });
    if (statusEl) setStatus(statusEl, 'Send failed: ' + msg, 'err');
    return false;
  }
}

// ---- init -------------------------------------------------------------------
function init() {
  if (!hid.isSupported()) {
    renderUnsupported();
    return;
  }
  setupHeader();
  setupSections();
  setupTabs();
  setupNowShowing();
  setupDeviceLog();
  setupClockTab();
  setupImageTab();
  setupGifTab();
  setupSlideshowTab();
  setupNowPlayingTab();
  setupWeatherTab();
  setupLightingTab();
  setupClearActions();
  setupKeymap();
  setupSlots();
  setupEasterEgg();
  reflectConnection();
}

// Easter egg: press "?" (outside a text field) to open the GitHub repo.
function setupEasterEgg() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    window.open('https://github.com/snackdriven/al80-studio', '_blank', 'noopener');
  });
}

function renderUnsupported() {
  document.body.innerHTML = `
    <div class="unsupported">
      <h1>Use Chrome or Edge</h1>
      <p>AL80 Studio talks to your keyboard over WebHID, which only works in
      Chromium browsers (Chrome, Edge, or similar). Open this page in one of those,
      served over HTTPS or localhost.</p>
    </div>`;
}

// ---- header / connection ----------------------------------------------------
function setupHeader() {
  const dot = $('#statusDot');
  const text = $('#statusText');
  const btn = $('#connectBtn');
  const warn = $('#connectWarn');

  async function toggleConnect() {
    try {
      if (connected) {
        await hid.disconnect();
      } else {
        dot.dataset.state = 'connecting';
        text.textContent = 'Connecting…';
        await hid.connect();
      }
    } catch (err) {
      const msg = (err && err.message) || String(err);
      dot.dataset.state = 'error';
      text.textContent = msg;
      if (warn) warn.hidden = false;
      devLog('Connect', { error: msg });
    }
  }

  hid.onStatus((s) => {
    const n = normalizeStatus(s);
    const was = connected;
    connected = n.connected;
    dot.dataset.state = n.connected ? 'connected' : (n.state === 'error' ? 'error' : 'disconnected');
    text.textContent = n.text;
    btn.textContent = n.connected ? 'Disconnect' : 'Connect';
    if (warn) warn.hidden = n.connected; // contextual: only shown while disconnected
    if (n.connected && !was) {
      devLog('Connected', { ok: true });
      setNowShowing('unknown'); // fresh connect — app can't read device state back
    }
    if (!n.connected && was) devLog('Disconnected', {});
    if (!n.connected) setNowShowing('unknown');
    reflectConnection();
  });

  btn.addEventListener('click', toggleConnect);

  // Reflect an already-open device (e.g. after reload with a granted device).
  try {
    if (hid.getDevice && hid.getDevice()) {
      connected = true;
      if (warn) warn.hidden = true;
      setNowShowing('unknown');
      reflectConnection();
    }
  } catch { /* ignore */ }
}

// The GIF preview runs a setInterval; the tab/section handlers pause it when the GIF
// panel isn't visible so it doesn't keep repainting a hidden canvas. setupGifTab fills
// these in. gifVisible() tells the handlers whether the GIF panel is currently showing.
const gifPreviewCtl = { start() {}, stop() {} };
const gifVisible = () =>
  document.querySelector('#app')?.dataset.section === 'lcd' &&
  document.querySelector('.panel[data-panel="gif"]')?.hidden === false;

// The Slideshow auto-cycle runs a setInterval that fires "next picture" on the device.
// It must never run while the panel is hidden or the device is disconnected, so the
// tab/section/connection handlers stop it (mirrors gifPreviewCtl). setupSlideshowTab
// fills in stop(). slideshowVisible() tells the handlers whether the panel is showing.
const slideshowCtl = { stop() {} };
const slideshowVisible = () =>
  document.querySelector('#app')?.dataset.section === 'lcd' &&
  document.querySelector('.panel[data-panel="slideshow"]')?.hidden === false;

// A software lighting effect (strobe / cycle / breathe) is a host-driven color loop that streams
// save-less color reports over the connection. Exactly one runs at a time. Like the slideshow cycle,
// it must stop when the Lighting panel is hidden or the device disconnects; setupLightingTab fills
// stop() in. lightingVisible() tells the handlers whether the panel is currently showing.
const lightingFxCtl = { stop() {} };
const lightingVisible = () =>
  document.querySelector('#app')?.dataset.section === 'lighting';

// The keymap key tester polls the switch-matrix state on an interval. Like the
// lighting effect, it must stop when the Keymap section is hidden or the device
// disconnects; setupKeymap fills stop() in.
const keymapTesterCtl = { stop() {} };
const keymapVisible = () => document.querySelector('#app')?.dataset.section === 'keymap';

// WAI-ARIA tab keyboard support: Left/Right/Up/Down + Home/End move between tabs and
// activate them; a roving tabindex means Tab enters the tablist at the selected tab
// (not every tab). Delegated on the container so it survives rebuilt tabs (layers).
function wireTablistArrows(container) {
  if (!container) return;
  container.addEventListener('keydown', (e) => {
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let j;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    else return;
    e.preventDefault();
    tabs[j].focus();
    tabs[j].click();
  });
}
function rovingTabindex(tabs) {
  tabs.forEach((t) => { t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1; });
}

// ---- top-level sections (LCD / Keymap) --------------------------------------
function setupSections() {
  const app = $('#app');
  const btns = $$('.section-btn');
  const panels = $$('[data-section-panel]');
  btns.forEach((b) => {
    b.addEventListener('click', () => {
      const name = b.dataset.section;
      app.dataset.section = name;
      btns.forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      rovingTabindex(btns);
      panels.forEach((p) => { p.hidden = p.dataset.sectionPanel !== name; });
      if (gifVisible()) gifPreviewCtl.start(); else gifPreviewCtl.stop();
      if (!slideshowVisible()) slideshowCtl.stop();
      if (!lightingVisible()) lightingFxCtl.stop();
      if (!keymapVisible()) keymapTesterCtl.stop();
      if (nowPlayingVisible()) nowPlayingCtl.start?.(); else nowPlayingCtl.stop(); // self-arming with the tab/section
      if (weatherVisible()) weatherCtl.start?.(); else weatherCtl.stop();
    });
  });
  rovingTabindex(btns);
  wireTablistArrows($('.sections'));
}

// ---- LCD content sub-tabs ----------------------------------------------------
function setupTabs() {
  const tabs = $$('.tab');
  const panels = $$('.panel[data-panel]');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      rovingTabindex(tabs);
      panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
      if (name === 'gif') gifPreviewCtl.start(); else gifPreviewCtl.stop();
      if (name !== 'slideshow') slideshowCtl.stop();
      if (name !== 'lighting') lightingFxCtl.stop();
      // Now-playing and weather both keep running across LCD tabs; each start() stops the other
      // (mutual exclusion), and a real send from another tab or leaving the section hands off the screen.
      if (name === 'nowplaying') nowPlayingCtl.start?.();
      else if (name === 'weather') weatherCtl.start?.();
    });
  });
  rovingTabindex(tabs);
  wireTablistArrows($('.tabs'));
}

// The Now Playing live push is a host-driven poll loop that re-renders + pushes the card when the
// Spotify track (or play/pause) changes. Like the lighting effect, it must stop when the tab is left
// or the device disconnects; setupNowPlayingTab fills stop() in.
const nowPlayingCtl = { stop() {} };
const nowPlayingVisible = () =>
  document.querySelector('#app')?.dataset.section === 'lcd' &&
  document.querySelector('.panel[data-panel="nowplaying"]')?.hidden === false;

// Weather is the second ambient-display feature and shares the same "one screen, one owner"
// constraint as now-playing — they cannot both drive the picture page. It self-arms on its own tab
// exactly like now-playing; setupWeatherTab fills start/stop/sync in. Declared at module scope (next
// to nowPlayingCtl) so each setup can reference the other for the mutual-exclusion handoff.
const weatherCtl = { stop() {} };
const weatherVisible = () =>
  document.querySelector('#app')?.dataset.section === 'lcd' &&
  document.querySelector('.panel[data-panel="weather"]')?.hidden === false;

// Per-tab file loaders, registered by each setup*Tab so the Recents "Load into tab" action can drop
// a cached source back into the editor. Keyed by tab name ('picture' | 'gif'). Assigned at init.
const tabLoaders = {};

// ---- Now Showing bar --------------------------------------------------------
// Tracks the last view THIS app set. 'unknown' on fresh connect (write-only device).
let lastView = 'unknown';

// Live ownership of the picture/main slot. While npLive is true the device bar reads a live label +
// readout, and the picture/main slot cards show a live badge instead of a stale thumbnail. Set by
// slotsLive() from either the Now Playing loop or the Weather loop; read by setNowShowing + the card
// render. liveKind names WHICH feature owns it ('np' | 'weather') so the bar/cards label it right.
let npLive = false;
let npTrack = null;
let liveKind = 'np';

// The live readout labels per owner: the bar title, the slot-card badge, and its fallback sub-line.
const LIVE_LABELS = {
  np: { bar: '▶ Now Playing', card: '▶ Now Playing (live)', fallbackSub: 'streaming from Spotify' },
  weather: { bar: '☀ Weather', card: '☀ Weather (live)', fallbackSub: 'showing local weather' },
};

const NS_SEGMENTS = {
  clock: { view: proto.VIEW.HOMEPAGE, label: 'Clock' },
  picture: { view: proto.VIEW.PICTURE, label: 'Picture' },
  gif: { view: proto.VIEW.GIF, label: 'GIF' },
};

function setNowShowing(which) {
  lastView = which;
  // While Now Playing owns the bar (npLive), don't clobber its label or its pressed segment — a push
  // still calls setNowShowing('picture') to track the view, but the live state must win. lastView is
  // recorded above so renderBarLive can restore the normal readout when NP stops.
  if (npLive) return;
  $$('.ns-chip').forEach((seg) => {
    seg.setAttribute('aria-pressed', String(seg.dataset.view === which));
  });
  const stateEl = $('#nsState');
  if (stateEl) stateEl.textContent = which === 'unknown' ? 'unknown' : NS_SEGMENTS[which].label;
}

function setupNowShowing() {
  $$('.ns-chip').forEach((seg) => {
    seg.addEventListener('click', async () => {
      // The Now Playing / Weather chips (data-live) don't send a firmware VIEW opcode — they ARM a
      // live push loop that owns the picture page. The controllers self-guard and stop each other, so
      // just hand off; the pressed state follows liveKind via renderBarLive once the loop claims the slot.
      const live = seg.dataset.live;
      if (live) {
        if (live === 'weather') weatherCtl.start?.(); else nowPlayingCtl.start?.();
        return;
      }
      const key = seg.dataset.view;
      const spec = NS_SEGMENTS[key];
      if (!spec) return;
      // Switching to a static view means you're done with the live push — stop it so the loop
      // doesn't keep overwriting your view, and so the npLive guard releases and the bar updates.
      if (npLive) nowPlayingCtl.stop?.();
      weatherCtl.stop?.(); // weather also drives the picture page — a manual view switch takes it over
      const ok = await guardedSend(`View → ${spec.label}`, null, proto.buildView(spec.view), { gap: 1 });
      if (ok) setNowShowing(key);
    });
  });
  setNowShowing('unknown');
}

// ---- clock ------------------------------------------------------------------
let clockSyncTimer = null;
let clockLiveTimer = null; // 1s UI ticker for the live-time hero (not the device sync)

function readClockDate() {
  // Compose a Date from the time + date inputs; fall back to now.
  const t = $('#clockTime').value;
  const d = $('#clockDate').value;
  if (!t || !d) return new Date();
  const [hh, mm, ss = '0'] = t.split(':');
  const [Y, M, D] = d.split('-');
  return new Date(+Y, +M - 1, +D, +hh, +mm, +ss);
}

function stopClockSync() {
  if (clockSyncTimer) {
    clearInterval(clockSyncTimer);
    clockSyncTimer = null;
    const cb = $('#clockSync');
    if (cb) cb.checked = false;
  }
  const badge = $('#syncBadge');
  if (badge) badge.hidden = true;
}

function setupClockTab() {
  const statusEl = $('#clockStatus');
  const is12 = $('#clock12hr');
  const badge = $('#syncBadge');
  persist(is12, 'clock12hr');

  // default to now — both fields in LOCAL time. toISOString() gives a UTC date that
  // disagrees with the local time field by a day in the evening in the Americas, which
  // then pushed the wrong calendar day to the keyboard.
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  $('#clockTime').value = now.toTimeString().slice(0, 8);
  $('#clockDate').value = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

  // Live-time hero — the thing Send pushes, ticking every second. Mirrors the 12/24h toggle so
  // flipping it visibly changes the readout (that's the format that gets sent to the board).
  const liveEl = $('#clockLive');
  const liveDateEl = $('#clockLiveDate');
  // Match the LCD home page: firmware-drawn HH:MM + the date, no seconds and no AM/PM chrome.
  // 12-hour just drops the leading zero on the hour (no meridiem); 24-hour pads it.
  function renderLive() {
    const d = new Date();
    const mm = pad2(d.getMinutes());
    const h = is12.checked ? (d.getHours() % 12 || 12) : pad2(d.getHours());
    liveEl.textContent = `${h}:${mm}`;
    liveDateEl.textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  renderLive();
  is12.addEventListener('change', renderLive); // reflect the toggle immediately, not on the next tick
  // setupClockTab runs once, but guard anyway so we never stack ticking intervals.
  if (!clockLiveTimer) clockLiveTimer = setInterval(renderLive, 1000);

  async function sendOnce(useNow = false) {
    const date = useNow ? new Date() : readClockDate();
    const packets = proto.clockFromDate(date, is12.checked);
    setStatus(statusEl, 'Sending clock…');
    const ok = await guardedSend('Clock set', statusEl, packets, { gap: 1 });
    if (!ok) return false;
    // Show it: the clock lives on the Homepage view. Switch so it's visible.
    if (!await guardedSend('View → Clock', statusEl, proto.buildView(proto.VIEW.HOMEPAGE), { gap: 1 })) return false;
    setNowShowing('clock');
    setStatus(statusEl, 'Clock set to ' + date.toLocaleTimeString(), 'ok');
    return true;
  }

  // Primary action is "push the time on my computer right now" — the 99% case. clock takes the screen.
  $('#clockSendOnce').addEventListener('click', () => { nowPlayingCtl.stop(); weatherCtl.stop(); sendOnce(true); });
  // Secondary: push whatever's in the manual Time/Date fields (staging a photo, setting ahead).
  $('#clockSendManual').addEventListener('click', () => { nowPlayingCtl.stop(); weatherCtl.stop(); sendOnce(false); });

  $('#clockSync').addEventListener('change', async (e) => {
    if (e.target.checked) {
      // Clock (home page) and Now Playing (picture page) both drive the screen — one owner at a
      // time. Clock-sync switches the view home every 60s, which would yank the screen off a live
      // now-playing card, so starting the sync stops now-playing (the Show-bar view switch already
      // stops it the same way).
      nowPlayingCtl.stop?.();
      weatherCtl.stop?.(); // clock-sync flips the view home every 60s — it can't co-own the screen with weather either
      stopClockSync();
      e.target.checked = true;
      if (!await sendOnce(true)) {
        e.target.checked = false;
        if (badge) badge.hidden = true;
        return;
      }
      if (!e.target.checked) return;
      clockSyncTimer = setInterval(() => sendOnce(true), 60000);
      if (badge) badge.hidden = false;
      setStatus(statusEl, 'Syncing every 60s…', 'ok');
    } else {
      stopClockSync();
      setStatus(statusEl, 'Sync stopped.');
    }
  });
}

// ---- picture (was "image") --------------------------------------------------
function setupImageTab() {
  const statusEl = $('#imageStatus');
  const previewImg = $('#imagePreview');
  const fileInput = $('#imageFile');
  const drop = $('#imageDrop');
  const nameEl = $('#imageName');
  let currentFile = null;

  const controls = {
    fit: $('#imageFit'),
    brightness: $('#imageBrightness'),
    contrast: $('#imageContrast'),
    saturation: $('#imageSaturation'),
    gray: $('#imageGray'),
    dither: $('#imageDither'),
  };

  // range value read-outs
  const outs = {
    brightness: $('#imageBrightnessOut'),
    contrast: $('#imageContrastOut'),
    saturation: $('#imageSaturationOut'),
  };

  // Remember the editor settings across reloads (UI only — never auto-sends; readOpts reads the
  // restored values at send time). Sliders re-sync their <output> via onRestore so it isn't stale.
  persist(controls.fit, 'imageFit');
  persist(controls.brightness, 'imageBrightness', (el) => { outs.brightness.textContent = el.value + '%'; });
  persist(controls.contrast, 'imageContrast', (el) => { outs.contrast.textContent = el.value + '%'; });
  persist(controls.saturation, 'imageSaturation', (el) => { outs.saturation.textContent = el.value + '%'; });
  persist(controls.gray, 'imageGray');
  persist(controls.dither, 'imageDither');

  // opts: sliders are percentages where 100 = neutral, passed as factors (1.0 = neutral).
  function readOpts() {
    return {
      fit: controls.fit.value,
      brightness: +controls.brightness.value / 100,
      contrast: +controls.contrast.value / 100,
      saturation: +controls.saturation.value / 100,
      grayscale: controls.gray.checked,
      dither: controls.dither.checked,
    };
  }

  const previewLabel = $('#imagePreviewLabel');
  const destNote = $('#picDestNote');
  const readDest = () => document.querySelector('input[name="picDest"]:checked')?.value || 'main';

  // Reflect the chosen destination in the preview size/label/note, then re-render.
  function applyDest() {
    if (readDest() === 'main') {
      previewLabel.innerHTML = 'Preview (96&times;64 main page)';
      previewImg.style.width = '288px'; previewImg.style.height = '192px'; // inline beats the #imagePreview CSS rule
      destNote.textContent = 'Shows beside the clock on the home screen.';
    } else {
      previewLabel.innerHTML = 'Preview (96&times;160 picture page)';
      previewImg.style.width = '144px'; previewImg.style.height = '240px';
      destNote.textContent = 'Fills the picture view with your image.';
    }
    refreshPreview();
  }

  let previewTimer = null;
  async function refreshPreview() {
    if (!currentFile) return;
    try {
      const url = readDest() === 'main'
        ? await image.previewMainPageDataURL(currentFile, readOpts())
        : await image.previewDataURL(currentFile, readOpts());
      previewImg.src = url;
    } catch (err) {
      setStatus(statusEl, 'Preview failed: ' + ((err && err.message) || err), 'err');
    }
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 120);
  }
  $$('input[name="picDest"]').forEach((r) => r.addEventListener('change', applyDest));
  persistRadio('picDest', 'picDest'); // restore the chosen destination (applyDest below reflects it)
  applyDest(); // set the initial label/note

  function loadFile(file) {
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) {
      setStatus(statusEl, `Not an image: ${file.name}. Drop a PNG, JPG, GIF, or WebP.`, 'err');
      return;
    }
    currentFile = file;
    nameEl.textContent = file.name;
    refreshPreview();
  }

  fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));

  // Recents "Load into tab": set the destination to match the cached area, then load the source
  // File so the editor's controls apply on the next preview/send.
  tabLoaders.picture = (file, dest) => {
    const val = dest === 'main' ? 'main' : 'page';
    const r = document.querySelector(`input[name="picDest"][value="${val}"]`);
    if (r && !r.checked) { r.checked = true; applyDest(); }
    loadFile(file);
  };

  // drag + drop
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  // live controls
  ['brightness', 'contrast', 'saturation'].forEach((k) => {
    controls[k].addEventListener('input', () => {
      outs[k].textContent = controls[k].value + '%';
      schedulePreview();
    });
  });
  controls.fit.addEventListener('change', schedulePreview);
  controls.gray.addEventListener('change', schedulePreview);
  controls.dither.addEventListener('change', schedulePreview);

  // send & show
  const wrap = $('#imageProgressWrap');
  const bar = $('#imageProgress');
  $('#imageSend').addEventListener('click', async () => {
    if (!currentFile) { setStatus(statusEl, 'Pick an image first.', 'err'); return; }
    nowPlayingCtl.stop(); weatherCtl.stop(); // a manual push takes the screen from the live watchers
    const dest = readDest();
    setStatus(statusEl, 'Rendering frame…');
    let frame;
    try {
      // main page = 96x64 mode-2 (the surface that displays); picture page = 96x160 slot.
      frame = dest === 'main'
        ? await image.imageToMainPageFrame(currentFile, readOpts())
        : await image.imageToFrame(currentFile, readOpts());
    } catch (err) {
      setStatus(statusEl, 'Render failed: ' + ((err && err.message) || err), 'err');
      return;
    }
    let packets;
    try {
      packets = dest === 'main' ? proto.buildMainPageImage(frame) : proto.buildImageTransfer(frame);
    } catch (err) {
      setStatus(statusEl, 'Build failed: ' + ((err && err.message) || err), 'err');
      return;
    }
    wrap.hidden = false;
    bar.style.width = '0%';
    // Main-page still = a 1-frame mode-2 GIF, so a previously-stored multi-frame GIF can tail under it.
    // Wipe it first (same fix as the GIF tab). Best-effort: silence + ignore so a clear failure can't block.
    if (dest === 'main') {
      setStatus(statusEl, 'Clearing the old GIF…');
      await guardedSend('Clear GIF (pre-upload)', null, proto.buildClearGif(), { gap: 2 });
    }
    setStatus(statusEl, `Sending ${packets.length} packets…`);
    const onProg = (f) => { bar.style.width = Math.round(f * 100) + '%'; };
    // picture page = ACK-gated (blasting drops bytes); main page = plain send. (No pre-switch to home —
    // writing the picture buffer while parked on home doesn't land, leaving the old frame on screen.)
    try {
      const ok = dest === 'main'
        ? await sendGifWithProgress('Picture → main page', statusEl, packets, onProg)
        : await sendAckGatedWithProgress('Picture → picture page', statusEl, packets, onProg);
      if (ok) {
        if (dest === 'main') {
          setNowShowing('clock'); // main page = clock + your image
          setStatus(statusEl, 'Saved to the main page — it should be showing now.', 'ok');
        } else {
          setStatus(statusEl, 'Switching to picture page…');
          const shown = await guardedSend('View → Picture', statusEl, proto.buildView(proto.VIEW.PICTURE), { gap: 1 });
          if (shown) setNowShowing('picture');
          setStatus(statusEl, 'Sent to the picture page (may not display on your firmware).', 'ok');
        }
        // Remember what Studio just pushed (client-side slot cache).
        const area = dest === 'main' ? 'main' : 'picture';
        const [tw, th] = dest === 'main' ? [proto.MP_W, proto.MP_H] : [proto.WIDTH, proto.HEIGHT];
        const thumbBlob = await thumbFromFrame(frame, tw, th);
        await capturePush({
          area, name: currentFile.name || 'Picture', kind: 'image',
          sourceBlob: currentFile, settings: { ...readOpts(), dest }, thumbBlob,
        });
      }
    } finally {
      setTimeout(() => { wrap.hidden = true; }, 800);
    }
  });
}

// ---- gif --------------------------------------------------------------------
function setupGifTab() {
  const statusEl = $('#gifStatus');
  const fileInput = $('#gifFile');
  const nameEl = $('#gifName');
  const countEl = $('#gifCount');
  const fps = $('#gifFps');
  const fpsOut = $('#gifFpsOut');
  const fitEl = $('#gifFit');
  const previewCanvas = $('#gifPreview');
  const pctx = previewCanvas.getContext('2d');
  const destNote = $('#gifDestNote');
  let currentFile = null;
  let currentFrames = null;   // cached RGB565 frames at the current destination's resolution
  let previewImages = null;   // ImageData[] for the preview canvas
  let playTimer = null;
  let playIdx = 0;
  let loadToken = 0;          // guards against out-of-order decodes on rapid re-select / dest change

  const readDest = () => document.querySelector('input[name="gifDest"]:checked')?.value || 'main';
  // Destination drives decode resolution, frame cap, and preview box size.
  const dims = () => {
    const dst = readDest();
    if (dst === 'main') return { w: proto.MP_W, h: proto.MP_H, max: proto.MP_MAX_FRAMES, disp: [288, 192] };
    if (dst === 'startup') return { w: proto.SA_W, h: proto.SA_H, max: proto.SA_MAX_FRAMES, disp: [144, 240] }; // 96x160, cap 64
    return { w: proto.GP_W, h: proto.GP_H, max: proto.GP_MAX_FRAMES, disp: [144, 240] }; // gif page: 96x160
  };

  function stopPreview() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
  }
  // reset=true restarts from frame 0 (new file); reset=false keeps position (re-timing / tab return).
  function startPreview(reset = true) {
    stopPreview();
    if (!previewImages || !previewImages.length) return;
    if (reset || playIdx >= previewImages.length) playIdx = 0;
    const step = () => {
      pctx.putImageData(previewImages[playIdx % previewImages.length], 0, 0);
      playIdx++;
    };
    step(); // paint current frame immediately
    if (previewImages.length > 1) {
      playTimer = setInterval(step, Math.max(16, Math.round(1000 / (+fps.value || 1))));
    }
  }
  gifPreviewCtl.start = () => startPreview(false);
  gifPreviewCtl.stop = stopPreview;

  // Decode the current file at the current destination's resolution and (re)build the preview.
  async function decodeAndPreview() {
    if (!currentFile) return;
    const token = ++loadToken;
    const d = dims();
    countEl.textContent = 'Decoding…';
    stopPreview();
    currentFrames = null;
    previewImages = null;
    try {
      const frames = await gif.gifToFrames(currentFile, { maxFrames: d.max, width: d.w, height: d.h, fit: fitEl.value });
      if (token !== loadToken) return; // superseded by a newer decode
      currentFrames = frames;
      previewImages = frames.map((f) => new ImageData(image.frameToRGBA(f), d.w, d.h));
      previewCanvas.width = d.w; previewCanvas.height = d.h;
      previewCanvas.style.width = d.disp[0] + 'px'; previewCanvas.style.height = d.disp[1] + 'px';
      const total = frames.frameCount ?? frames.length;
      const cap = total > d.max ? ` (keeping the first ${d.max})` : '';
      countEl.textContent = `${total} frame${total === 1 ? '' : 's'}${cap}`;
      startPreview(true);
    } catch (err) {
      if (token !== loadToken) return;
      countEl.textContent = 'Could not read frames: ' + ((err && err.message) || err);
    }
  }

  function applyDest() {
    const dst = readDest();
    destNote.textContent = dst === 'main'
      ? 'Plays beside the clock on the home screen (96×64, up to 42 frames).'
      : dst === 'startup'
      ? 'Plays once when the keyboard powers on (96×160, up to 64 frames).'
      : 'Fills the GIF view (96×160, up to 160 frames).';
    if (currentFile) decodeAndPreview(); // re-decode at the new resolution
  }
  $$('input[name="gifDest"]').forEach((r) => r.addEventListener('change', applyDest));
  persistRadio('gifDest', 'gifDest'); // restore the chosen destination (applyDest below reflects it)
  applyDest(); // initial note

  // Remember GIF editor settings across reloads (UI only; no auto-send, no decode on restore since
  // no file is loaded yet). fps re-syncs its <output> via onRestore so it isn't stale.
  persist(fps, 'gifFps', (el) => { fpsOut.textContent = el.value; });
  persist(fitEl, 'gifFit');

  fps.addEventListener('input', () => {
    fpsOut.textContent = fps.value;
    if (previewImages && previewImages.length > 1) startPreview(false); // re-time, keep position
  });

  // Changing the fit re-frames the source, so re-decode at the current resolution.
  fitEl.addEventListener('change', () => { if (currentFile) decodeAndPreview(); });

  function loadGifFile(file) {
    if (!file) return;
    currentFile = file;
    nameEl.textContent = file.name;
    decodeAndPreview();
  }
  fileInput.addEventListener('change', (e) => loadGifFile(e.target.files[0]));

  // drag + drop (mirrors the Picture tab)
  const drop = $('#gifDrop');
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) loadGifFile(f); });

  // Recents "Load into tab": set the destination to match the cached area, then decode the source.
  tabLoaders.gif = (file, dest) => {
    const r = dest && document.querySelector(`input[name="gifDest"][value="${dest}"]`);
    if (r && !r.checked) r.checked = true;
    currentFile = file;
    nameEl.textContent = file.name;
    applyDest(); // re-notes + re-decodes at the (possibly new) destination resolution
  };

  const wrap = $('#gifProgressWrap');
  const bar = $('#gifProgress');
  $('#gifSend').addEventListener('click', async () => {
    if (!currentFile) { setStatus(statusEl, 'Pick a GIF first.', 'err'); return; }
    nowPlayingCtl.stop(); weatherCtl.stop(); // a manual push takes the screen from the live watchers
    const dest = readDest();
    const d = dims();
    let frames = currentFrames;
    if (!frames) {
      setStatus(statusEl, 'Decoding GIF…');
      try {
        frames = await gif.gifToFrames(currentFile, { maxFrames: d.max, width: d.w, height: d.h, fit: fitEl.value });
      } catch (err) {
        setStatus(statusEl, 'Decode failed: ' + ((err && err.message) || err), 'err');
        return;
      }
    }
    let packets;
    try {
      packets = dest === 'main' ? proto.buildMainPageGif(frames, +fps.value)
              : dest === 'startup' ? proto.buildStartupAnimation(frames, +fps.value)
              : proto.buildGifPage(frames, +fps.value);
    } catch (err) {
      setStatus(statusEl, 'Build failed: ' + ((err && err.message) || err), 'err');
      return;
    }
    const total = frames.frameCount ?? frames.length; // original count; frames.length is already capped
    const kept = frames.length;
    wrap.hidden = false;
    bar.style.width = '0%';
    // Wipe the previously-stored GIF FIRST so a new, shorter GIF can't leave stale frames tailing
    // (buildClearGif is only otherwise wired to the manual "Clear GIF" button). Best-effort: a clear
    // failure shouldn't block the upload, so its status is silenced and its result ignored.
    setStatus(statusEl, 'Clearing the old GIF…');
    await guardedSend('Clear GIF (pre-upload)', null, proto.buildClearGif(), { gap: 2 });
    setStatus(statusEl, `Sending ${packets.length} packets (${kept} frame${kept === 1 ? '' : 's'} @ ${fps.value} fps) — paced, takes a few seconds…`);
    try {
      const label = dest === 'main' ? 'GIF → main page' : dest === 'startup' ? 'GIF → startup animation' : 'GIF → gif page';
      const ok = await sendGifWithProgress(label, statusEl, packets, (f) => {
        bar.style.width = Math.round(f * 100) + '%';
      });
      if (ok) {
        const capNote = total > kept ? ` (kept the first ${kept} of ${total})` : '';
        if (dest === 'main') {
          setNowShowing('clock'); // main page = clock + your GIF
          setStatus(statusEl, `Saved GIF to the main page${capNote} — it should be playing now.`, 'ok');
        } else if (dest === 'startup') {
          setStatus(statusEl, `Saved startup animation${capNote} — it'll play next time the keyboard powers on.`, 'ok');
        } else {
          setStatus(statusEl, 'Switching to GIF page…');
          const shown = await guardedSend('View → GIF', statusEl, proto.buildView(proto.VIEW.GIF), { gap: 1 });
          if (shown) setNowShowing('gif');
          setStatus(statusEl, `Sent GIF to the gif page${capNote} (may not display on your firmware).`, 'ok');
        }
        // Remember what Studio just pushed (client-side slot cache).
        const area = dest === 'main' ? 'main' : dest === 'startup' ? 'startup' : 'gif';
        const thumbBlob = await thumbFromFrame(frames[0], d.w, d.h);
        await capturePush({
          area, name: currentFile.name || 'GIF', kind: 'gif',
          sourceBlob: currentFile, settings: { fit: fitEl.value, fps: +fps.value, dest },
          thumbBlob, frameCount: kept, fps: +fps.value,
        });
      }
    } finally {
      setTimeout(() => { wrap.hidden = true; }, 800);
    }
  });
}

// ---- slideshow --------------------------------------------------------------
// Uploads up to 16 stills to the device's picture slots (they accumulate), then
// host-drives an auto-cycle: a timer fires buildView(PICTURE) ("next picture") at
// the chosen interval. Clear the slots first so the slideshow is exactly the picks.
function setupSlideshowTab() {
  const MAX = 16;
  const statusEl = $('#slideStatus');
  const strip = $('#slideStrip');
  const counter = $('#slideCounter');
  const fileInput = $('#slideFile');
  const drop = $('#slideDrop');
  const readout = $('#slideCurrent');
  const brightnessOut = $('#slideBrightnessOut');
  const intervalEl = $('#slideInterval');
  const intervalOut = $('#slideIntervalOut');
  const playBtn = $('#slidePlay');
  const wrap = $('#slideProgressWrap');
  const bar = $('#slideProgress');
  const preview = $('#slidePreview');
  const previewEmpty = $('#slidePreviewEmpty');

  const controls = {
    fit: $('#slideFit'),
    brightness: $('#slideBrightness'),
    gray: $('#slideGray'),
  };

  // Remember slideshow editor settings across reloads (UI only; never auto-sends). The brightness +
  // interval sliders re-sync their <output> via onRestore so the readout matches the restored value.
  persist(controls.fit, 'slideFit');
  persist(controls.brightness, 'slideBrightness', (el) => { brightnessOut.textContent = el.value + '%'; });
  persist(controls.gray, 'slideGray');
  persist(intervalEl, 'slideInterval', (el) => { intervalOut.textContent = el.value + 's'; });

  let slides = [];       // [{ file, url }] — url is a 96x160 device-accurate thumbnail
  let cycleTimer = null; // setInterval handle; non-null == playing
  let currentIdx = 0;    // which slide the device is showing (readout only)
  let renderToken = 0;   // guards debounced thumbnail re-renders against races

  // Slideshow only uses fit / brightness / grayscale (percent -> factor for brightness).
  function readOpts() {
    return {
      fit: controls.fit.value,
      brightness: +controls.brightness.value / 100,
      grayscale: controls.gray.checked,
    };
  }

  const isPlaying = () => cycleTimer !== null;

  function updateCounter() { counter.textContent = `${slides.length}/${MAX}`; }
  // The preview mirrors the current slide — the same index the device is on while playing,
  // so Play steps them in lockstep. brightness/gray/fit already bake into slide.url.
  function updatePreview() {
    if (!slides.length) { preview.hidden = true; preview.removeAttribute('src'); previewEmpty.hidden = false; return; }
    previewEmpty.hidden = true;
    preview.src = slides[currentIdx % slides.length].url;
    preview.hidden = false;
  }
  function updateCurrent() {
    readout.textContent = slides.length
      ? `Slide ${(currentIdx % slides.length) + 1} of ${slides.length}`
      : 'No slides';
    updatePreview();
  }
  // Play runs the local preview even offline; the device send only happens when connected.
  function refreshPlay() { playBtn.disabled = sending || !slides.length; }

  function stopCycle() {
    if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
    playBtn.textContent = 'Play';
  }
  slideshowCtl.stop = stopCycle;

  // The device keeps cycling the pictures uploaded at the last Send; editing the strip
  // (remove/reorder) doesn't reach the device until the next Send. So pause the cycle on any
  // edit and tell the user to re-Send — otherwise the "Slide X of N" readout lies.
  function onStripEdit() {
    if (isPlaying()) { stopCycle(); setStatus(statusEl, 'Edited — press Send to apply the new order.'); }
  }

  function startCycle() {
    stopCycle();
    if (!slides.length) return;
    playBtn.textContent = 'Pause';
    const period = Math.max(1, +intervalEl.value || 1) * 1000;
    cycleTimer = setInterval(async () => {
      // Stop if the tab's hidden. Advance the preview regardless of connection;
      // only push to the device when connected (keeps the preview alive offline).
      if (!slideshowVisible()) { stopCycle(); return; }
      currentIdx = (currentIdx + 1) % slides.length;
      updateCurrent();
      if (connected) await guardedSend('Slideshow → next', statusEl, proto.buildView(proto.VIEW.PICTURE));
    }, period);
  }

  // Rebuild the whole strip from `slides`. Each thumb: image, index, remove (×),
  // and ◀/▶ reorder that swap with the neighbour.
  function renderStrip() {
    strip.innerHTML = '';
    slides.forEach((slide, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'slide-thumb';

      const img = document.createElement('img');
      img.src = slide.url;
      img.alt = `Slide ${i + 1}`;
      img.title = 'Preview this slide';
      img.style.cursor = 'pointer';
      // Click a thumb to jump the preview (and the play position) to it.
      img.addEventListener('click', () => { currentIdx = i; updateCurrent(); });
      thumb.appendChild(img);

      const idx = document.createElement('span');
      idx.className = 'slide-idx';
      idx.textContent = String(i + 1);
      thumb.appendChild(idx);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'slide-remove';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.setAttribute('aria-label', `Remove image ${i + 1}`); // accessible name — the "×" glyph isn't one
      rm.addEventListener('click', () => {
        onStripEdit();
        slides.splice(i, 1);
        if (i < currentIdx || currentIdx >= slides.length) currentIdx = Math.max(0, Math.min(currentIdx - (i < currentIdx ? 1 : 0), slides.length - 1));
        if (!slides.length) stopCycle();
        renderStrip();
      });
      thumb.appendChild(rm);

      const nav = document.createElement('div');
      nav.className = 'slide-reorder';
      const left = document.createElement('button');
      left.type = 'button';
      left.className = 'slide-move';
      left.textContent = '◀';
      left.title = 'Move left';
      left.disabled = i === 0;
      left.addEventListener('click', () => {
        if (i === 0) return;
        onStripEdit();
        [slides[i - 1], slides[i]] = [slides[i], slides[i - 1]];
        renderStrip();
      });
      const right = document.createElement('button');
      right.type = 'button';
      right.className = 'slide-move';
      right.textContent = '▶';
      right.title = 'Move right';
      right.disabled = i === slides.length - 1;
      right.addEventListener('click', () => {
        if (i === slides.length - 1) return;
        onStripEdit();
        [slides[i + 1], slides[i]] = [slides[i], slides[i + 1]];
        renderStrip();
      });
      nav.append(left, right);
      thumb.appendChild(nav);

      strip.appendChild(thumb);
    });
    updateCounter();
    updateCurrent();
    refreshPlay();
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    if (!files.length) { setStatus(statusEl, 'No image files found — pick PNG/JPG/GIF images.', 'err'); return; }
    const opts = readOpts();
    let added = 0;
    let skipped = 0;
    for (const file of files) {
      if (slides.length >= MAX) { skipped++; continue; }
      try {
        const url = await image.previewDataURL(file, opts);
        slides.push({ file, url });
        added++;
      } catch (err) {
        setStatus(statusEl, 'Could not read ' + file.name + ': ' + ((err && err.message) || err), 'err');
      }
    }
    renderStrip();
    if (skipped > 0) setStatus(statusEl, `Added ${added}. Slot limit is ${MAX}; skipped ${skipped}.`, 'err');
    else if (added) setStatus(statusEl, `Added ${added} slide${added === 1 ? '' : 's'}.`);
  }

  // Re-render every thumbnail when the global opts change (debounced).
  let rerenderTimer = null;
  async function rerenderThumbs() {
    const token = ++renderToken;
    const opts = readOpts();
    for (const slide of slides) {
      try {
        const url = await image.previewDataURL(slide.file, opts);
        if (token !== renderToken) return; // superseded
        slide.url = url;
      } catch { /* keep the old thumbnail */ }
    }
    if (token !== renderToken) return;
    renderStrip();
  }
  function scheduleRerender() {
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(rerenderThumbs, 150);
  }

  controls.fit.addEventListener('change', scheduleRerender);
  controls.gray.addEventListener('change', scheduleRerender);
  controls.brightness.addEventListener('input', () => {
    brightnessOut.textContent = controls.brightness.value + '%';
    scheduleRerender();
  });
  intervalEl.addEventListener('input', () => {
    intervalOut.textContent = intervalEl.value + 's';
    if (isPlaying()) startCycle(); // re-time in place
  });

  fileInput.addEventListener('change', (e) => { addFiles(e.target.files); fileInput.value = ''; });

  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  // Send slideshow: clear slots -> upload each still with ACK flow control -> show picture 1 -> start the auto-cycle. Guarded against re-entry so a
  // second Send (or Play mid-upload) can't interleave writes to the write-only device.
  const sendBtn = $('#slideSend');
  const nextBtn = $('#slideNext');
  let sending = false;
  const setBusy = (busy) => {
    sending = busy;
    sendBtn.disabled = nextBtn.disabled = busy || !connected;
    refreshPlay();
  };
  sendBtn.addEventListener('click', async () => {
    if (sending) return;
    if (!slides.length) { setStatus(statusEl, 'Add at least one image first.', 'err'); return; }
    nowPlayingCtl.stop(); weatherCtl.stop(); // the slideshow takes the screen from the live watchers
    if (!connected) { setStatus(statusEl, 'Connect first.', 'err'); return; }
    stopCycle();
    setBusy(true);
    wrap.hidden = false;
    bar.style.width = '0%';
    const opts = readOpts();
    const n = slides.length;
    try {
      setStatus(statusEl, 'Clearing picture slots…');
      if (!(await guardedSend('Clear pictures', statusEl, proto.buildClearPicture(), { gap: 2 }))) return;
      for (let i = 0; i < n; i++) {
        setStatus(statusEl, `Uploading slide ${i + 1} of ${n}…`);
        let frame;
        try { frame = await image.imageToFrame(slides[i].file, opts); }
        catch (err) { setStatus(statusEl, `Render failed on slide ${i + 1}: ` + ((err && err.message) || err), 'err'); return; }
        let packets;
        try { packets = proto.buildImageTransfer(frame); }
        catch (err) { setStatus(statusEl, `Build failed on slide ${i + 1}: ` + ((err && err.message) || err), 'err'); return; }
        // Accumulate progress across all slides: slide i contributes [i/n, (i+1)/n).
        const ok = await sendAckGatedWithProgress(`Slideshow slide ${i + 1}/${n}`, statusEl, packets, (f) => {
          bar.style.width = Math.round(((i + f) / n) * 100) + '%';
        }, { gap: 0 });
        if (!ok) return;
        if (i < n - 1) await sleep(200); // let the device commit each picture
      }
      setStatus(statusEl, 'Showing slideshow…');
      currentIdx = 0;
      updateCurrent();
      if (!await guardedSend('Slideshow → show', statusEl, proto.buildView(proto.VIEW.PICTURE), { gap: 1 })) return;
      setNowShowing('picture');
      setBusy(false); // re-enable before starting the cycle
      startCycle();
      setStatus(statusEl, `Slideshow running — ${n} slide${n === 1 ? '' : 's'}, ${intervalEl.value}s each.`, 'ok');
      // Remember what Studio just pushed (client-side slot cache). Keeps the whole file list so
      // Re-push can replay the ring; the thumbnail is slide 1.
      const thumbBlob = await slots.thumbFromSource(slides[0].url).catch(() => null);
      await capturePush({
        area: 'picture', name: `Slideshow · ${n} slide${n === 1 ? '' : 's'}`, kind: 'slideshow',
        sources: slides.map((s) => s.file), settings: { ...opts, interval: +intervalEl.value },
        thumbBlob, frameCount: n,
      });
    } finally {
      setBusy(false);
      setTimeout(() => { wrap.hidden = true; }, 800);
    }
  });

  playBtn.addEventListener('click', () => {
    if (isPlaying()) {
      stopCycle();
      setStatus(statusEl, 'Paused.');
    } else {
      if (!slides.length) { setStatus(statusEl, 'Add slides first.', 'err'); return; }
      startCycle();
      setStatus(statusEl, connected ? 'Playing.' : 'Previewing — connect to drive the LCD.', 'ok');
    }
  });

  $('#slideNext').addEventListener('click', async () => {
    if (!slides.length) return;
    nowPlayingCtl.stop(); weatherCtl.stop(); // stepping the slideshow takes the screen from the live watchers
    currentIdx = (currentIdx + 1) % slides.length;
    updateCurrent();
    await guardedSend('Slideshow → next', statusEl, proto.buildView(proto.VIEW.PICTURE), { gap: 1 });
  });

  // initial read-outs
  brightnessOut.textContent = controls.brightness.value + '%';
  intervalOut.textContent = intervalEl.value + 's';
  updateCounter();
  updateCurrent();
  refreshPlay();
}

// ---- now playing (Spotify -> live card on the LCD, over WebHID) --------------
// Ports host/nowplaying-run.mjs into the app: PKCE auth in the browser, a 5s poll of Spotify's
// currently-playing, and — when the track or play/pause changes — render the 96x160 card
// (nowplaying/card.js) and push it via the same ACK-gated picture path the Picture tab uses.
// The proven display path is buildImageTransfer() ALONE: its PK_ADD_PIC setup commits AND shows the
// frame. We do NOT send buildView(PICTURE) after — that's PK_TOGGLE_PIC, which advances to the next
// slot and flips past the card (host/device.js sendFrame learned this on-device).
function setupNowPlayingTab() {
  const POLL_MS = 5000;
  const PROGRESS_REFRESH_MS = 15000; // re-push while playing to advance the progress bar, even mid-track
  const PAUSE_HOME_MS = 5 * 60 * 1000; // after this long paused, fall back to the home page

  const connectBtn = $('#npConnectSpotify');
  const forgetBtn = $('#npForgetSpotify');
  const authStatus = $('#npAuthStatus');
  const redirectEl = $('#npRedirectUri');
  const statusEl = $('#npStatus');
  const artThumb = $('#npArtThumb');
  const titleEl = $('#npTrackTitle');
  const artistEl = $('#npTrackArtist');
  const progWrap = $('#npProgressWrap');
  const progBar = $('#npProgress');
  if (!connectBtn) return;

  const REDIRECT_URI = spotify.redirectUri();
  redirectEl.textContent = REDIRECT_URI;
  // Log it so the user can copy the EXACT string to register in the Spotify dashboard.
  console.log('[nowplaying] Spotify redirect URI to register:', REDIRECT_URI);

  const spotifyConnected = () => !!spotify.loadRefreshToken();

  // ---- access-token cache (refresh only near expiry / on 401; PKCE rotates the refresh token) ----
  let tokenState = { accessToken: null, expiresAt: 0 };
  async function accessToken() {
    if (!spotify.needsRefresh(tokenState, Date.now())) return tokenState.accessToken;
    const refreshToken = spotify.loadRefreshToken();
    if (!refreshToken) throw new Error('Not connected to Spotify — click Connect Spotify.');
    const t = await spotify.refreshAccessToken({ clientId: spotify.CLIENT_ID, refreshToken });
    tokenState = { accessToken: t.accessToken, expiresAt: Date.now() + (t.expiresInSec || 3600) * 1000 };
    if (t.refreshToken && t.refreshToken !== refreshToken) spotify.saveRefreshToken(t.refreshToken); // persist rotation
    return tokenState.accessToken;
  }

  async function currentTrack() {
    let tok = await accessToken();
    try { return await spotify.getNowPlaying(tok); }
    catch (e) {
      if (e && e.status === 401) { // expired mid-cache — force one refresh + retry
        tokenState = { accessToken: null, expiresAt: 0 };
        tok = await accessToken();
        return await spotify.getNowPlaying(tok);
      }
      throw e;
    }
  }

  // ---- track readout (title / artist / art thumbnail) ----
  function showTrack(np) {
    if (np && np.title) {
      titleEl.textContent = np.title;
      artistEl.textContent = (np.isPlaying ? '' : '(paused) ') + (np.artist || '');
      if (np.artUrl && artThumb.src !== np.artUrl) artThumb.src = np.artUrl; // display-only, no CORS needed
      artThumb.hidden = !np.artUrl;
    } else {
      titleEl.textContent = '—';
      artistEl.textContent = 'Nothing playing';
      artThumb.removeAttribute('src');
      artThumb.hidden = true;
    }
  }

  // ---- auth ----
  function reflectAuth() {
    const authed = spotifyConnected();
    connectBtn.textContent = authed ? 'Reconnect Spotify' : 'Connect Spotify';
    forgetBtn.hidden = !authed;
    if (authed && authStatus.dataset.state !== 'busy') setStatus(authStatus, 'Connected to Spotify.', 'ok');
    else if (!authed) setStatus(authStatus, 'Not connected to Spotify.');
    syncNP();
  }

  async function beginAuth() {
    try {
      const verifier = spotify.generateCodeVerifier();
      const challenge = await spotify.codeChallenge(verifier);
      const state = spotify.generateCodeVerifier().slice(0, 16);
      spotify.savePendingAuth(verifier, state);
      const url = spotify.buildAuthUrl({
        clientId: spotify.CLIENT_ID, redirectUri: REDIRECT_URI, codeChallenge: challenge, state,
      });
      setStatus(authStatus, 'Redirecting to Spotify…');
      window.location.assign(url); // full-page redirect; we come back to ?code=...
    } catch (e) {
      setStatus(authStatus, 'Auth failed: ' + ((e && e.message) || e), 'err');
    }
  }

  // Complete the redirect: if we came back with ?code=, exchange it for tokens. Verifies state,
  // persists the refresh token, and scrubs the code from the URL so a reload can't replay it.
  async function completeAuthFromRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const err = params.get('error');
    if (!code && !err) return;
    const { verifier, state: savedState } = spotify.loadPendingAuth();
    const returnedState = params.get('state');
    // scrub the query either way so we don't loop on reload
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
    if (err) { setStatus(authStatus, 'Spotify denied access: ' + err, 'err'); spotify.clearPendingAuth(); return; }
    if (!verifier || (savedState && returnedState && savedState !== returnedState)) {
      setStatus(authStatus, 'Auth state mismatch — try Connect Spotify again.', 'err');
      spotify.clearPendingAuth();
      return;
    }
    authStatus.dataset.state = 'busy';
    setStatus(authStatus, 'Finishing Spotify sign-in…');
    try {
      const tok = await spotify.exchangeCodeForToken({
        clientId: spotify.CLIENT_ID, code, redirectUri: REDIRECT_URI, codeVerifier: verifier,
      });
      spotify.saveRefreshToken(tok.refreshToken);
      if (tok.accessToken) tokenState = { accessToken: tok.accessToken, expiresAt: Date.now() + (tok.expiresInSec || 3600) * 1000 };
    } catch (e) {
      setStatus(authStatus, 'Token exchange failed: ' + ((e && e.message) || e), 'err');
    } finally {
      delete authStatus.dataset.state;
      spotify.clearPendingAuth();
      reflectAuth();
    }
  }

  connectBtn.addEventListener('click', beginAuth);
  forgetBtn.addEventListener('click', () => {
    stopNP();
    spotify.clearRefreshToken();
    tokenState = { accessToken: null, expiresAt: 0 };
    reflectAuth();
    setStatus(statusEl, '');
  });

  // ---- live push loop (setTimeout chain + generation token, like the lighting FX) ----
  let npToken = 0, npTimer = null, npRunning = false, sending = false;
  let lastKey = null, lastSentAt = 0, pausedSince = null;
  const artCache = new Map(); // trackId -> Uint8Array|null (null = art failed/tainted, use placeholder)
  const ART_CACHE_MAX = 50;   // bound memory over a long session — drop the oldest past this
  const cacheArt = (id, v) => { artCache.set(id, v); if (artCache.size > ART_CACHE_MAX) artCache.delete(artCache.keys().next().value); };

  // Fall back to the home/clock page (nothing playing, or paused a long while). The loop keeps
  // polling; the next track switches straight back to the now-playing card.
  async function fallBackHome(msg) {
    setStatus(statusEl, msg);
    slotsLive(false);                              // release the live picture slot back to its cached thumb
    await guardedSend('View → Clock', statusEl, proto.buildView(proto.VIEW.HOMEPAGE), { gap: 1 });
    setNowShowing('clock');
    lastKey = 'idle';
  }

  function stopNP() {
    npRunning = false;
    npToken++;                                     // invalidate any in-flight loop iteration
    if (npTimer) { clearTimeout(npTimer); npTimer = null; }
    slotsLive(false);                              // hand the picture/main slot back to its cached thumb
  }
  nowPlayingCtl.stop = stopNP;

  // No Start/Stop button: now-playing arms itself whenever this tab is open with the keyboard +
  // Spotify connected, and stops when you leave the tab or disconnect. It still owns the single HID
  // connection while live, so leaving the tab is what yields the device to the other editors.
  // syncNP runs on every connection/auth change; the tab switch calls nowPlayingCtl.start on open.
  function syncNP() {
    if (nowPlayingVisible() && connected && spotifyConnected()) startNP();
    else if (!npRunning && !connected) setStatus(statusEl, 'Connect the keyboard to show now-playing.');
    else if (!npRunning && !spotifyConnected()) setStatus(statusEl, 'Connect Spotify to show now-playing.');
  }
  nowPlayingCtl.sync = syncNP;
  nowPlayingCtl.start = startNP;

  async function pushTrack(np) {
    if (sending) return;
    sending = true;
    progWrap.hidden = false;
    progBar.style.width = '0%';
    try {
      if (!artCache.has(np.trackId)) cacheArt(np.trackId, await loadArtRGB(np.artUrl));
      const artRGB = artCache.get(np.trackId);
      const frame = renderNowPlayingCard({
        title: np.title, artist: np.artist, artRGB,
        progress: np.progress, paused: !np.isPlaying,
        elapsedMs: np.elapsedMs, durationMs: np.durationMs,
      });
      let packets;
      try { packets = proto.buildImageTransfer(frame); }
      catch (e) { setStatus(statusEl, 'Build failed: ' + ((e && e.message) || e), 'err'); return false; }
      const onProg = (f) => { progBar.style.width = Math.round(f * 100) + '%'; };
      const ok = await sendAckGatedWithProgress('Now Playing → card', statusEl, packets, onProg);
      if (!ok) return false;
      setNowShowing('picture'); // the card lives on the picture page
      setStatus(statusEl, `${np.isPlaying ? '▶' : '⏸'} ${np.title} — ${np.artist}`, 'ok');
      return true;
    } finally {
      sending = false;
      setTimeout(() => { progWrap.hidden = true; }, 600);
    }
  }

  async function tick(token) {
    if (token !== npToken || !npRunning) return;
    // The whole body is wrapped so a throw ANYWHERE (a failed art fetch, a build error, a mid-cache
    // 401) can never skip the re-arm below. The old loop awaited pushTrack() unguarded, so one bad
    // push killed the poll — the card would show the FIRST song and never update again. Now the next
    // poll is scheduled in `finally`, and lastKey only advances after a push actually succeeds.
    try {
      let np = null;
      try {
        np = await currentTrack();
      } catch (e) {
        const msg = (e && e.message) || String(e);
        console.warn('[nowplaying] poll — Spotify error:', msg);
        setStatus(statusEl, 'Spotify error: ' + msg, 'err');
        if (/Not connected to Spotify/i.test(msg)) { stopNP(); return; } // refresh token gone/revoked
      }
      if (token !== npToken || !npRunning) return;

      if (np && np.title) {
        showTrack(np);
        slotsLive(true, np); // keep the device-bar live readout in step with the track
        pausedSince = np.isPlaying ? null : (pausedSince ?? Date.now());
        const restedPaused = !np.isPlaying && Date.now() - pausedSince >= PAUSE_HOME_MS;
        const key = `${np.trackId}|${np.isPlaying ? 'r' : 'p'}`;
        const trackChanged = key !== lastKey;
        const progressDue = np.isPlaying && Date.now() - lastSentAt >= PROGRESS_REFRESH_MS;
        const willPush = !restedPaused && (trackChanged || progressDue) && !sending;
        console.log('[nowplaying] poll', np.trackId, np.isPlaying ? 'playing' : 'paused',
          willPush ? (trackChanged ? 'PUSH (changed)' : 'PUSH (progress)') : (restedPaused ? 'rested' : sending ? 'busy' : 'unchanged'));
        if (restedPaused && lastKey !== 'idle') {
          await fallBackHome('Paused a while — showing clock.'); // rest the screen instead of a frozen card
        } else if (willPush) {
          try {
            if (await pushTrack(np)) {
              lastKey = key;          // advance the change-key ONLY after a successful render+push
              lastSentAt = Date.now();
            }
          } catch (e) {
            // A push failure (art load / build / send) must not kill the loop or advance lastKey —
            // leave it stale so the very next poll retries this exact track.
            console.warn('[nowplaying] push failed, retrying next poll:', (e && e.message) || e);
            setStatus(statusEl, 'Push failed: ' + ((e && e.message) || e), 'err');
          }
        }
      } else {
        showTrack(null);
        if (lastKey !== 'idle') await fallBackHome('Nothing playing — showing clock.');
      }
    } finally {
      // Always re-arm while running — this is the fix for "only the first song updates".
      if (token === npToken && npRunning) npTimer = setTimeout(() => tick(token), POLL_MS);
    }
  }

  function startNP() {
    if (npRunning || !connected || !spotifyConnected()) return; // self-arming: no-op unless ready
    weatherCtl.stop?.();                           // one screen, one owner — now-playing takes over from weather
    stopClockSync();                               // clock-sync flips the view home every 60s — can't co-own the screen
    npRunning = true;
    const token = ++npToken;
    lastKey = null; lastSentAt = 0; pausedSince = null;
    slotsLive(true, null); // claim the picture/main slot as live immediately (track fills in on first poll)
    setStatus(statusEl, 'Watching Spotify — play something.', 'ok');
    tick(token);
  }

  // On load: finish an in-flight redirect (if any), then reflect state.
  completeAuthFromRedirect().finally(reflectAuth);
  reflectAuth();
}

// The weather tab — the second ambient-display feature, built to the same shape as now-playing.
// Self-arming: it polls Open-Meteo (no API key) every 10 min while this tab is open, renders the
// 96x160 card (weather/card.js), draws it into the in-tab preview canvas EVERY refresh (so you see
// it even without a keyboard connected), and — when connected — pushes it to the LCD via the same
// ACK-gated picture path now-playing uses. No Start/Stop button. "Set location" geocodes a place
// name to lat/lon and persists it. Weather and now-playing are mutually exclusive owners of the
// single screen: startWx stops now-playing, and now-playing's startNP stops weather.
function setupWeatherTab() {
  const WX_POLL_MS = 10 * 60 * 1000; // weather is slow (Open-Meteo updates ~every 15 min); poll every 10 min

  const placeInput = $('#wxPlace');
  const setBtn = $('#wxSetLocation');
  const resolvedEl = $('#wxResolved');
  const unitsCb = $('#wxUnits');
  const canvas = $('#wxPreview');
  const statusEl = $('#wxStatus');
  if (!setBtn || !canvas) return;

  const ctx = canvas.getContext('2d');

  // Current location record (lat/lon/label/units), persisted in localStorage; defaults to Detroit.
  let loc = weather.loadLocation();
  unitsCb.checked = loc.units === 'C';
  resolvedEl.textContent = `Showing ${loc.label}.`;
  placeInput.value = ''; // the box is for entering a NEW place; the resolved line shows the current one

  const activeTemp = (s) => (s.units === 'C' ? s.tempC : s.tempF);
  // The device-bar live readout for a weather state: "72° PARTLY CLOUDY" over the location. Reuses
  // slotsLive's {title, artist} shape so the bar/cards render it the same way they do a track.
  const weatherBarInfo = (s) => ({ title: `${activeTemp(s)}° ${s.condition}`, artist: s.label });

  // Decode a 96x160 RGB565-BE frame (the exact bytes buildImageTransfer sends) into the preview
  // canvas. The CSS upscales it nearest-neighbor so the pixel icons + 5x7 font stay crisp.
  function drawPreview(frame) {
    const img = ctx.createImageData(proto.WIDTH, proto.HEIGHT);
    for (let i = 0, p = 0; i < frame.length; i += 2, p += 4) {
      const v = (frame[i] << 8) | frame[i + 1];
      img.data[p] = ((v >> 11) & 0x1f) << 3;      // R5 -> R8
      img.data[p + 1] = ((v >> 5) & 0x3f) << 2;   // G6 -> G8
      img.data[p + 2] = (v & 0x1f) << 3;          // B5 -> B8
      img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  // Render a state into the preview and, when a keyboard is connected, push it to the LCD. lastPushKey
  // suppresses redundant device pushes — the picture ring isn't churned unless the reading changed.
  let lastPushKey = null;
  async function renderAndMaybePush(state) {
    const frame = renderWeatherCard(state);
    drawPreview(frame);                               // preview always updates, connected or not
    if (!connected) { setStatus(statusEl, 'Preview only — connect the keyboard to push to the LCD.'); return; }
    slotsLive(true, weatherBarInfo(state), 'weather'); // keep the device-bar readout in step with the reading
    const key = `${state.units}|${state.tempF}|${state.code}|${state.hiF}|${state.loF}|${state.label}`;
    if (key === lastPushKey) return;                 // unchanged reading — don't re-push
    let packets;
    try { packets = proto.buildImageTransfer(frame); }
    catch (e) { setStatus(statusEl, 'Build failed: ' + ((e && e.message) || e), 'err'); return; }
    const ok = await sendAckGatedWithProgress('Weather → card', statusEl, packets, () => {});
    if (ok) {
      lastPushKey = key;
      setNowShowing('picture');                      // the card lives on the picture page
      setStatus(statusEl, `${state.label} · ${activeTemp(state)}° ${state.condition}`, 'ok');
    }
  }

  // ---- self-arming poll loop (setTimeout chain + generation token, like now-playing / lighting FX) ----
  let wxToken = 0, wxTimer = null, wxRunning = false;

  function stopWx() {
    wxRunning = false;
    wxToken++;                                        // invalidate any in-flight loop iteration
    if (wxTimer) { clearTimeout(wxTimer); wxTimer = null; }
    slotsLive(false);                                 // hand the picture slot back to its cached thumb
  }
  weatherCtl.stop = stopWx;

  async function tick(token) {
    if (token !== wxToken || !wxRunning) return;
    try {
      let state;
      try {
        state = await weather.getWeather(loc);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        console.warn('[weather] poll — fetch error:', msg);
        setStatus(statusEl, 'Weather fetch failed: ' + msg, 'err');
        state = weather.getWeatherMock({ label: loc.label, units: loc.units }); // show something, not a blank card
      }
      if (token !== wxToken || !wxRunning) return;
      await renderAndMaybePush(state);
    } finally {
      // Always re-arm while running (same fix now-playing uses so one bad fetch can't kill the loop).
      if (token === wxToken && wxRunning) wxTimer = setTimeout(() => tick(token), WX_POLL_MS);
    }
  }

  function startWx() {
    nowPlayingCtl.stop?.();                           // one screen, one owner — weather takes over from now-playing
    if (wxRunning) return;                            // self-arming: already running is a no-op
    stopClockSync();                                  // clock-sync flips the view home every 60s — can't co-own the screen
    wxRunning = true;
    lastPushKey = null;
    const token = ++wxToken;
    const seed = weather.getWeatherMock({ label: loc.label, units: loc.units });
    if (connected) slotsLive(true, weatherBarInfo(seed), 'weather'); // claim the picture slot as live (weather owner)
    // Immediate preview so the tab is never blank, even before the first fetch returns.
    drawPreview(renderWeatherCard(seed));
    setStatus(statusEl, connected ? 'Fetching weather…' : 'Preview only — connect the keyboard to push to the LCD.');
    tick(token);
  }
  weatherCtl.start = startWx;

  // Runs on every connection change (from reflectConnection). While the tab is open, restart so a
  // fresh connect pushes right away and a disconnect drops back to preview-only — without waiting out
  // the 10-min poll gap.
  function syncWx() {
    if (!weatherVisible()) return;
    stopWx();
    startWx();
  }
  weatherCtl.sync = syncWx;

  // Immediate refresh outside the poll cadence (after Set location / units change). If the tab is open
  // it's self-armed, so restart to re-fetch now; otherwise just refresh the preview for the next open.
  function refreshNow() {
    if (weatherVisible()) { stopWx(); startWx(); }
    else {
      const sample = weather.getWeatherMock({ label: loc.label, units: loc.units });
      drawPreview(renderWeatherCard(sample));
    }
  }

  // ---- location control: geocode a typed place name -> lat/lon/label, persist, refresh ----
  async function applyPlace() {
    const q = placeInput.value.trim();
    if (!q) { setStatus(statusEl, 'Type a place name first.', 'err'); return; }
    setBtn.disabled = true;
    setStatus(statusEl, `Looking up “${q}”…`);
    try {
      const hit = await weather.geocode(q);
      loc = weather.saveLocation({ lat: hit.lat, lon: hit.lon, label: hit.label, units: loc.units });
      resolvedEl.textContent = `Showing ${hit.label}${hit.detail ? ', ' + hit.detail : ''}.`; // card shows the city; Studio shows the fuller place
      placeInput.value = '';
      lastPushKey = null;                             // force a push for the new place
      setStatus(statusEl, `Location set to ${loc.label}.`, 'ok');
      refreshNow();
    } catch (e) {
      setStatus(statusEl, (e && e.message) || String(e), 'err');
    } finally {
      setBtn.disabled = false;
    }
  }
  setBtn.addEventListener('click', applyPlace);
  placeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyPlace(); } });

  unitsCb.addEventListener('change', () => {
    loc = weather.saveLocation({ units: unitsCb.checked ? 'C' : 'F' });
    lastPushKey = null;                               // unit changed — force a re-push
    refreshNow();
  });

  // Draw an initial preview at setup so the canvas shows a card the instant the tab is first opened.
  const initialWx = weather.getWeatherMock({ label: loc.label, units: loc.units });
  drawPreview(renderWeatherCard(initialWx));
}

// ---- slot cache + recents (client-side memory of what Studio pushed) ---------
// Honest by construction: the LCD is write-only, so these surfaces say "last pushed from Studio",
// never "on the device now". Cards + the device-bar overview + a recents gallery all read the same
// IndexedDB store (src/slots.js); Re-push re-derives frames from the cached source + settings.

const AREA_LABEL = { main: 'Main page', picture: 'Picture page', gif: 'GIF page', startup: 'Startup' };
const AREA_LABEL_SHORT = { main: 'Main', picture: 'Picture', gif: 'GIF', startup: 'Startup' };
const AREA_TAB = { main: 'picture', picture: 'picture', gif: 'gif', startup: 'gif' };
const KIND_TAB = { image: 'picture', gif: 'gif', slideshow: 'slideshow' };
const KIND_FILE = { image: '#imageFile', gif: '#gifFile', slideshow: '#slideFile' };
// Which area cards render in which tab. 'main' appears in both editors that write it — each mirrors
// the same slot record, which is fine (one source of truth in IDB).
const CARD_CONTAINERS = [
  { id: 'cardsPicture', areas: ['main', 'picture'] },
  { id: 'cardsGif', areas: ['main', 'gif', 'startup'] },
  { id: 'cardsSlideshow', areas: ['picture'] },
];

// Now Playing pushes via the picture-page path (buildImageTransfer), so it owns the 'picture' area
// while live. The device-bar's global live readout covers the "main" reading of it.
const isLiveArea = (area) => npLive && area === 'picture';

// ---- tiny DOM + time helpers ----
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function mkBtn(label, cls, onClick) {
  const b = el('button', 'btn ' + (cls || ''), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
function asFile(blob, name) {
  if (!blob) return null;
  if (typeof File !== 'undefined' && blob instanceof File) return blob;
  try { return new File([blob], name || 'file', { type: blob.type || 'application/octet-stream' }); }
  catch { return blob; }
}
function goToTab(name) {
  const sec = document.querySelector('.section-btn[data-section="lcd"]');
  if (sec) sec.click();
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

// Object-URL bookkeeping so thumbnails don't leak. Full re-render revokes the previous batch.
const objectURLs = new Set();
function objURL(blob) { const u = URL.createObjectURL(blob); objectURLs.add(u); return u; }
function revokeObjURLs() { for (const u of objectURLs) URL.revokeObjectURL(u); objectURLs.clear(); }

// GIF cards animate the ORIGINAL source on hover (the thumb is a static frame-0 PNG).
function wireGifHover(img, rec) {
  let hoverURL = null;
  img.addEventListener('mouseenter', () => {
    if (hoverURL || !rec.sourceBlob) return;
    hoverURL = URL.createObjectURL(rec.sourceBlob);
    img.dataset.staticSrc = img.src;
    img.src = hoverURL;
  });
  img.addEventListener('mouseleave', () => {
    if (hoverURL) { URL.revokeObjectURL(hoverURL); hoverURL = null; }
    if (img.dataset.staticSrc) img.src = img.dataset.staticSrc;
  });
}

// ---- capture (called from each Send handler after a successful push) ----
async function thumbFromFrame(frame, w, h) {
  try { return await slots.thumbFromImageData(new ImageData(image.frameToRGBA(frame), w, h)); }
  catch (e) { console.warn('[slots] thumb failed:', e); return null; }
}
async function capturePush({ area, name, kind, sourceBlob = null, sources = null, settings = {}, thumbBlob = null, frameCount = 1, fps = 0, pushedAt = Date.now() }) {
  try {
    const payload = { area, name, kind, sourceBlob, sources, settings, thumbBlob, frameCount, fps, pushedAt };
    await slots.saveSlot(area, payload);
    await slots.addRecent(payload);
    refreshSlotsUI();
  } catch (e) { console.warn('[slots] capture failed:', e); }
}

// ---- re-push (re-derive frames from cached source + settings, same pipeline as Send) ----
async function rePushSlot(slot, { onStatus = () => {}, onProgress = () => {} } = {}) {
  if (!connected) throw new Error('Connect the keyboard first.');
  if (slot.kind === 'slideshow') return rePushSlideshow(slot, { onStatus, onProgress });
  if (!slot.sourceBlob) throw new Error('Source not cached — use Replace to pick the file again.');
  const s = slot.settings || {};
  const area = slot.area;
  const src = slot.sourceBlob;

  if (slot.kind === 'gif') {
    const d = area === 'main' ? { w: proto.MP_W, h: proto.MP_H, max: proto.MP_MAX_FRAMES }
      : area === 'startup' ? { w: proto.SA_W, h: proto.SA_H, max: proto.SA_MAX_FRAMES }
      : { w: proto.GP_W, h: proto.GP_H, max: proto.GP_MAX_FRAMES };
    onStatus('Decoding GIF…');
    const frames = await gif.gifToFrames(src, { maxFrames: d.max, width: d.w, height: d.h, fit: s.fit || 'cover' });
    const fps = s.fps || slot.fps || 30;
    const packets = area === 'main' ? proto.buildMainPageGif(frames, fps)
      : area === 'startup' ? proto.buildStartupAnimation(frames, fps)
      : proto.buildGifPage(frames, fps);
    onStatus('Clearing the old GIF…');
    await guardedSend('Clear GIF (pre-upload)', null, proto.buildClearGif(), { gap: 2 });
    onStatus('Sending…');
    const ok = await sendGifWithProgress('Re-push GIF → ' + area, null, packets, onProgress);
    if (!ok) throw new Error('Send failed.');
    if (area === 'main') setNowShowing('clock');
    else if (area === 'gif') { await guardedSend('View → GIF', null, proto.buildView(proto.VIEW.GIF), { gap: 1 }); setNowShowing('gif'); }
    return;
  }

  // still image
  if (area === 'main') {
    onStatus('Rendering…');
    const frame = await image.imageToMainPageFrame(src, s);
    const packets = proto.buildMainPageImage(frame);
    onStatus('Clearing the old GIF…');
    await guardedSend('Clear GIF (pre-upload)', null, proto.buildClearGif(), { gap: 2 });
    onStatus('Sending…');
    const ok = await sendGifWithProgress('Re-push Picture → main page', null, packets, onProgress);
    if (!ok) throw new Error('Send failed.');
    setNowShowing('clock');
  } else {
    onStatus('Rendering…');
    const frame = await image.imageToFrame(src, s);
    const packets = proto.buildImageTransfer(frame);
    onStatus('Sending…');
    const ok = await sendAckGatedWithProgress('Re-push Picture → picture page', null, packets, onProgress);
    if (!ok) throw new Error('Send failed.');
    await guardedSend('View → Picture', null, proto.buildView(proto.VIEW.PICTURE), { gap: 1 });
    setNowShowing('picture');
  }
}

async function rePushSlideshow(slot, { onStatus = () => {}, onProgress = () => {} } = {}) {
  const files = slot.sources;
  if (!Array.isArray(files) || !files.length) throw new Error('Slides not cached — re-add them in the Slideshow tab.');
  const s = slot.settings || {};
  onStatus('Clearing picture slots…');
  if (!(await guardedSend('Clear pictures', null, proto.buildClearPicture(), { gap: 2 }))) throw new Error('Clear failed.');
  const n = files.length;
  for (let i = 0; i < n; i++) {
    onStatus(`Uploading slide ${i + 1} of ${n}…`);
    const frame = await image.imageToFrame(files[i], s);
    const packets = proto.buildImageTransfer(frame);
    const ok = await sendAckGatedWithProgress(`Re-push slide ${i + 1}/${n}`, null, packets, (f) => onProgress((i + f) / n));
    if (!ok) throw new Error('Send failed on slide ' + (i + 1));
    if (i < n - 1) await sleep(200);
  }
  if (!await guardedSend('Slideshow → show', null, proto.buildView(proto.VIEW.PICTURE), { gap: 1 })) throw new Error('Could not switch to the slideshow.');
  setNowShowing('picture');
  // Note: re-push uploads the ring + shows slide 1, but the auto-cycle lives in the Slideshow tab —
  // open it and press Play to cycle.
}

// ---- card actions ----
async function doRePush(rec, statusEl) {
  if (!connected) { setStatus(statusEl, 'Connect the keyboard first.', 'err'); return; }
  setStatus(statusEl, 'Re-pushing…');
  try {
    await rePushSlot(rec, { onStatus: (m) => setStatus(statusEl, m) });
    setStatus(statusEl, 'Re-pushed.', 'ok');
    // Bump the slot's timestamp so the card reads fresh.
    if (rec.area) await slots.saveSlot(rec.area, { ...rec, pushedAt: Date.now() });
    refreshSlotsUI();
  } catch (e) { setStatus(statusEl, 'Re-push failed: ' + ((e && e.message) || e), 'err'); }
}
function doReplace(rec) {
  const tab = KIND_TAB[rec.kind] || 'picture';
  goToTab(tab);
  const input = document.querySelector(KIND_FILE[rec.kind] || '#imageFile');
  if (input) input.click();
}
async function doClear(area) {
  await slots.clearSlot(area);
  if (connected && confirm(`Cleared Studio's record of the ${AREA_LABEL[area]}. Also erase this area on the keyboard now?`)) {
    const packets = area === 'picture' ? proto.buildClearPicture() : proto.buildClearGif();
    await guardedSend('Clear ' + AREA_LABEL[area], null, packets, { gap: 2 });
  }
  refreshSlotsUI();
}
function loadRecentIntoTab(rec) {
  const tab = KIND_TAB[rec.kind] || 'picture';
  goToTab(tab);
  const loader = tabLoaders[tab];
  if (loader && rec.sourceBlob) loader(asFile(rec.sourceBlob, rec.name), rec.settings && rec.settings.dest);
}

// ---- render: per-tab cards ----
function createSlotCard(area, slot) {
  const live = isLiveArea(area);
  const card = el('div', 'slot-card' + (live ? ' is-live' : ''));

  if (live) {
    card.appendChild(el('div', 'slot-card-thumb', '▶'));
  } else {
    const img = el('img', 'slot-card-thumb');
    img.alt = `Last pushed to ${AREA_LABEL[area]}`;
    if (slot.thumbBlob) img.src = objURL(slot.thumbBlob);
    if (slot.kind === 'gif' && slot.sourceBlob) wireGifHover(img, slot);
    card.appendChild(img);
  }

  const body = el('div', 'slot-card-body');
  body.appendChild(el('div', 'slot-card-area', AREA_LABEL[area]));
  if (live) {
    const labels = LIVE_LABELS[liveKind] || LIVE_LABELS.np;
    body.appendChild(el('div', 'slot-card-name', labels.card));
    body.appendChild(el('div', 'slot-card-when',
      npTrack && npTrack.title ? `${npTrack.title} — ${npTrack.artist || ''}`.replace(/ — $/, '') : labels.fallbackSub));
  } else {
    body.appendChild(el('div', 'slot-card-name', slot.name || AREA_LABEL[area]));
    const when = el('div', 'slot-card-when', `Last pushed from Studio · ${relTime(slot.pushedAt)}`);
    when.title = new Date(slot.pushedAt).toLocaleString();
    body.appendChild(when);
    if (slot.sourceDropped) body.appendChild(el('div', 'slot-card-when', 'source not cached (low storage) — use Replace'));

    const actions = el('div', 'slot-card-actions');
    const status = el('p', 'slot-card-status statusline');
    const repush = mkBtn('Re-push', 'primary small', () => doRePush(slot, status));
    if (slot.sourceDropped) repush.disabled = true;
    actions.append(repush, mkBtn('Replace', 'small', () => doReplace(slot)), mkBtn('Clear', 'danger small', () => doClear(area)));
    body.append(actions, status);
  }
  card.appendChild(body);
  return card;
}

async function renderAllCards(map) {
  const slotMap = map || await slots.allSlots();
  for (const { id, areas } of CARD_CONTAINERS) {
    const container = document.getElementById(id);
    if (!container) continue;
    container.innerHTML = '';
    let count = 0;
    for (const area of areas) {
      const slot = slotMap[area];
      if (!slot && !isLiveArea(area)) continue;
      container.appendChild(createSlotCard(area, slot || { area, name: AREA_LABEL[area] }));
      count++;
    }
    container.hidden = count === 0;
  }
  renderBarOverview(slotMap);
}

// ---- render: device-bar overview strip ----
function renderBarOverview(map) {
  const wrap = document.getElementById('dbOverview');
  const thumbs = document.getElementById('dbThumbs');
  if (!wrap || !thumbs) return;
  thumbs.innerHTML = '';
  let count = 0;
  for (const area of slots.SLOT_AREAS) {
    const live = isLiveArea(area);
    const slot = map[area];
    if (!slot && !live) continue;
    const b = el('button', 'db-thumb' + (live ? ' is-live' : ''));
    b.type = 'button';
    const liveLabel = (LIVE_LABELS[liveKind] || LIVE_LABELS.np).card;
    b.title = live ? liveLabel : `${slot.name} — last pushed from Studio ${relTime(slot.pushedAt)}`;
    if (live) {
      b.appendChild(el('span', 'db-thumb-live', liveKind === 'weather' ? '☀' : '▶'));
    } else if (slot.thumbBlob) {
      const img = el('img'); img.src = objURL(slot.thumbBlob); img.alt = '';
      if (slot.kind === 'gif' && slot.sourceBlob) wireGifHover(img, slot);
      b.appendChild(img);
    }
    b.appendChild(el('span', 'db-thumb-area', AREA_LABEL_SHORT[area]));
    b.addEventListener('click', () => goToTab(AREA_TAB[area]));
    thumbs.appendChild(b);
    count++;
  }
  wrap.hidden = count === 0;
}

// ---- render: device-bar live readout (Now Playing / Weather) ----
function renderBarLive() {
  const stateEl = document.getElementById('nsState');
  const trackEl = document.getElementById('nsTrack');
  if (!stateEl || !trackEl) return;
  if (npLive) {
    // A live feature owns the screen — clear the static-view chips and light the live chip that owns
    // it (Weather → nsWeather, else Now Playing). setNowShowing early-returns while live, so this is
    // the only writer of the switch chips' pressed state until the loop stops.
    ['nsClock', 'nsPicture', 'nsGif'].forEach((id) => document.getElementById(id)?.setAttribute('aria-pressed', 'false'));
    const liveId = liveKind === 'weather' ? 'nsWeather' : 'nsNowPlaying';
    ['nsNowPlaying', 'nsWeather'].forEach((id) => document.getElementById(id)?.setAttribute('aria-pressed', String(id === liveId)));
    stateEl.textContent = (LIVE_LABELS[liveKind] || LIVE_LABELS.np).bar;
    stateEl.classList.add('is-live');
    if (npTrack && npTrack.title) {
      trackEl.textContent = `${npTrack.title} — ${npTrack.artist || ''}`.replace(/ — $/, '');
      trackEl.hidden = false;
    } else { trackEl.hidden = true; }
  } else {
    stateEl.classList.remove('is-live');
    trackEl.hidden = true;
    setNowShowing(lastView); // restore the normal view label + segment pressed state
  }
}

// Called by the Now Playing OR Weather loop: claim/release the live slot + keep the bar readout in
// step. `kind` names the owner ('np' | 'weather') so the bar/cards label it right; ignored on release.
function slotsLive(on, np, kind = 'np') {
  const newTrack = on && np ? { title: np.title, artist: np.artist } : (on ? npTrack : null);
  const newKind = on ? kind : 'np';
  const changed = on !== npLive || newKind !== liveKind || JSON.stringify(newTrack) !== JSON.stringify(npTrack);
  npLive = on;
  npTrack = newTrack;
  liveKind = newKind;
  renderBarLive();
  if (changed) refreshSlotsUI(); // only rebuild cards/overview when the live state actually moved
}

// ---- render: recents gallery ----
function createRecentCard(rec) {
  const card = el('div', 'recent-card' + (rec.pinned ? ' pinned' : ''));
  const img = el('img', 'recent-thumb');
  img.alt = rec.name;
  img.title = 'Load into tab';
  if (rec.thumbBlob) img.src = objURL(rec.thumbBlob);
  img.addEventListener('click', () => loadRecentIntoTab(rec));
  if (rec.kind === 'gif' && rec.sourceBlob) wireGifHover(img, rec);
  card.appendChild(img);

  const pin = mkBtn(rec.pinned ? '★' : '☆', 'small recent-pin' + (rec.pinned ? ' on' : ''), async () => {
    await slots.pinRecent(rec.id, !rec.pinned);
    refreshSlotsUI();
  });
  pin.title = rec.pinned ? 'Unpin' : 'Pin so the cap can’t evict it';
  card.appendChild(pin);

  card.appendChild(el('div', 'recent-name', rec.name));
  const meta = el('div', 'recent-meta', `${AREA_LABEL_SHORT[rec.area] || rec.area} · ${relTime(rec.pushedAt)}`);
  meta.title = `Last pushed from Studio · ${new Date(rec.pushedAt).toLocaleString()}`;
  card.appendChild(meta);

  const actions = el('div', 'recent-actions');
  const status = el('p', 'slot-card-status statusline');
  actions.append(
    mkBtn('Re-push', 'primary small', () => doRePush(rec, status)),
    mkBtn('Load', 'small', () => loadRecentIntoTab(rec)),
    mkBtn('Remove', 'small', async () => { await slots.removeRecent(rec.id); refreshSlotsUI(); }),
  );
  card.append(actions, status);
  return card;
}

async function renderRecents() {
  const gallery = document.getElementById('recentsGallery');
  const countEl = document.getElementById('recentsCount');
  if (!gallery) return;
  const list = await slots.listRecents();
  gallery.innerHTML = '';
  for (const rec of list) gallery.appendChild(createRecentCard(rec));
  if (countEl) countEl.textContent = String(list.length);
}

// One entry point that rebuilds every slot surface from IDB. Revokes the previous object-URL batch
// first so thumbnails don't leak across refreshes.
async function refreshSlotsUI() {
  revokeObjURLs();
  const map = await slots.allSlots();
  await renderAllCards(map);
  await renderRecents();
}

// Restore all cards + recents on load.
function setupSlots() {
  refreshSlotsUI();
}

// ---- lighting (keyboard RGB — VIA RGB-matrix over the same HID interface) ----
// #RRGGBB -> [hue, sat] in VIA's 0-255 units. Drop value/brightness (that's the
// separate slider). h = round(hDeg/360*255), s = round(s*255).
function rgbToHueSat(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return { hue: 0, sat: 0 };
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hDeg = 0;
  if (d !== 0) {
    if (max === r) hDeg = ((g - b) / d) % 6;
    else if (max === g) hDeg = (b - r) / d + 2;
    else hDeg = (r - g) / d + 4;
    hDeg *= 60;
    if (hDeg < 0) hDeg += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { hue: Math.round((hDeg / 360) * 255), sat: Math.round(s * 255) };
}

function setupLightingTab() {
  const statusEl = $('#lightStatus');
  const brightness = $('#lightBrightness');
  const brightnessOut = $('#lightBrightnessOut');
  const effect = $('#lightEffect');
  const speed = $('#lightSpeed');
  const speedOut = $('#lightSpeedOut');
  const color = $('#lightColor');
  // Remember the built-in lighting choices across reloads (UI only; no auto-send on load).
  persist(brightness, 'lightBrightness', (el) => { brightnessOut.textContent = el.value; });
  persist(speed, 'lightSpeed', (el) => { speedOut.textContent = el.value; });
  persist(color, 'lightColor');

  // ---- effect catalog + user curation --------------------------------------
  // The #lightEffect dropdown and the "Customize effects" toggle list both render from the same
  // catalog (src/effects.js), filtered to the user's enabled set. Curation is display-only — the
  // firmware still supports every effect. Default is ALL enabled; the set persists in localStorage.
  const EFFECT_SEL_KEY = 'al80.pref.lightEffect';
  const loadEnabled = () => {
    try { return effects.parseEnabled(localStorage.getItem(effects.STORAGE_KEY)) || new Set(effects.ALL_IDS); }
    catch { return new Set(effects.ALL_IDS); }
  };
  const saveEnabled = (set) => {
    try { localStorage.setItem(effects.STORAGE_KEY, effects.serializeEnabled(set)); } catch { /* storage unavailable */ }
  };
  let enabledEffects = effects.guardEnabled(loadEnabled());

  // Rebuild the dropdown to show only enabled effects, in catalog order. Keeps the current
  // selection if it's still enabled; otherwise falls back to the first enabled effect (never sends
  // a disabled one — the selection change here is silent, no 'change' event fires).
  const rebuildEffectDropdown = (preferId) => {
    const prev = preferId != null ? preferId : +effect.value;
    effect.textContent = '';
    for (const e of effects.filterEnabled(enabledEffects)) {
      const opt = document.createElement('option');
      opt.value = String(e.id);
      opt.textContent = e.name;
      effect.appendChild(opt);
    }
    effect.value = String(effects.pickSelected(enabledEffects, prev));
  };

  // Toggle list, grouped by category with a group-level "toggle all". Built once; syncToggles()
  // reflects state changes (including presets and the empty guard) without rebuilding the DOM.
  const toggleEls = [];   // { id, cb }
  const groupSyncers = []; // () => void — refresh a group header's checked/indeterminate state
  const effectCount = $('#effectCount');
  const updateCount = () => {
    if (effectCount) effectCount.textContent = `${enabledEffects.size} of ${effects.ALL_IDS.length}`;
  };
  const syncToggles = () => {
    for (const { id, cb } of toggleEls) cb.checked = enabledEffects.has(id);
    for (const s of groupSyncers) s();
    updateCount();
  };
  // Apply an enabled-set change: guard against empty, persist, rebuild dropdown, resync toggles.
  const applyEnabledChange = () => {
    enabledEffects = effects.guardEnabled(enabledEffects);
    saveEnabled(enabledEffects);
    rebuildEffectDropdown();
    syncToggles();
  };

  const renderToggles = () => {
    const container = $('#effectToggles');
    if (!container) return;
    container.textContent = '';
    for (const cat of effects.EFFECT_CATEGORIES) {
      const ids = effects.idsInCategory(cat.key);
      const group = document.createElement('div');
      group.className = 'effect-group';

      const header = document.createElement('label');
      header.className = 'inline effect-group-head';
      const groupCb = document.createElement('input');
      groupCb.type = 'checkbox';
      header.appendChild(groupCb);
      header.appendChild(document.createTextNode(' ' + cat.label));
      group.appendChild(header);

      for (const e of effects.effectsInCategory(cat.key)) {
        const row = document.createElement('label');
        row.className = 'inline effect-toggle';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = enabledEffects.has(e.id);
        cb.addEventListener('change', () => {
          if (cb.checked) enabledEffects.add(e.id); else enabledEffects.delete(e.id);
          applyEnabledChange();
        });
        row.appendChild(cb);
        row.appendChild(document.createTextNode(' ' + e.name));
        group.appendChild(row);
        toggleEls.push({ id: e.id, cb });
      }

      const syncGroup = () => {
        const on = ids.filter((id) => enabledEffects.has(id)).length;
        groupCb.checked = on === ids.length;
        groupCb.indeterminate = on > 0 && on < ids.length;
      };
      groupCb.addEventListener('change', () => {
        if (groupCb.checked) ids.forEach((id) => enabledEffects.add(id));
        else ids.forEach((id) => enabledEffects.delete(id));
        applyEnabledChange();
      });
      groupSyncers.push(syncGroup);
      container.appendChild(group);
    }
  };

  renderToggles();
  // Restore the last-selected effect (if still enabled), then draw the filtered dropdown + toggles.
  let savedEffectSel = null;
  try { savedEffectSel = localStorage.getItem(EFFECT_SEL_KEY); } catch { /* ignore */ }
  rebuildEffectDropdown(savedEffectSel != null ? +savedEffectSel : undefined);
  syncToggles();
  // Persist the selected effect across reloads (mirrors the old persist() on #lightEffect).
  effect.addEventListener('change', () => {
    try { localStorage.setItem(EFFECT_SEL_KEY, effect.value); } catch { /* ignore */ }
  });

  $('#effectsAll')?.addEventListener('click', () => { enabledEffects = new Set(effects.ALL_IDS); applyEnabledChange(); });
  $('#effectsRecommended')?.addEventListener('click', () => { enabledEffects = new Set(effects.RECOMMENDED_IDS); applyEnabledChange(); });

  const debounce = (fn, ms = 120) => {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  // guardedSend only writes the status line on error; add a success confirmation so the
  // built-in controls narrate like the software-FX / palette paths do.
  const sendLight = async (label, packets, okMsg) => {
    if (await guardedSend(label, statusEl, packets)) setStatus(statusEl, okMsg, 'ok');
  };

  // VialRGB (custom firmware) sets the WHOLE mode in one report — effect + speed + HSV — so we track
  // the controls' state client-side and push the full mode on any change. The stock per-value builders
  // (buildLightEffect/Color/…) are for the stock firmware's channel-3 protocol and are ignored by the
  // custom firmware's VialRGB. brightness = HSV value.
  const lightState = () => {
    const { hue, sat } = rgbToHueSat(color.value);
    return { effect: +effect.value, speed: +speed.value, hue, sat, val: +brightness.value };
  };
  const pushLight = (okMsg) => {
    const s = lightState();
    return sendLight('Lighting', proto.buildVialRGB(s.effect, s), okMsg);
  };

  const sendBrightness = debounce(() => pushLight(`Brightness set to ${brightness.value}.`));
  brightness.addEventListener('input', () => {
    brightnessOut.textContent = brightness.value;
    sendBrightness();
  });

  effect.addEventListener('change', () =>
    pushLight(`Effect: ${effect.options[effect.selectedIndex].text}.`));

  const sendSpeed = debounce(() => pushLight(`Effect speed set to ${speed.value}.`));
  speed.addEventListener('input', () => {
    speedOut.textContent = speed.value;
    sendSpeed();
  });

  const sendColor = debounce(() => pushLight(`Color set to ${color.value}.`));
  color.addEventListener('input', sendColor);

  // ---- side LED bar (independent color for the three bar LEDs, indices 76-78) ----
  // Custom firmware raw-HID 0x47 (set color/mode) + 0x48 (save). Sends both so the choice sticks
  // across reboots — same guardedSend path as the built-in controls. When "independent" is off the
  // firmware lets the bar follow the key effect; we still send the color so it's remembered.
  const barStatusEl = $('#barStatus');
  const barColor = $('#barColor');
  const barBrightness = $('#barBrightness');
  const barBrightnessOut = $('#barBrightnessOut');
  const barIndependent = $('#barIndependent');
  persist(barColor, 'barColor');
  persist(barBrightness, 'barBrightness', (el) => { barBrightnessOut.textContent = el.value; });
  persist(barIndependent, 'barIndependent');

  const sendBar = async () => {
    const { hue, sat } = rgbToHueSat(barColor.value);
    const val = +barBrightness.value;
    const indep = barIndependent.checked;
    const packets = [proto.buildBarColor(hue, sat, val, indep), proto.buildBarSave()];
    const okMsg = indep ? `Side bar set to ${barColor.value}.` : 'Side bar following the keys.';
    if (await guardedSend('Side LED bar', barStatusEl, packets)) setStatus(barStatusEl, okMsg, 'ok');
  };
  const sendBarDebounced = debounce(sendBar);
  barColor.addEventListener('input', sendBarDebounced);
  barBrightness.addEventListener('input', () => {
    barBrightnessOut.textContent = barBrightness.value;
    sendBarDebounced();
  });
  barIndependent.addEventListener('change', sendBar);

  // ---- software effects (host-driven color animation) -----------------------
  // These stream SAVE-LESS color reports (proto.buildLightColorLive) so they never touch the EEPROM;
  // only the one-time effect=Solid Color at the start of a run is persisted. Exactly one effect runs
  // at a time — Start stops any other. A setTimeout chain (not rAF) drives the per-step delay; a
  // generation token + running flag cancel it cleanly on Stop, tab-switch, or disconnect.
  const SOLID_COLOR_EFFECT = 2; // VialRGB VIALRGB_EFFECT_SOLID_COLOR (the FX stream sets this + a live color)
  const fxStatus = $('#fxStatus');
  const strobeColorA = $('#strobeColorA');
  const strobeColorB = $('#strobeColorB');
  const strobeSpeed = $('#strobeSpeed');
  const strobeSpeedOut = $('#strobeSpeedOut');
  const cycleSpeed = $('#cycleSpeed');
  const cycleSpeedOut = $('#cycleSpeedOut');
  const breatheColorA = $('#breatheColorA');
  const breatheColorB = $('#breatheColorB');
  const breatheSpeed = $('#breatheSpeed');
  const breatheSpeedOut = $('#breatheSpeedOut');

  let fxToken = 0;      // bumped on every start/stop; a running loop bails when its token is stale
  let fxTimer = null;   // pending setTimeout handle
  let fxRunning = false;

  function stopFx() {
    fxRunning = false;
    fxToken++;                                    // invalidate any in-flight loop iteration
    if (fxTimer) { clearTimeout(fxTimer); fxTimer = null; }
  }
  lightingFxCtl.stop = stopFx;

  // One save-less color frame. Uses hid.send directly (not guardedSend) so animation frames don't
  // flood the device log — only errors are logged/surfaced. Returns false on failure.
  async function sendFrame(report) {
    try {
      await hid.send([report], { gap: 0 });
      return true;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      devLog('Light FX frame', { packets: 1, error: msg });
      setStatus(fxStatus, 'Send failed: ' + msg, 'err');
      return false;
    }
  }

  // Leave the board resting on a solid color (the given picker) — used on Stop.
  async function restTo(colorInput) {
    if (!connected) return;
    const { hue, sat } = rgbToHueSat(colorInput.value);
    await sendFrame(proto.buildVialRGBColorLive(hue, sat));
  }

  // frameFn(i) -> {hue, sat} for step i; delayFn() -> ms until the next step.
  // sEl = which status line to narrate on (defaults to the effects one; palette passes its own).
  async function startFx(name, frameFn, delayFn, sEl = fxStatus) {
    stopFx();                                     // Start stops any other effect
    if (!connected) { setStatus(sEl, 'Connect first.', 'err'); return; }
    const token = ++fxToken;
    fxRunning = true;
    setStatus(sEl, `${name} — starting…`);
    // The ONLY EEPROM write: pin the base effect to Solid Color so live color reports show through.
    const ok = await guardedSend('FX effect → Solid Color', sEl, proto.buildVialRGB(SOLID_COLOR_EFFECT, { val: 255 }));
    if (!ok) { stopFx(); return; }
    if (token !== fxToken || !fxRunning) return;  // Stop pressed during the await
    setStatus(sEl, `${name} running — press Stop to end.`, 'ok');
    let i = 0;
    const tick = async () => {
      if (token !== fxToken || !fxRunning) return;
      const { hue, sat } = frameFn(i);
      const sent = await sendFrame(proto.buildVialRGBColorLive(hue, sat));
      if (!sent) { stopFx(); return; }            // sendFrame already surfaced the error
      if (token !== fxToken || !fxRunning) return; // Stop pressed while the frame was in flight
      i++;
      fxTimer = setTimeout(tick, Math.max(10, delayFn()));
    };
    tick();
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  // Shortest-path interpolation on the 0..255 hue wheel (avoids sweeping the long way round).
  function lerpHue(a, b, t) {
    let d = b - a;
    if (d > 128) d -= 256; else if (d < -128) d += 256;
    return ((a + d * t) % 256 + 256) % 256;
  }

  // Strobe: alternate A/B every `ms/color`. Pickers are read live so edits apply mid-run.
  strobeSpeed.addEventListener('input', () => { strobeSpeedOut.textContent = strobeSpeed.value; });
  strobeSpeedOut.textContent = strobeSpeed.value;
  $('#strobeStart').addEventListener('click', () =>
    startFx('Strobe',
      (i) => rgbToHueSat((i % 2 === 0 ? strobeColorA : strobeColorB).value),
      () => +strobeSpeed.value));
  $('#strobeStop').addEventListener('click', async () => {
    stopFx();
    setStatus(fxStatus, 'Stopped.');
    await restTo(strobeColorA);                   // rest on the last A
  });

  // Cycle: rainbow hue sweep 0→255 at full saturation.
  cycleSpeed.addEventListener('input', () => { cycleSpeedOut.textContent = cycleSpeed.value; });
  cycleSpeedOut.textContent = cycleSpeed.value;
  $('#cycleStart').addEventListener('click', () =>
    startFx('Cycle',
      (i) => ({ hue: i % 256, sat: 255 }),
      () => +cycleSpeed.value));
  $('#cycleStop').addEventListener('click', () => {
    stopFx();
    setStatus(fxStatus, 'Stopped.');              // leave on the last hue — no effect change
  });

  // Breathe: triangle interpolate hue/sat A→B→A over N steps.
  const BREATHE_STEPS = 64;
  breatheSpeed.addEventListener('input', () => { breatheSpeedOut.textContent = breatheSpeed.value; });
  breatheSpeedOut.textContent = breatheSpeed.value;
  $('#breatheStart').addEventListener('click', () =>
    startFx('Breathe',
      (i) => {
        const a = rgbToHueSat(breatheColorA.value);
        const b = rgbToHueSat(breatheColorB.value);
        const half = BREATHE_STEPS / 2;
        const phase = i % BREATHE_STEPS;
        const t = phase <= half ? phase / half : (BREATHE_STEPS - phase) / half; // 0→1→0
        return { hue: Math.round(lerpHue(a.hue, b.hue, t)), sat: Math.round(lerp(a.sat, b.sat, t)) };
      },
      () => +breatheSpeed.value));
  $('#breatheStop').addEventListener('click', async () => {
    stopFx();
    setStatus(fxStatus, 'Stopped.');
    await restTo(breatheColorA);                  // rest on the last A
  });

  // ---- music-reactive lighting (opt-in) -------------------------------------
  // Captures shared audio in the browser (getDisplayMedia, behind the Start gesture), maps each frame
  // to global HSV or, on custom firmware, three physical RGB zones. Every stream is save-less.
  // Twin of startFx: an audio color source and an rAF clock. Registered into lightingFxCtl.stop so every teardown point
  // (Stop, tab-away ui.js:445/467, disconnect ui.js:161) also tears the audio stream down.
  const musicStatus = $('#musicStatus');
  const musicMode = $('#musicMode');
  const musicStyleNote = $('#musicStyleNote');
  const musicColor = $('#musicColor');
  const musicCap = $('#musicCap');
  const musicCapOut = $('#musicCapOut');
  const musicLevel = $('#musicLevel');
  const musicLevelOut = $('#musicLevelOut');
  const musicDecay = $('#musicDecay');
  const musicDecayOut = $('#musicDecayOut');
  const musicThreshold = $('#musicThreshold');
  const musicThresholdOut = $('#musicThresholdOut');
  const musicThresholdLabel = (value) => {
    const pct = Math.max(0, Math.min(40, Math.round(+value || 0)));
    if (pct === 0) return 'Off (0%)';
    if (pct <= 3) return `Very sensitive (${pct}%)`;
    if (pct <= 8) return `Normal (${pct}%)`;
    if (pct <= 18) return `Less sensitive (${pct}%)`;
    return `Only loud (${pct}%)`;
  };
  const renderMusicThreshold = () => {
    if (musicThreshold && musicThresholdOut) musicThresholdOut.textContent = musicThresholdLabel(musicThreshold.value);
  };
  // Shows the INPUT level, not the brightness we produced. Those two look identical when something
  // is wrong ("the lights are dim" vs "the audio is quiet"), and telling them apart is the whole
  // point of the meter. Read in dB like any audio meter: shared-tab music sits near -20 dBFS, so a
  // linear 0..1 RMS bar would sit at ~10% and read as broken. The brightness we sent trails it.
  const renderMusicLevel = (input = null, sent = 0) => {
    const db = input ? 20 * Math.log10(input) : -Infinity;
    const live = input != null && Number.isFinite(db);
    if (musicLevel) musicLevel.value = live ? Math.max(0, Math.min(100, (db + 60) / 60 * 100)) : 0;
    if (musicLevelOut) {
      musicLevelOut.textContent = input == null ? '--'
        : live ? `${Math.round(db)} dB → ${Math.round(sent)}` : `silent → ${Math.round(sent)}`;
    }
  };
  const MUSIC_STYLE_NOTES = {
    breathe: 'Bass hits go red, mids green, and treble blue. Accent color is not used.',
    zones: 'Left tracks bass in red, center mids in green, and right treble in blue. Requires custom firmware.',
    pulse: 'Bass, mids, and treble set the color, then Accent color flashes on beat hits.',
    follow: 'The loudest frequency sets the hue across the color wheel. Accent color is not used.',
    picked: 'Uses Accent color all the time; only brightness reacts.',
  };
  const renderMusicStyle = () => {
    if (musicStyleNote) musicStyleNote.textContent = MUSIC_STYLE_NOTES[musicMode.value] || '';
    const usesAccent = musicMode.value === music.MUSIC_MODE.PULSE || musicMode.value === music.MUSIC_MODE.PICKED;
    musicColor?.closest('.music-control')?.toggleAttribute('hidden', !usesAccent);
  };
  persist(musicMode, 'musicMode');
  // The tick reads musicMode.value every frame, so a style change applies live — no Stop/Start
  // re-arm. Zones is the one style needing custom firmware; startMusic disables the option for the
  // run once a stock board answers the probe, so it can't be selected into mid-stream.
  const musicZonesOption = musicMode.querySelector(`option[value="${music.MUSIC_MODE.ZONES}"]`);
  musicMode.addEventListener('change', renderMusicStyle);
  renderMusicStyle();
  if (musicColor) persist(musicColor, 'musicColor');
  persist(musicCap, 'musicCap255', (el) => { musicCapOut.textContent = el.value; });
  persist(musicDecay, 'musicDecay', (el) => { musicDecayOut.textContent = el.value + '%'; });
  if (musicThreshold) persist(musicThreshold, 'musicThreshold', renderMusicThreshold);
  musicCap.addEventListener('input', () => { musicCapOut.textContent = musicCap.value; });
  musicDecay.addEventListener('input', () => { musicDecayOut.textContent = musicDecay.value + '%'; });
  musicThreshold?.addEventListener('input', renderMusicThreshold);
  renderMusicThreshold();

  let audioToken = 0, rafId = null, mediaStream = null, audioCtx = null, zonesLive = false;
  // Serializes this loop's sends. hid.send has no write queue, so two concurrent calls interleave
  // their sendReport()s in arbitrary order — see clearLiveZones for why that ordering is load-bearing.
  let musicInFlight = Promise.resolve();

  // Zones drive the firmware's live-LED override (0x49), which the board holds until it idles out
  // after AL80_LIVE_IDLE_MS. Clear it explicitly so the previous effect resumes now instead of half
  // a second later with a stale zone frame frozen on the keys.
  //
  // This MUST be ordered after any frame already on the wire: the firmware re-arms on ANY 0x49
  // (`case AP_LIVE_LEDS: … g_live_active = true`), so a stop that overtakes a stale zone frame gets
  // undone by it and we wait out the full idle timeout anyway — the exact thing this is here to
  // prevent. Chain rather than race. Failure is fine (the disconnect path gets here with the device
  // already gone); the idle timeout is the backstop.
  function clearLiveZones() {
    if (!zonesLive) return;
    zonesLive = false;
    musicInFlight = musicInFlight
      .catch(() => {})
      .then(() => hid.send([proto.buildLiveStop()], { gap: 0 }))
      .catch(() => {});
  }

  function stopMusic() {
    audioToken++;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    const stream = mediaStream;
    const context = audioCtx;
    mediaStream = null;
    audioCtx = null;
    clearLiveZones();
    if (musicZonesOption) musicZonesOption.disabled = false;
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
    try { context?.close(); } catch { /* already closed */ }
    renderMusicLevel();
  }
  // Chain into the shared lighting-stop so tab-away / disconnect / section-switch cover music too.
  const prevLightingStop = lightingFxCtl.stop;
  lightingFxCtl.stop = () => { prevLightingStop(); stopMusic(); };

  // Firmware detect via the 0x46 side-bar probe. Cached per run; misdetect is safe (wrong command
  // no-ops). Injected viaTransact keeps src/music.js DOM/HID-free and unit-testable.
  const detectFw = () =>
    music.detectFirmware((report, match, ms) => viaTransact(report, match, ms), 400);

  async function startMusic() {
    stopFx(); stopMusic();                          // exclusive with every other effect
    // stopMusic() just bumped audioToken; snapshot it so any Stop/disconnect/section-switch that
    // fires DURING an await below (the picker can sit open for seconds) is detectable afterward.
    // Without this, a cancel's stopMusic() runs, then the resolved await starts a loop anyway —
    // leaving a live screen-capture / zombie loop. Re-checked after every await in the setup path.
    const startToken = audioToken;
    if (!connected) { setStatus(musicStatus, 'Connect first.', 'err'); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus(musicStatus, 'This browser can\'t capture system audio (Chrome/Edge on Windows).', 'err');
      return;
    }
    setStatus(musicStatus, 'Choose an audio source…');
    const fwPromise = detectFw();
    try {
      mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include', windowAudio: 'system' });
    } catch {
      setStatus(musicStatus, 'Screen/audio share was cancelled.', 'err');
      return;
    }
    // Cancelled while the picker was open — tear down the stream we just got, don't start.
    if (startToken !== audioToken) { stopMusic(); return; }
    if (!mediaStream.getAudioTracks().length) {
      stopMusic();
      setStatus(musicStatus, 'No shared audio. Start again and choose a source with audio.', 'err');
      return;
    }
    mediaStream.getVideoTracks().forEach((t) => t.stop());       // we only want the audio track
    const audioTrack = mediaStream.getAudioTracks()[0];
    audioTrack.addEventListener('ended', () => {
      if (!mediaStream?.getAudioTracks().includes(audioTrack)) return;
      stopMusic();
      setStatus(musicStatus, 'Shared audio ended. Start again to resume.', 'err');
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      await audioCtx.resume();
    } catch (err) {
      if (startToken === audioToken) {
        stopMusic();
        setStatus(musicStatus, 'Could not start audio input: ' + ((err && err.message) || err), 'err');
      }
      return;
    }
    if (startToken !== audioToken) { stopMusic(); return; }
    if (audioCtx.state !== 'running') {
      stopMusic();
      setStatus(musicStatus, 'Audio input did not start. Try Start again.', 'err');
      return;
    }
    const srcNode = audioCtx.createMediaStreamSource(mediaStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.45;
    srcNode.connect(analyser);                                    // NEVER analyser.connect(destination)

    setStatus(musicStatus, 'Detecting firmware…');
    const fw = await fwPromise;
    if (startToken !== audioToken) { stopMusic(); return; }
    if (musicMode.value === music.MUSIC_MODE.ZONES && fw !== 'custom') {
      stopMusic();
      setStatus(musicStatus, 'Zones need the custom keyboard firmware.', 'err');
      return;
    }
    // Style switching is live, so a stock board must not be able to reach Zones mid-run at all.
    // stopMusic() re-enables it.
    if (musicZonesOption) musicZonesOption.disabled = fw !== 'custom';

    // Custom live frames set Solid Color themselves. Stock needs one temporary, save-less effect pin.
    const STOCK_SOLID_EFFECT = 1;
    const pin = fw === 'stock' ? [proto.buildLightSet(proto.LIGHT.EFFECT, STOCK_SOLID_EFFECT)] : null;
    if (pin && !await guardedSend('Music → Solid Color', musicStatus, pin)) { stopMusic(); return; }
    if (startToken !== audioToken) { stopMusic(); return; }   // cancelled during the pin send

    const freq = new Uint8Array(analyser.frequencyBinCount);
    const wave = new Uint8Array(analyser.fftSize);
    const state = music.newMapState();
    const token = ++audioToken;
    let lastFrameAt = null;
    setStatus(musicStatus, `Music reacting (${fw}). Press Stop to end.`, 'ok');

    const tick = async (now) => {
      if (token !== audioToken) return;
      // Re-read the style every frame so the dropdown applies live. Zones costs five 0x49 reports
      // per frame against one for the HSV styles, hence its slower clock — so the budget has to be
      // picked per frame too, not captured once at Start.
      const mode = musicMode.value;
      const frameMs = mode === music.MUSIC_MODE.ZONES ? 1000 / 20 : 1000 / 45;
      if (lastFrameAt != null && now - lastFrameAt < frameMs) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const frameScale = lastFrameAt == null ? 1 : Math.max(0.1, Math.min(3, (now - lastFrameAt) / (1000 / 60)));
      lastFrameAt = now;
      analyser.getByteFrequencyData(freq);
      analyser.getByteTimeDomainData(wave);
      const cap = Math.max(0, Math.min(255, +musicCap.value || 0)) / 255;
      const threshold = musicThreshold ? +musicThreshold.value / 100 : music.DEFAULT_THRESHOLD;
      const decay = 0.2 - Math.max(0, Math.min(100, +musicDecay.value || 0)) / 100 * 0.19;
      const accent = musicColor ? rgbToHueSat(musicColor.value) : { hue: 40, sat: 255 };
      const zones = mode === music.MUSIC_MODE.ZONES
        ? music.mapAudioToZones(freq, wave, { cap, threshold, decay, frameScale, state })
        : null;
      const hsv = zones ? null : music.mapAudioToHSV(freq, wave, mode, { cap, threshold, decay, frameScale, state, accentHue: accent.hue, accentSat: accent.sat });
      renderMusicLevel(music.frameLevel(wave), zones ? zones.level : hsv.val);
      try {
        if (!zones) clearLiveZones();   // switched away from Zones — drop the firmware override first
        // 1 report on custom, 2 on stock, 5 for a zone frame — all save-less. Direct hid.send (not
        // guardedSend) so animation frames don't flood the device log; only errors surface.
        musicInFlight = musicInFlight.catch(() => {}).then(() =>
          hid.send(zones ? music.buildZoneFrame(zones.values) : music.pickSaveLessCommand(fw, hsv), { gap: 0 }));
        // Set BEFORE the await: this frame is committed to the wire, so a Stop landing mid-send
        // must still know to clear the override. Setting it after lets the resolving send resurrect
        // the flag that stopMusic just cleared.
        if (zones) zonesLive = true;
        await musicInFlight;
      } catch (err) {
        const msg = (err && err.message) || String(err);
        devLog('Music FX frame', { error: msg });
        setStatus(musicStatus, 'Send failed: ' + msg, 'err');
        stopMusic();
        return;
      }
      if (token !== audioToken) return;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  $('#musicStart').addEventListener('click', startMusic);
  $('#musicStop').addEventListener('click', () => { stopMusic(); setStatus(musicStatus, 'Stopped.'); });

  // Manual lighting changes take control before their own send handlers run.
  effect.addEventListener('change', () => lightingFxCtl.stop(), { capture: true });
  color.addEventListener('input', () => lightingFxCtl.stop(), { capture: true });
  brightness.addEventListener('input', () => lightingFxCtl.stop(), { capture: true });
  speed.addEventListener('input', () => lightingFxCtl.stop(), { capture: true });

  // ---- palettes (multi-color presets, GLOBAL board animation) ---------------
  // A palette is an ordered list of color stops. Three modes animate the WHOLE board through them,
  // one color at a time: Cycle (smooth loop stop→stop→…→first), Breathe (same path, eased in/out at
  // each stop), Strobe (hard-switch, no interpolation). Runs on the shared startFx loop, so it's the
  // same "one animation at a time / save-less / stops on Stop, tab-away, disconnect" machinery as the
  // fixed effects above. Named {stops, mode, speed} presets live in localStorage.
  const paletteStopsEl = $('#paletteStops');
  const paletteAddStop = $('#paletteAddStop');
  const paletteMode = $('#paletteMode');
  const paletteSpeed = $('#paletteSpeed');
  const paletteSpeedOut = $('#paletteSpeedOut');
  const paletteStatus = $('#paletteStatus');
  const palettePresetSelect = $('#palettePresetSelect');
  const palettePresetName = $('#palettePresetName');
  const palettePresetSave = $('#palettePresetSave');
  const palettePresetDelete = $('#palettePresetDelete');

  const PALETTE_MIN = 2;
  const PALETTE_MAX = 6;
  const PALETTE_STEPS_PER_SEG = 48; // interpolation resolution per stop→stop segment (cycle/breathe)
  const PRESET_KEY = 'al80.palettePresets';

  // No red/blue "police" combos in the seeds.
  const DEFAULT_PRESETS = {
    Sunset:      { stops: ['#ff8c42', '#ff4d8d', '#8a2be2'], mode: 'cycle', speed: 40 },
    Ocean:       { stops: ['#1fb9b0', '#1f7ae0', '#0b3a8a'], mode: 'breathe', speed: 60 },
    Forest:      { stops: ['#1f8a3a', '#8ad11f'], mode: 'cycle', speed: 50 },
    Ember:       { stops: ['#e01f1f', '#ff7a1f', '#ffd11f'], mode: 'strobe', speed: 120 },
    Vaporwave:   { stops: ['#ff6ac1', '#22d3ee', '#a855f7'], mode: 'cycle', speed: 40 },
    Miami:       { stops: ['#ff2d95', '#14e0c8'], mode: 'breathe', speed: 55 },
    Aurora:      { stops: ['#2fe07a', '#1fb9b0', '#8a5cf6'], mode: 'cycle', speed: 45 },
    Lavender:    { stops: ['#7c3aed', '#b794f6', '#f0abfc'], mode: 'breathe', speed: 65 },
    Candy:       { stops: ['#ff7ab8', '#7affc4'], mode: 'breathe', speed: 55 },
    Neon:        { stops: ['#a3ff12', '#ff12d1', '#12e0ff'], mode: 'cycle', speed: 35 },
    Galaxy:      { stops: ['#5b21b6', '#c026d3', '#3b5bdb'], mode: 'cycle', speed: 45 },
    'Rose Gold': { stops: ['#ff9a8b', '#ffd194', '#ff6f91'], mode: 'breathe', speed: 65 },
    Mint:        { stops: ['#0fb39a', '#4fe0b0'], mode: 'breathe', speed: 55 },
  };

  // Current editor state. Seeded from Sunset so the row isn't empty on first paint.
  let paletteStops = DEFAULT_PRESETS.Sunset.stops.slice();

  // localStorage helpers — tolerant of quota/parse failures (private mode, disabled storage).
  function loadPresets() {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || {}; } catch { return {}; }
  }
  function savePresets(obj) {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(obj)); } catch { /* storage unavailable */ }
  }
  // Tombstones: names of curated defaults the user deleted, so the merge below doesn't
  // resurrect them on the next load.
  const TOMBSTONE_KEY = 'al80.palettePresets.deletedDefaults';
  function loadTombstones() {
    try { return new Set(JSON.parse(localStorage.getItem(TOMBSTONE_KEY)) || []); } catch { return new Set(); }
  }
  function saveTombstones(set) {
    try { localStorage.setItem(TOMBSTONE_KEY, JSON.stringify([...set])); } catch { /* storage unavailable */ }
  }
  // Merge in any curated defaults the browser doesn't have yet: first run gets them all,
  // and existing users pick up newly-added sets without losing their own saved presets.
  {
    const firstRun = localStorage.getItem(PRESET_KEY) == null;
    const have = loadPresets();
    const tombstoned = loadTombstones();
    let added = false;
    for (const [name, p] of Object.entries(DEFAULT_PRESETS)) {
      if (!(name in have) && !tombstoned.has(name)) { have[name] = p; added = true; }
    }
    if (firstRun || added) savePresets(have);
  }

  function refreshPresetDropdown(selectName) {
    const presets = loadPresets();
    const names = Object.keys(presets);
    palettePresetSelect.innerHTML = '';
    if (!names.length) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '(no presets)'; opt.disabled = true;
      palettePresetSelect.appendChild(opt);
      return;
    }
    names.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      palettePresetSelect.appendChild(opt);
    });
    if (selectName && presets[selectName]) palettePresetSelect.value = selectName;
  }

  // Rebuild the stop row from `paletteStops`. Each stop: a color input, ◀/▶ reorder, and × remove.
  // Editing a stop mutates paletteStops live, so a running animation picks it up next frame.
  function renderStops() {
    paletteStopsEl.innerHTML = '';
    paletteStops.forEach((hex, i) => {
      const stop = document.createElement('div');
      stop.className = 'palette-stop';

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = hex;
      picker.className = 'device-action';
      picker.disabled = !connected;
      picker.title = `Stop ${i + 1}`;
      picker.addEventListener('input', () => { paletteStops[i] = picker.value; });
      stop.appendChild(picker);

      const nav = document.createElement('div');
      nav.className = 'palette-stop-nav';
      const left = document.createElement('button');
      left.type = 'button'; left.className = 'palette-move'; left.textContent = '◀';
      left.title = 'Move left'; left.disabled = i === 0;
      left.addEventListener('click', () => {
        if (i === 0) return;
        [paletteStops[i - 1], paletteStops[i]] = [paletteStops[i], paletteStops[i - 1]];
        renderStops();
      });
      const right = document.createElement('button');
      right.type = 'button'; right.className = 'palette-move'; right.textContent = '▶';
      right.title = 'Move right'; right.disabled = i === paletteStops.length - 1;
      right.addEventListener('click', () => {
        if (i === paletteStops.length - 1) return;
        [paletteStops[i + 1], paletteStops[i]] = [paletteStops[i], paletteStops[i + 1]];
        renderStops();
      });
      nav.append(left, right);
      stop.appendChild(nav);

      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'palette-stop-remove'; rm.textContent = '×';
      rm.title = 'Remove stop'; rm.setAttribute('aria-label', `Remove color stop ${i + 1}`);
      rm.disabled = paletteStops.length <= PALETTE_MIN;
      rm.addEventListener('click', () => {
        if (paletteStops.length <= PALETTE_MIN) return;
        paletteStops.splice(i, 1);
        renderStops();
      });
      stop.appendChild(rm);

      paletteStopsEl.appendChild(stop);
    });
    // add-stop is connection-gated (device-action) plus capped at PALETTE_MAX.
    paletteAddStop.disabled = !connected || paletteStops.length >= PALETTE_MAX;
  }

  // frameFn(i) for the shared startFx loop. Reads stops/mode LIVE so mid-run edits apply.
  function paletteFrame(i) {
    const cols = paletteStops.map(rgbToHueSat);
    const n = cols.length;
    if (n === 0) return { hue: 0, sat: 0 };
    if (n === 1) return cols[0];
    const mode = paletteMode.value;
    if (mode === 'strobe') return cols[i % n];       // hard switch, one stop per step
    // cycle / breathe: n segments (…→first), PALETTE_STEPS_PER_SEG steps each, shortest-path hue lerp.
    const seg = Math.floor(i / PALETTE_STEPS_PER_SEG) % n;
    let t = (i % PALETTE_STEPS_PER_SEG) / PALETTE_STEPS_PER_SEG;
    if (mode === 'breathe') t = t * t * (3 - 2 * t); // smoothstep — ease in/out through each stop
    const from = cols[seg];
    const to = cols[(seg + 1) % n];
    return { hue: Math.round(lerpHue(from.hue, to.hue, t)), sat: Math.round(lerp(from.sat, to.sat, t)) };
  }

  function applyPreset(name) {
    const p = loadPresets()[name];
    if (!p) return;
    let stops = Array.isArray(p.stops) ? p.stops.slice(0, PALETTE_MAX) : [];
    if (stops.length < PALETTE_MIN) stops = DEFAULT_PRESETS.Sunset.stops.slice();
    paletteStops = stops;
    paletteMode.value = ['cycle', 'breathe', 'strobe'].includes(p.mode) ? p.mode : 'cycle';
    paletteSpeed.value = String(Math.max(10, Math.min(300, +p.speed || 40)));
    paletteSpeedOut.textContent = paletteSpeed.value;
    renderStops();
    setStatus(paletteStatus, `Loaded "${name}".`, 'ok');
  }

  paletteAddStop.addEventListener('click', () => {
    if (paletteStops.length >= PALETTE_MAX) return;
    paletteStops.push(paletteStops[paletteStops.length - 1] || '#5b9dff');
    renderStops();
  });

  paletteSpeed.addEventListener('input', () => { paletteSpeedOut.textContent = paletteSpeed.value; });

  palettePresetSelect.addEventListener('change', () => {
    if (palettePresetSelect.value) applyPreset(palettePresetSelect.value);
  });

  palettePresetSave.addEventListener('click', () => {
    const name = (palettePresetName.value || '').trim();
    if (!name) { setStatus(paletteStatus, 'Enter a name to save.', 'err'); return; }
    const presets = loadPresets();
    if (name in presets && !confirm(`A preset named "${name}" already exists. Overwrite it?`)) return;
    presets[name] = { stops: paletteStops.slice(), mode: paletteMode.value, speed: +paletteSpeed.value };
    savePresets(presets);
    { const t = loadTombstones(); if (t.delete(name)) saveTombstones(t); } // un-tombstone a re-created default
    refreshPresetDropdown(name);
    palettePresetName.value = '';
    setStatus(paletteStatus, `Saved "${name}".`, 'ok');
  });

  palettePresetDelete.addEventListener('click', () => {
    const name = palettePresetSelect.value;
    if (!name) return;
    const presets = loadPresets();
    if (!(name in presets)) return;
    delete presets[name];
    savePresets(presets);
    // If it's a curated default, remember the deletion so it doesn't come back on reload.
    if (name in DEFAULT_PRESETS) { const t = loadTombstones(); t.add(name); saveTombstones(t); }
    refreshPresetDropdown();
    setStatus(paletteStatus, `Deleted "${name}".`, 'ok');
  });

  $('#paletteStart').addEventListener('click', () =>
    startFx('Palette', paletteFrame, () => +paletteSpeed.value || 40, paletteStatus));
  $('#paletteStop').addEventListener('click', () => {
    stopFx();
    setStatus(paletteStatus, 'Stopped.');
  });

  refreshPresetDropdown();
  paletteSpeedOut.textContent = paletteSpeed.value;
  renderStops();

  // initial read-outs
  brightnessOut.textContent = brightness.value;
  speedOut.textContent = speed.value;
}

// ---- clear actions (moved into Picture / GIF editors) -----------------------
function setupClearActions() {
  $('#clearGif').addEventListener('click', async () => {
    if (!confirm('Erase the stored GIF on the keyboard? This cannot be undone.')) return;
    const statusEl = $('#gifStatus');
    setStatus(statusEl, 'Clearing GIF…');
    const ok = await guardedSend('Clear GIF', statusEl, proto.buildClearGif(), { gap: 2 });
    if (ok) setStatus(statusEl, 'GIF cleared.', 'ok');
  });

  // Stored-pictures ring management. Studio can't read which slot is on the LCD, so the flow is:
  // Next rotates the ring (PK_TOGGLE_PIC), Delete shown wipes whatever's currently displayed
  // (PK_DEL_PIC, no index), Clear all wipes the whole 16-slot ring.
  const spStatus = $('#storedPicturesStatus');
  $('#picNext').addEventListener('click', async () => {
    setStatus(spStatus, 'Rotating to next picture…');
    const ok = await guardedSend('Picture → next', spStatus, proto.buildNextPicture(), { gap: 1 });
    if (ok) setStatus(spStatus, 'Advanced to the next stored picture — check the LCD.', 'ok');
  });

  $('#picDeleteShown').addEventListener('click', async () => {
    if (!confirm("Delete the picture currently on the keyboard's screen?")) return;
    setStatus(spStatus, 'Deleting shown picture…');
    const ok = await guardedSend('Delete shown picture', spStatus, proto.buildDeletePicture(), { gap: 2 });
    if (ok) setStatus(spStatus, 'Deleted the shown picture. Press Next to check the next slot.', 'ok');
  });

  $('#picClearAll').addEventListener('click', async () => {
    if (!confirm('Erase ALL 16 stored pictures on the keyboard? This cannot be undone.')) return;
    setStatus(spStatus, 'Clearing all pictures…');
    const ok = await guardedSend('Clear all pictures', spStatus, proto.buildClearAllPictures(), { gap: 2 });
    if (ok) setStatus(spStatus, 'All stored pictures cleared.', 'ok');
  });
}

// ---- keymap (was "shortcuts") — offline, no device --------------------------
// Normalize PRESETS (grouped catalog) into [{group, items:[{label, keycode}]}].
function normalizePresets(presets) {
  if (!presets) return [];
  if (Array.isArray(presets)) {
    // Could be [{group, keys/items/presets:[...]}] or a flat [{label,keycode}].
    if (presets.length && (presets[0].group || presets[0].name) && (presets[0].items || presets[0].keys || presets[0].presets)) {
      return presets.map((g) => ({
        group: g.group || g.name || 'Presets',
        items: normalizeItems(g.items || g.keys || g.presets),
      }));
    }
    return [{ group: 'Presets', items: normalizeItems(presets) }];
  }
  // Object map: { "Group Name": [ ...items ] }
  return Object.entries(presets).map(([group, items]) => ({ group, items: normalizeItems(items) }));
}

function normalizeItems(items) {
  if (!items) return [];
  const arr = Array.isArray(items) ? items : Object.entries(items).map(([label, keycode]) => ({ label, keycode }));
  return arr.map((it) => {
    if (typeof it === 'string') return { label: it, keycode: it };
    return {
      label: it.label || it.name || it.title || it.keycode || it.code || String(it),
      keycode: it.keycode || it.code || it.via || it.value || it.label || '',
    };
  });
}

// Build the keycode picker catalog: a few synthesized "basic" groups (letters,
// numbers, F-keys, common editing/nav/mods) that the PRESETS library doesn't
// carry, followed by the existing PRESETS groups (media, layers, mod-tap, etc.).
function buildPickerGroups() {
  const letters = { group: 'Letters', items: [] };
  for (let i = 0; i < 26; i++) {
    const l = String.fromCharCode(65 + i);
    letters.items.push({ label: l, keycode: 'KC_' + l });
  }
  const numbers = { group: 'Numbers', items: [] };
  for (let i = 0; i <= 9; i++) numbers.items.push({ label: String(i), keycode: 'KC_' + i });

  const fkeys = { group: 'Function keys', items: [] };
  for (let i = 1; i <= 12; i++) fkeys.items.push({ label: 'F' + i, keycode: 'KC_F' + i });

  const common = {
    group: 'Common',
    items: [
      { label: 'Esc', keycode: 'KC_ESC' }, { label: 'Tab', keycode: 'KC_TAB' },
      { label: 'Enter', keycode: 'KC_ENT' }, { label: 'Space', keycode: 'KC_SPC' },
      { label: 'Backspace', keycode: 'KC_BSPC' }, { label: 'Delete', keycode: 'KC_DEL' },
      { label: 'Caps Lock', keycode: 'KC_CAPS' }, { label: 'Grave `', keycode: 'KC_GRV' },
      { label: 'Minus -', keycode: 'KC_MINS' }, { label: 'Equal =', keycode: 'KC_EQL' },
      { label: 'Up', keycode: 'KC_UP' }, { label: 'Down', keycode: 'KC_DOWN' },
      { label: 'Left', keycode: 'KC_LEFT' }, { label: 'Right', keycode: 'KC_RGHT' },
      { label: 'Home', keycode: 'KC_HOME' }, { label: 'End', keycode: 'KC_END' },
      { label: 'Page Up', keycode: 'KC_PGUP' }, { label: 'Page Down', keycode: 'KC_PGDN' },
      { label: 'Left Ctrl', keycode: 'KC_LCTL' }, { label: 'Left Shift', keycode: 'KC_LSFT' },
      { label: 'Left Alt', keycode: 'KC_LALT' }, { label: 'Left GUI', keycode: 'KC_LGUI' },
      { label: 'Transparent', keycode: 'KC_TRNS' }, { label: 'No-op', keycode: 'KC_NO' },
    ],
  };
  return [common, letters, numbers, fkeys, ...normalizePresets(keymap.PRESETS)];
}

// Compact label shown on a key cap.
function keyCapLabel(kc) {
  if (!kc || kc === 'KC_NO') return '';
  if (kc === 'KC_TRNS' || kc === 'KC_TRANSPARENT') return '▽';
  if (kc.startsWith('KC_')) return kc.slice(3);
  return kc; // MO(1), LT(1,KC_ESC), LGUI(KC_1), CUSTOM(22), MACRO(1)…
}

function setupKeymap() {
  const AL = keymap.AL80;
  const ROWS = AL.MATRIX_ROWS, COLS = AL.MATRIX_COLS;
  const LAYER_SIZE = AL.LAYER_SIZE, LAYER_COUNT = AL.LAYER_COUNT;

  const statusEl = $('#keymapStatus');
  const layerSel = $('#layerSelect');
  wireTablistArrows(layerSel);
  const grid = $('#keyGrid');
  const encCwEl = $('#encCw');
  const encCcwEl = $('#encCcw');
  const readBtn = $('#keymapRead');
  const testerToggle = $('#testerToggle');
  const testerStatus = $('#testerStatus');

  const picker = $('#keycodePicker');
  const pickerTargetEl = $('#pickerTarget');
  const pickerSearch = $('#pickerSearch');
  const pickerBody = $('#pickerBody');
  const pickerCustom = $('#pickerCustom');
  const pickerApply = $('#pickerApply');
  const pickerClose = $('#pickerClose');

  // Seed the offline editor with the factory default (real, editable, exportable) instead of a
  // blank grid; Read from keyboard overwrites it with the board's actual keys.
  let state = keymap.factoryKeymap ? keymap.factoryKeymap()
    : (keymap.emptyKeymap ? keymap.emptyKeymap() : { layers: [], encoders: [[]], macros: [] });
  let currentLayer = 0;
  let pickerTarget = null; // { type:'key', idx, row, col } | { type:'enc', cw:boolean }
  const keyEls = new Map(); // matrix index -> button element
  const pickerGroups = buildPickerGroups();

  // ---- model helpers --------------------------------------------------------
  function ensureLayer(L) {
    if (!Array.isArray(state.layers)) state.layers = [];
    if (!Array.isArray(state.layers[L]) || state.layers[L].length < LAYER_SIZE) {
      const cur = Array.isArray(state.layers[L]) ? state.layers[L] : [];
      const fill = L === 0 ? 'KC_NO' : 'KC_TRNS';
      state.layers[L] = Array.from({ length: LAYER_SIZE }, (_, i) => cur[i] ?? fill);
    }
  }
  function ensureEncoder(L) {
    if (!Array.isArray(state.encoders)) state.encoders = [];
    if (!Array.isArray(state.encoders[0])) state.encoders[0] = [];
    if (!Array.isArray(state.encoders[0][L])) state.encoders[0][L] = ['KC_VOLD', 'KC_VOLU'];
  }
  const kcAt = (L, idx) => { ensureLayer(L); return state.layers[L][idx]; };

  // ---- rendering ------------------------------------------------------------
  const U = 44, GAP = 4;

  function applyCap(el, kc) {
    const label = keyCapLabel(kc);
    el.textContent = label;
    el.title = `${kc}  (row ${el.dataset.row}, col ${el.dataset.col})`;
    el.classList.toggle('key-tight', label.length > 3 && label.length <= 5);
    el.classList.toggle('key-wrap', label.length > 5);
    el.classList.toggle('k-trns', kc === 'KC_TRNS' || kc === 'KC_TRANSPARENT');
    el.classList.toggle('k-no', !kc || kc === 'KC_NO');
  }

  function renderGrid() {
    grid.style.width = 16 * U + 'px';
    grid.style.height = 6 * U + 'px';
    grid.innerHTML = '';
    keyEls.clear();
    keymap.AL80_LAYOUT.forEach(([r, c, x, y, w]) => {
      const idx = keymap.matrixIndex(r, c);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'key';
      btn.style.left = x * U + 'px';
      btn.style.top = y * U + 'px';
      btn.style.width = w * U - GAP + 'px';
      btn.style.height = U - GAP + 'px';
      btn.dataset.idx = String(idx);
      btn.dataset.row = String(r);
      btn.dataset.col = String(c);
      applyCap(btn, kcAt(currentLayer, idx));
      btn.addEventListener('click', () => openPicker({ type: 'key', idx, row: r, col: c }));
      grid.appendChild(btn);
      keyEls.set(idx, btn);
    });
  }

  function refreshCaps() {
    keyEls.forEach((el, idx) => applyCap(el, kcAt(currentLayer, idx)));
    grid.querySelectorAll('.key.selected').forEach((e) => e.classList.remove('selected'));
  }

  function renderLayerSelect() {
    layerSel.innerHTML = '';
    for (let L = 0; L < LAYER_COUNT; L++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'layer-btn';
      b.textContent = 'L' + L;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(L === currentLayer));
      b.tabIndex = L === currentLayer ? 0 : -1;
      b.addEventListener('click', () => {
        currentLayer = L;
        renderLayerSelect();
        refreshCaps();
        renderEncoder();
      });
      layerSel.appendChild(b);
    }
  }

  function renderEncoder() {
    ensureEncoder(currentLayer);
    // VIA/QMK store encoders as [ccw, cw] (index 0 = counter-clockwise). Confirmed on-device:
    // knob right (CW) = volume up = the factory array's index 1 (KC_VOLU).
    const [ccw, cw] = state.encoders[0][currentLayer];
    encCwEl.textContent = keyCapLabel(cw) || '—';
    encCwEl.title = cw;
    encCcwEl.textContent = keyCapLabel(ccw) || '—';
    encCcwEl.title = ccw;
  }

  // ---- keycode picker -------------------------------------------------------
  function renderPickerList(filter = '') {
    const f = filter.trim().toLowerCase();
    pickerBody.innerHTML = '';
    pickerGroups.forEach((g) => {
      const items = g.items.filter(
        (it) => !f || it.label.toLowerCase().includes(f) || it.keycode.toLowerCase().includes(f),
      );
      if (!items.length) return;
      const wrap = document.createElement('div');
      wrap.className = 'preset-group';
      const h = document.createElement('h4');
      h.textContent = g.group;
      wrap.appendChild(h);
      const chips = document.createElement('div');
      chips.className = 'preset-chips';
      items.forEach((it) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'preset-chip';
        chip.append(document.createTextNode(it.label + ' '));
        const code = document.createElement('code');
        code.textContent = it.keycode;
        chip.appendChild(code);
        chip.addEventListener('click', () => applyKeycode(it.keycode));
        chips.appendChild(chip);
      });
      wrap.appendChild(chips);
      pickerBody.appendChild(wrap);
    });
  }

  let pickerReturnFocus = null; // element to restore focus to when the picker closes (a11y)
  function openPicker(target) {
    pickerReturnFocus = document.activeElement;
    pickerTarget = target;
    grid.querySelectorAll('.key.selected').forEach((e) => e.classList.remove('selected'));
    if (target.type === 'key') {
      keyEls.get(target.idx)?.classList.add('selected');
      pickerTargetEl.textContent = `key (row ${target.row}, col ${target.col}) · layer ${currentLayer}`;
      pickerCustom.value = kcAt(currentLayer, target.idx);
    } else {
      pickerTargetEl.textContent = `encoder ${target.cw ? 'CW (turn right)' : 'CCW (turn left)'} · layer ${currentLayer}`;
      ensureEncoder(currentLayer);
      pickerCustom.value = state.encoders[0][currentLayer][target.cw ? 1 : 0]; // index 1 = cw
    }
    pickerSearch.value = '';
    renderPickerList('');
    picker.hidden = false;
    pickerSearch.focus();
  }

  function closePicker() {
    picker.hidden = true;
    pickerTarget = null;
    grid.querySelectorAll('.key.selected').forEach((e) => e.classList.remove('selected'));
    if (pickerReturnFocus && typeof pickerReturnFocus.focus === 'function') pickerReturnFocus.focus();
    pickerReturnFocus = null;
  }

  function applyKeycode(kc) {
    const t = pickerTarget;
    if (!t) return;
    if (t.type === 'key') setKey(t, kc);
    else setEncoder(t, kc);
    closePicker();
  }

  async function setKey(t, kc) {
    ensureLayer(currentLayer);
    state.layers[currentLayer][t.idx] = kc;
    const el = keyEls.get(t.idx);
    if (el) applyCap(el, kc);
    const num = keymap.keycodeToNumber(kc);
    if (!connected) {
      setStatus(statusEl, `Set ${kc} (offline — connect or export to apply).`);
      return;
    }
    if (num == null) {
      setStatus(statusEl, `Saved ${kc} to model, but it's an unknown token — not written to the device.`, 'err');
      return;
    }
    await guardedSend(`Keymap L${currentLayer} → ${kc}`, statusEl, [
      proto.buildKeymapSet(currentLayer, t.row, t.col, num),
    ]);
    setStatus(statusEl, `Wrote ${kc} to layer ${currentLayer}.`, 'ok');
  }

  async function setEncoder(t, kc) {
    ensureEncoder(currentLayer);
    state.encoders[0][currentLayer][t.cw ? 1 : 0] = kc; // index 1 = cw
    renderEncoder();
    const num = keymap.keycodeToNumber(kc);
    if (!connected) {
      setStatus(statusEl, `Set encoder ${t.cw ? 'CW' : 'CCW'} → ${kc} (offline).`);
      return;
    }
    if (num == null) {
      setStatus(statusEl, `Unknown token ${kc} — not written to the device.`, 'err');
      return;
    }
    await guardedSend(`Encoder ${t.cw ? 'CW' : 'CCW'} → ${kc}`, statusEl, [
      proto.buildEncoderSet(currentLayer, 0, t.cw, num),
    ]);
    setStatus(statusEl, `Wrote encoder ${t.cw ? 'CW' : 'CCW'} on layer ${currentLayer}.`, 'ok');
  }

  encCwEl.addEventListener('click', () => openPicker({ type: 'enc', cw: true }));
  encCcwEl.addEventListener('click', () => openPicker({ type: 'enc', cw: false }));
  pickerSearch.addEventListener('input', () => renderPickerList(pickerSearch.value));
  pickerApply.addEventListener('click', () => {
    const kc = pickerCustom.value.trim();
    if (kc) applyKeycode(kc);
  });
  pickerCustom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); pickerApply.click(); }
  });
  pickerClose.addEventListener('click', closePicker);
  // Keep Tab within the modal while it's open (the aria-modal contract).
  picker.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || picker.hidden) return;
    const list = [...picker.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  picker.addEventListener('click', (e) => { if (e.target === picker) closePicker(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !picker.hidden) closePicker();
  });

  // ---- read the live keymap from the device --------------------------------
  // Bulk read via dynamic_keymap_get_buffer (≤28 bytes/chunk, VIA convention).
  // The buffer is all layers concatenated, 2 bytes/key, row-major matrix order.
  async function readFromDevice() {
    if (!connected) { setStatus(statusEl, 'Connect first.', 'err'); return; }
    readBtn.disabled = true;
    setStatus(statusEl, 'Reading keymap from keyboard…');
    try {
      let layerCount = LAYER_COUNT;
      try {
        const lc = await viaTransact(proto.buildViaLayerCount(), (d) => d[0] === 0x11);
        if (lc[1]) layerCount = Math.min(lc[1], LAYER_COUNT);
      } catch { /* fall back to AL80 default */ }

      const perLayer = ROWS * COLS * 2; // 180 bytes
      const total = layerCount * perLayer;
      const buf = new Uint8Array(total);
      for (let off = 0; off < total; off += 28) {
        const size = Math.min(28, total - off);
        const rep = await viaTransact(proto.buildKeymapGetBuffer(off, size), (d) => d[0] === 0x12);
        for (let i = 0; i < size; i++) buf[off + i] = rep[4 + i] ?? 0; // payload starts at index 4
      }
      for (let L = 0; L < layerCount; L++) {
        ensureLayer(L);
        for (let k = 0; k < LAYER_SIZE; k++) {
          const o = L * perLayer + k * 2;
          state.layers[L][k] = keymap.numberToKeycode((buf[o] << 8) | buf[o + 1]);
        }
      }
      // encoders, per layer, CW then CCW
      for (let L = 0; L < layerCount; L++) {
        ensureEncoder(L);
        for (const cw of [true, false]) {
          try {
            const r = await viaTransact(proto.buildEncoderGet(L, 0, cw), (d) => d[0] === 0x14);
            state.encoders[0][L][cw ? 1 : 0] = keymap.numberToKeycode((r[4] << 8) | r[5]); // index 1 = cw
          } catch { /* leave model value */ }
        }
      }
      refreshCaps();
      renderEncoder();
      setStatus(statusEl, `Read ${layerCount} layer(s) from the keyboard.`, 'ok');
      devLog('Keymap read', { ok: true });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      setStatus(statusEl, 'Read failed: ' + msg, 'err');
      devLog('Keymap read', { error: msg });
    } finally {
      readBtn.disabled = !connected;
    }
  }
  readBtn.addEventListener('click', readFromDevice);

  // ---- key tester: poll switch-matrix state, light up pressed keys ----------
  let testerTimer = null;
  function stopTester() {
    if (testerTimer) { clearInterval(testerTimer); testerTimer = null; }
    keyEls.forEach((el) => el.classList.remove('pressed'));
    testerToggle.textContent = 'Start key tester';
    testerToggle.setAttribute('aria-pressed', 'false');
    testerStatus.textContent = '';
  }
  keymapTesterCtl.stop = stopTester;

  // Best-effort decode of the switch-matrix reply. VIA packs each row into
  // ceil(COLS/8) big-endian bytes after the 2-byte header; bit `col` = pressed.
  // Column/row packing can vary by firmware, so this degrades gracefully.
  let testerPollInFlight = false;
  async function pollMatrix() {
    if (testerPollInFlight) return;
    testerPollInFlight = true;
    let d;
    try {
      d = await viaTransact(proto.buildSwitchMatrixState(), (x) => x[0] === 0x02 && x[1] === 0x03, 250);
    } catch (err) {
      testerStatus.textContent = 'Tester: ' + ((err && err.message) || err);
      return;
    } finally {
      testerPollInFlight = false;
    }
    const bytesPerRow = Math.ceil(COLS / 8);
    keyEls.forEach((el, idx) => {
      const row = Math.floor(idx / COLS), col = idx % COLS;
      const base = 2 + row * bytesPerRow;
      let bits = 0;
      for (let b = 0; b < bytesPerRow; b++) bits = (bits << 8) | (d[base + b] || 0);
      el.classList.toggle('pressed', !!((bits >> col) & 1));
    });
  }
  testerToggle.addEventListener('click', () => {
    if (testerTimer) { stopTester(); return; }
    if (!connected) { setStatus(statusEl, 'Connect first.', 'err'); return; }
    testerToggle.textContent = 'Stop key tester';
    testerToggle.setAttribute('aria-pressed', 'true');
    testerStatus.textContent = 'Polling switch matrix — press keys to see them light up.';
    testerTimer = setInterval(pollMatrix, 80);
  });

  // ---- device utilities (VIA get/set_keyboard_value + dynamic_keymap_reset) --
  const deviceStatus = $('#deviceStatus');
  $('#fwRead').addEventListener('click', async () => {
    if (!connected) return;
    setStatus(deviceStatus, 'Reading…');
    try {
      const rep = await viaTransact(proto.buildFirmwareVersion(), (d) => d[0] === 0x02 && d[1] === 0x04, 500);
      if (!rep) { $('#fwVersion').textContent = 'no reply'; setStatus(deviceStatus, 'No reply from the keyboard.', 'err'); return; }
      const ver = ((rep[2] << 24) | (rep[3] << 16) | (rep[4] << 8) | rep[5]) >>> 0;
      $('#fwVersion').textContent = `firmware v${ver}`;
      setStatus(deviceStatus, '');
    } catch (err) {
      $('#fwVersion').textContent = 'no reply';
      setStatus(deviceStatus, 'Firmware read failed: ' + ((err && err.message) || err), 'err');
    }
  });
  $('#identifyBtn').addEventListener('click', async () => {
    if (!connected) return;
    if (await guardedSend('Identify', deviceStatus, [proto.buildDeviceIndication()], { gap: 1 }))
      setStatus(deviceStatus, 'Sent — the board should flash its lights.', 'ok');
  });
  $('#keymapResetBtn').addEventListener('click', async () => {
    if (!connected) return;
    if (!confirm('Reset the keyboard to its factory keymap? Your remaps on the device will be cleared (re-import your VIA JSON to undo).')) return;
    if (await guardedSend('Reset keymap', deviceStatus, [proto.buildKeymapReset()], { gap: 1 })) {
      setStatus(deviceStatus, 'Keymap reset to factory — re-reading…', 'ok');
      $('#keymapRead').click();
    }
  });

  // ---- import / export (offline, unchanged behavior) ------------------------
  $('#keymapImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = text; }
      state = keymap.importKeymap(payload);
      for (let L = 0; L < LAYER_COUNT; L++) ensureLayer(L);
      currentLayer = 0;
      renderLayerSelect();
      refreshCaps();
      renderEncoder();
      setStatus(statusEl, 'Imported ' + file.name, 'ok');
    } catch (err) {
      setStatus(statusEl, 'Import failed: ' + ((err && err.message) || err), 'err');
    }
  });

  $('#keymapExport').addEventListener('click', () => {
    try {
      const data = keymap.exportKeymap(state);
      const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'al80-keymap.json';
      a.click();
      URL.revokeObjectURL(url);
      setStatus(statusEl, 'Exported al80-keymap.json', 'ok');
    } catch (err) {
      setStatus(statusEl, 'Export failed: ' + ((err && err.message) || err), 'err');
    }
  });

  // initial render (offline-friendly: renders from the JSON model)
  for (let L = 0; L < LAYER_COUNT; L++) ensureLayer(L);
  renderLayerSelect();
  renderGrid();
  renderEncoder();
}

// ---- go ---------------------------------------------------------------------
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
