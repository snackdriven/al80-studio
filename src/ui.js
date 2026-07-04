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
  }
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
  setupLightingTab();
  setupClearActions();
  setupKeymap();
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
  const gateBtn = $('#gateConnect');
  if (gateBtn) gateBtn.addEventListener('click', toggleConnect);

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
    });
  });
  rovingTabindex(tabs);
  wireTablistArrows($('.tabs'));
}

// ---- Now Showing bar --------------------------------------------------------
// Tracks the last view THIS app set. 'unknown' on fresh connect (write-only device).
let lastView = 'unknown';

const NS_SEGMENTS = {
  clock: { view: proto.VIEW.HOMEPAGE, label: 'Clock' },
  picture: { view: proto.VIEW.PICTURE, label: 'Picture' },
  gif: { view: proto.VIEW.GIF, label: 'GIF' },
};

function setNowShowing(which) {
  lastView = which;
  $$('.ns-seg').forEach((seg) => {
    seg.setAttribute('aria-pressed', String(seg.dataset.view === which));
  });
  const stateEl = $('#nsState');
  if (stateEl) stateEl.textContent = which === 'unknown' ? 'unknown' : NS_SEGMENTS[which].label;
}

function setupNowShowing() {
  $$('.ns-seg').forEach((seg) => {
    seg.addEventListener('click', async () => {
      const key = seg.dataset.view;
      const spec = NS_SEGMENTS[key];
      if (!spec) return;
      const ok = await guardedSend(`View → ${spec.label}`, null, proto.buildView(spec.view), { gap: 1 });
      if (ok) setNowShowing(key);
    });
  });
  setNowShowing('unknown');
}

