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
  const gate = $('#lcdGate');
  if (gate) gate.hidden = connected;
  // if we just disconnected, stop clock sync and any running slideshow cycle
  if (!connected) {
    stopClockSync();
    slideshowCtl.stop();
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
      panels.forEach((p) => { p.hidden = p.dataset.sectionPanel !== name; });
      if (gifVisible()) gifPreviewCtl.start(); else gifPreviewCtl.stop();
      if (!slideshowVisible()) slideshowCtl.stop();
    });
  });
}

// ---- LCD content sub-tabs ----------------------------------------------------
function setupTabs() {
  const tabs = $$('.tab');
  const panels = $$('.panel[data-panel]');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
      if (name === 'gif') gifPreviewCtl.start(); else gifPreviewCtl.stop();
      if (name !== 'slideshow') slideshowCtl.stop();
    });
  });
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

  // default to now
  const now = new Date();
  $('#clockTime').value = now.toTimeString().slice(0, 8);
  $('#clockDate').value = now.toISOString().slice(0, 10);

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

  $('#clockSync').addEventListener('change', (e) => {
    if (e.target.checked) {
      sendOnce(true);
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
    const ok = await sendWithProgress(dest === 'main' ? 'Picture → main page' : 'Picture → picture page', statusEl, packets, (f) => {
      bar.style.width = Math.round(f * 100) + '%';
    }, { gap: 0 });
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
    setTimeout(() => { wrap.hidden = true; }, 800);
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
    setTimeout(() => { wrap.hidden = true; }, 800);
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

function setupKeymap() {
  const select = $('#presetSelect');
  const keycodeEl = $('#presetKeycode');
  const catalog = $('#presetCatalog');
  const statusEl = $('#keymapStatus');

  let state = keymap.emptyKeymap ? keymap.emptyKeymap() : {};
  const groups = normalizePresets(keymap.PRESETS);

  // populate dropdown (grouped via optgroup) + a flat index for keycode lookup
  const index = new Map();
  select.innerHTML = '';
  groups.forEach((g) => {
    const og = document.createElement('optgroup');
    og.label = g.group;
    g.items.forEach((it) => {
      const opt = document.createElement('option');
      opt.value = it.keycode;
      opt.textContent = it.label;
      og.appendChild(opt);
      index.set(it.keycode, it);
    });
    select.appendChild(og);
  });

  function showKeycode() {
    keycodeEl.textContent = select.value || '—';
  }
  select.addEventListener('change', showKeycode);
  showKeycode();

  // render the browsable catalog as chips
  catalog.innerHTML = '';
  groups.forEach((g) => {
    const wrap = document.createElement('div');
    wrap.className = 'preset-group';
    const h = document.createElement('h4');
    h.textContent = g.group;
    wrap.appendChild(h);
    const chips = document.createElement('div');
    chips.className = 'preset-chips';
    g.items.forEach((it) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'preset-chip';
      chip.innerHTML = `${it.label} <code>${it.keycode}</code>`;
      chip.addEventListener('click', () => {
        select.value = it.keycode;
        showKeycode();
      });
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
    catalog.appendChild(wrap);
  });

  // import
  $('#keymapImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = text; }
      state = keymap.importKeymap(payload);
      statusEl.textContent = 'Imported ' + file.name;
    } catch (err) {
      statusEl.textContent = 'Import failed: ' + ((err && err.message) || err);
    }
  });

  // export
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
      statusEl.textContent = 'Exported al80-keymap.json';
    } catch (err) {
      statusEl.textContent = 'Export failed: ' + ((err && err.message) || err);
    }
  });
}

// ---- go ---------------------------------------------------------------------
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