// ---- clock ------------------------------------------------------------------
let clockSyncTimer = null;

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

  async function sendOnce(useNow = false) {
    const date = useNow ? new Date() : readClockDate();
    const packets = proto.clockFromDate(date, is12.checked);
    setStatus(statusEl, 'Sending clock…');
    const ok = await guardedSend('Clock set', statusEl, packets, { gap: 1 });
    if (!ok) return false;
    // Show it: the clock lives on the Homepage view. Switch so it's visible.
    await guardedSend('View → Clock', statusEl, proto.buildView(proto.VIEW.HOMEPAGE), { gap: 1 });
    setNowShowing('clock');
    setStatus(statusEl, 'Clock set to ' + date.toLocaleTimeString(), 'ok');
    return true;
  }

  $('#clockSendOnce').addEventListener('click', () => sendOnce(false));

  $('#clockSync').addEventListener('change', async (e) => {
    if (e.target.checked) {
      await sendOnce(true);
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
      destNote.textContent = 'Shows on the home screen — the display path this firmware renders.';
    } else {
      previewLabel.innerHTML = 'Preview (96&times;160 picture page)';
      previewImg.style.width = '144px'; previewImg.style.height = '240px';
      destNote.textContent = 'Full-screen still image on the picture page — the upload shows it as an image-only view.';
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
    const dest = readDest();
    setStatus(statusEl, 'Rendering frame…');
    let frame;
    try {
      // main page = 96x64 mode-2 (the surface that displays); picture page = 112x137 slot.
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
    setStatus(statusEl, `Sending ${packets.length} packets…`);
    const onProg = (f) => { bar.style.width = Math.round(f * 100) + '%'; };
    // picture page = ACK-gated (blasting drops bytes); main page = plain send. (No pre-switch to home —
    // writing the picture buffer while parked on home doesn't land, leaving the old frame on screen.)
    try {
      const ok = dest === 'main'
        ? await sendWithProgress('Picture → main page', statusEl, packets, onProg, { gap: 0 })
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
  const dims = () => readDest() === 'main'
    ? { w: proto.MP_W, h: proto.MP_H, max: proto.MP_MAX_FRAMES, disp: [288, 192] }
    : { w: proto.GP_W, h: proto.GP_H, max: proto.GP_MAX_FRAMES, disp: [144, 240] }; // gif page: 96x160

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
      const frames = await gif.gifToFrames(currentFile, { maxFrames: d.max, width: d.w, height: d.h });
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
    destNote.textContent = readDest() === 'main'
      ? 'Plays on the home screen — the display path this firmware renders (96×64, up to 42 frames).'
      : 'Separate GIF page (96×160, up to 160 frames) — a full-screen animated GIF view.';
    if (currentFile) decodeAndPreview(); // re-decode at the new resolution
  }
  $$('input[name="gifDest"]').forEach((r) => r.addEventListener('change', applyDest));
  applyDest(); // initial note

  fps.addEventListener('input', () => {
    fpsOut.textContent = fps.value;
    if (previewImages && previewImages.length > 1) startPreview(false); // re-time, keep position
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    currentFile = file;
    nameEl.textContent = file.name;
    decodeAndPreview();
  });

  const wrap = $('#gifProgressWrap');
  const bar = $('#gifProgress');
  $('#gifSend').addEventListener('click', async () => {
    if (!currentFile) { setStatus(statusEl, 'Pick a GIF first.', 'err'); return; }
    const dest = readDest();
    const d = dims();
    let frames = currentFrames;
    if (!frames) {
      setStatus(statusEl, 'Decoding GIF…');
      try {
        frames = await gif.gifToFrames(currentFile, { maxFrames: d.max, width: d.w, height: d.h });
      } catch (err) {
        setStatus(statusEl, 'Decode failed: ' + ((err && err.message) || err), 'err');
        return;
      }
    }
    let packets;
    try {
      packets = dest === 'main' ? proto.buildMainPageGif(frames, +fps.value) : proto.buildGifPage(frames, +fps.value);
    } catch (err) {
      setStatus(statusEl, 'Build failed: ' + ((err && err.message) || err), 'err');
      return;
    }
    const total = frames.frameCount ?? frames.length; // original count; frames.length is already capped
    const kept = frames.length;
    wrap.hidden = false;
    bar.style.width = '0%';
    setStatus(statusEl, `Sending ${packets.length} packets (${kept} frame${kept === 1 ? '' : 's'} @ ${fps.value} fps) — paced, takes a few seconds…`);
    try {
      const ok = await sendGifWithProgress(dest === 'main' ? 'GIF → main page' : 'GIF → gif page', statusEl, packets, (f) => {
        bar.style.width = Math.round(f * 100) + '%';
      });
      if (ok) {
        const capNote = total > kept ? ` (kept the first ${kept} of ${total})` : '';
        if (dest === 'main') {
          setNowShowing('clock'); // main page = clock + your GIF
          setStatus(statusEl, `Saved GIF to the main page${capNote} — it should be playing now.`, 'ok');
        } else {
          setStatus(statusEl, 'Switching to GIF page…');
          const shown = await guardedSend('View → GIF', statusEl, proto.buildView(proto.VIEW.GIF), { gap: 1 });
          if (shown) setNowShowing('gif');
          setStatus(statusEl, `Sent GIF to the gif page${capNote} (may not display on your firmware).`, 'ok');
        }
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

  const controls = {
    fit: $('#slideFit'),
    brightness: $('#slideBrightness'),
    gray: $('#slideGray'),
  };

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
  function updateCurrent() {
    readout.textContent = slides.length
      ? `Slide ${(currentIdx % slides.length) + 1} of ${slides.length}`
      : 'No slides';
  }

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
    if (!slides.length || !connected) return;
    playBtn.textContent = 'Pause';
    const period = Math.max(1, +intervalEl.value || 1) * 1000;
    cycleTimer = setInterval(async () => {
      // Never advance while hidden or disconnected — stop and bail.
      if (!slideshowVisible() || !connected) { stopCycle(); return; }
      currentIdx = (currentIdx + 1) % slides.length;
      updateCurrent();
      await guardedSend('Slideshow → next', statusEl, proto.buildView(proto.VIEW.PICTURE));
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

  // Send slideshow: clear slots -> upload each still (200ms gap between so the device
  // commits each) -> show picture 1 -> start the auto-cycle. Guarded against re-entry so a
  // second Send (or Play mid-upload) can't interleave writes to the write-only device.
  const sendBtn = $('#slideSend');
  const nextBtn = $('#slideNext');
  let sending = false;
  const setBusy = (busy) => {
    sending = busy;
    sendBtn.disabled = nextBtn.disabled = playBtn.disabled = busy || !connected;
  };
  sendBtn.addEventListener('click', async () => {
    if (sending) return;
    if (!slides.length) { setStatus(statusEl, 'Add at least one image first.', 'err'); return; }
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
        const ok = await sendWithProgress(`Slideshow slide ${i + 1}/${n}`, statusEl, packets, (f) => {
          bar.style.width = Math.round(((i + f) / n) * 100) + '%';
        }, { gap: 0 });
        if (!ok) return;
        if (i < n - 1) await sleep(200); // let the device commit each picture
      }
      setStatus(statusEl, 'Showing slideshow…');
      currentIdx = 0;
      updateCurrent();
      await guardedSend('Slideshow → show', statusEl, proto.buildView(proto.VIEW.PICTURE), { gap: 1 });
      setNowShowing('picture');
      setBusy(false); // re-enable before starting the cycle
      startCycle();
      setStatus(statusEl, `Slideshow running — ${n} slide${n === 1 ? '' : 's'}, ${intervalEl.value}s each.`, 'ok');
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
      setStatus(statusEl, 'Playing.', 'ok');
    }
  });

  $('#slideNext').addEventListener('click', async () => {
    if (!slides.length) return;
    currentIdx = (currentIdx + 1) % slides.length;
    updateCurrent();
    await guardedSend('Slideshow → next', statusEl, proto.buildView(proto.VIEW.PICTURE), { gap: 1 });
  });

  // initial read-outs
  brightnessOut.textContent = controls.brightness.value + '%';
  intervalOut.textContent = intervalEl.value + 's';
  updateCounter();
  updateCurrent();
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
  persist(effect, 'lightEffect');
  persist(speed, 'lightSpeed', (el) => { speedOut.textContent = el.value; });
  persist(color, 'lightColor');

  const debounce = (fn, ms = 120) => {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  // guardedSend only writes the status line on error; add a success confirmation so the
  // built-in controls narrate like the software-FX / palette paths do.
  const sendLight = async (label, packets, okMsg) => {
    if (await guardedSend(label, statusEl, packets)) setStatus(statusEl, okMsg, 'ok');
  };

  const sendBrightness = debounce(() =>
    sendLight('Light brightness', proto.buildLightBrightness(+brightness.value), `Brightness set to ${brightness.value}.`));
  brightness.addEventListener('input', () => {
    brightnessOut.textContent = brightness.value;
    sendBrightness();
  });

  effect.addEventListener('change', () =>
    sendLight('Light effect', proto.buildLightEffect(+effect.value), `Effect: ${effect.options[effect.selectedIndex].text}.`));

  const sendSpeed = debounce(() =>
    sendLight('Light speed', proto.buildLightSpeed(+speed.value), `Effect speed set to ${speed.value}.`));
  speed.addEventListener('input', () => {
    speedOut.textContent = speed.value;
    sendSpeed();
  });

  const sendColor = debounce(() => {
    const { hue, sat } = rgbToHueSat(color.value);
    sendLight('Light color', proto.buildLightColor(hue, sat), `Color set to ${color.value}.`);
  });
  color.addEventListener('input', sendColor);

  // ---- software effects (host-driven color animation) -----------------------
  // These stream SAVE-LESS color reports (proto.buildLightColorLive) so they never touch the EEPROM;
  // only the one-time effect=Solid Color at the start of a run is persisted. Exactly one effect runs
  // at a time — Start stops any other. A setTimeout chain (not rAF) drives the per-step delay; a
  // generation token + running flag cancel it cleanly on Stop, tab-switch, or disconnect.
  const SOLID_COLOR_EFFECT = 1; // matches the "Solid Color" option in #lightEffect
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
    await sendFrame(proto.buildLightColorLive(hue, sat));
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
    const ok = await guardedSend('FX effect → Solid Color', sEl, proto.buildLightEffect(SOLID_COLOR_EFFECT));
    if (!ok) { stopFx(); return; }
    if (token !== fxToken || !fxRunning) return;  // Stop pressed during the await
    setStatus(sEl, `${name} running — press Stop to end.`, 'ok');
    let i = 0;
    const tick = async () => {
      if (token !== fxToken || !fxRunning) return;
      const { hue, sat } = frameFn(i);
      const sent = await sendFrame(proto.buildLightColorLive(hue, sat));
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

  // Manual effect/color changes take over from any running animation.
  effect.addEventListener('change', stopFx);
  color.addEventListener('input', stopFx);

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
  $('#clearPicture').addEventListener('click', async () => {
    if (!confirm('Erase ALL stored pictures on the keyboard? This cannot be undone.')) return;
    const statusEl = $('#imageStatus');
    setStatus(statusEl, 'Clearing pictures…');
    const ok = await guardedSend('Clear picture', statusEl, proto.buildClearPicture(), { gap: 2 });
    if (ok) setStatus(statusEl, 'Pictures cleared.', 'ok');
  });

  $('#clearGif').addEventListener('click', async () => {
    if (!confirm('Erase the stored GIF on the keyboard? This cannot be undone.')) return;
    const statusEl = $('#gifStatus');
    setStatus(statusEl, 'Clearing GIF…');
    const ok = await guardedSend('Clear GIF', statusEl, proto.buildClearGif(), { gap: 2 });
    if (ok) setStatus(statusEl, 'GIF cleared.', 'ok');
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
    el.textContent = keyCapLabel(kc);
    el.title = `${kc}  (row ${el.dataset.row}, col ${el.dataset.col})`;
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
    const [cw, ccw] = state.encoders[0][currentLayer];
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
        chip.innerHTML = `${it.label} <code>${it.keycode}</code>`;
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
      pickerCustom.value = state.encoders[0][currentLayer][target.cw ? 0 : 1];
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
    state.encoders[0][currentLayer][t.cw ? 0 : 1] = kc;
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
            state.encoders[0][L][cw ? 0 : 1] = keymap.numberToKeycode((r[4] << 8) | r[5]);
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
  async function pollMatrix() {
    let d;
    try {
      d = await viaTransact(proto.buildSwitchMatrixState(), (x) => x[0] === 0x02 && x[1] === 0x03, 250);
    } catch (err) {
      testerStatus.textContent = 'Tester: ' + ((err && err.message) || err);
      return;
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
    const rep = await viaTransact(proto.buildFirmwareVersion(), (d) => d[0] === 0x02 && d[1] === 0x04, 500);
    if (!rep) { $('#fwVersion').textContent = 'no reply'; setStatus(deviceStatus, 'No reply from the keyboard.', 'err'); return; }
    const ver = ((rep[2] << 24) | (rep[3] << 16) | (rep[4] << 8) | rep[5]) >>> 0;
    $('#fwVersion').textContent = `firmware v${ver}`;
    setStatus(deviceStatus, '');
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
