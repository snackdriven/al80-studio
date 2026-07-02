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

// ---- global connected state -------------------------------------------------
let connected = false;

function reflectConnection() {
  $$('.device-action').forEach((el) => {
    el.disabled = !connected;
  });
  // if we just disconnected, stop clock sync
  if (!connected) stopClockSync();
}

// Wrap a device action: catch errors (incl. the single-opener one) and surface them.
async function guardedSend(statusEl, packets, opts = {}) {
  try {
    await hid.send(packets, { gap: 0, ...opts });
    return true;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    setStatus(statusEl, 'Send failed: ' + msg, 'err');
    return false;
  }
}

// Chunked send so we can drive a progress bar without depending on an
// undocumented progress callback in hid.send. Each chunk is an independent
// batch of 64-byte reports; gap is applied inside hid.send per its contract.
async function sendWithProgress(statusEl, packets, onFraction, opts = {}) {
  const CHUNK = 20;
  try {
    for (let i = 0; i < packets.length; i += CHUNK) {
      await hid.send(packets.slice(i, i + CHUNK), { gap: 0, ...opts });
      onFraction(Math.min(packets.length, i + CHUNK) / packets.length);
    }
    return true;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    setStatus(statusEl, 'Send failed: ' + msg, 'err');
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
  setupTabs();
  setupClockTab();
  setupImageTab();
  setupGifTab();
  setupViewTab();
  setupShortcutsTab();
  reflectConnection();
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

  hid.onStatus((s) => {
    const n = normalizeStatus(s);
    connected = n.connected;
    dot.dataset.state = n.connected ? 'connected' : (n.state === 'error' ? 'error' : 'disconnected');
    text.textContent = n.text;
    btn.textContent = n.connected ? 'Disconnect' : 'Connect';
    reflectConnection();
  });

  btn.addEventListener('click', async () => {
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
    }
  });

  // Reflect an already-open device (e.g. after reload with a granted device).
  try {
    if (hid.getDevice && hid.getDevice()) {
      connected = true;
      reflectConnection();
    }
  } catch { /* ignore */ }
}

// ---- tabs -------------------------------------------------------------------
function setupTabs() {
  const tabs = $$('.tab');
  const panels = $$('.panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      panels.forEach((p) => {
        p.hidden = p.dataset.panel !== name;
      });
    });
  });
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
}

function setupClockTab() {
  const statusEl = $('#clockStatus');
  const is12 = $('#clock12hr');

  // default to now
  const now = new Date();
  $('#clockTime').value = now.toTimeString().slice(0, 8);
  $('#clockDate').value = now.toISOString().slice(0, 10);

  async function sendOnce(useNow = false) {
    const date = useNow ? new Date() : readClockDate();
    const packets = proto.clockFromDate(date, is12.checked);
    setStatus(statusEl, 'Sending clock…');
    const ok = await guardedSend(statusEl, packets, { gap: 1 });
    if (ok) setStatus(statusEl, 'Clock set to ' + date.toLocaleTimeString(), 'ok');
  }

  $('#clockSendOnce').addEventListener('click', () => sendOnce(false));

  $('#clockSync').addEventListener('change', (e) => {
    if (e.target.checked) {
      sendOnce(true);
      clockSyncTimer = setInterval(() => sendOnce(true), 60000);
      setStatus(statusEl, 'Syncing every 60s…', 'ok');
    } else {
      stopClockSync();
      setStatus(statusEl, 'Sync stopped.');
    }
  });
}

// ---- image ------------------------------------------------------------------
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

  let previewTimer = null;
  async function refreshPreview() {
    if (!currentFile) return;
    try {
      const url = await image.previewDataURL(currentFile, readOpts());
      previewImg.src = url;
    } catch (err) {
      setStatus(statusEl, 'Preview failed: ' + ((err && err.message) || err), 'err');
    }
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 120);
  }

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

  // send
  const wrap = $('#imageProgressWrap');
  const bar = $('#imageProgress');
  $('#imageSend').addEventListener('click', async () => {
    if (!currentFile) { setStatus(statusEl, 'Pick an image first.', 'err'); return; }
    setStatus(statusEl, 'Rendering frame…');
    let frame;
    try {
      frame = await image.imageToFrame(currentFile, readOpts());
    } catch (err) {
      setStatus(statusEl, 'Render failed: ' + ((err && err.message) || err), 'err');
      return;
    }
    let packets;
    try {
      packets = proto.buildImageTransfer(frame);
    } catch (err) {
      setStatus(statusEl, 'Build failed: ' + ((err && err.message) || err), 'err');
      return;
    }
    wrap.hidden = false;
    bar.style.width = '0%';
    setStatus(statusEl, `Sending ${packets.length} packets…`);
    const ok = await sendWithProgress(statusEl, packets, (f) => {
      bar.style.width = Math.round(f * 100) + '%';
    }, { gap: 0 });
    if (ok) {
      // The upload only lands in the picture slot — switch the LCD to the picture
      // view so it's actually shown (otherwise you keep seeing the clock).
      setStatus(statusEl, 'Showing image…');
      await sendWithProgress(statusEl, proto.buildView(proto.VIEW.PICTURE), () => {}, { gap: 1 });
      setStatus(statusEl, 'Image sent and displayed.', 'ok');
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
  let currentFile = null;

  fps.addEventListener('input', () => { fpsOut.textContent = fps.value; });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    currentFile = file;
    nameEl.textContent = file.name;
    countEl.textContent = 'Counting frames…';
    try {
      const n = await gif.gifFrameCount(file);
      countEl.textContent = `${n} frame${n === 1 ? '' : 's'}`;
    } catch (err) {
      countEl.textContent = 'Could not read frames: ' + ((err && err.message) || err);
    }
  });

  const wrap = $('#gifProgressWrap');
  const bar = $('#gifProgress');
  $('#gifSend').addEventListener('click', async () => {
    if (!currentFile) { setStatus(statusEl, 'Pick a GIF first.', 'err'); return; }
    setStatus(statusEl, 'Decoding GIF…');
    let frames;
    try {
      frames = await gif.gifToFrames(currentFile, { maxFrames: 60 });
    } catch (err) {
      setStatus(statusEl, 'Decode failed: ' + ((err && err.message) || err), 'err');
      return;
    }
    let packets;
    try {
      packets = proto.buildGifTransfer(frames, +fps.value);
    } catch (err) {
      setStatus(statusEl, 'Build failed: ' + ((err && err.message) || err), 'err');
      return;
    }
    wrap.hidden = false;
    bar.style.width = '0%';
    setStatus(statusEl, `Sending ${packets.length} packets (${frames.length} frames)…`);
    const ok = await sendWithProgress(statusEl, packets, (f) => {
      bar.style.width = Math.round(f * 100) + '%';
    }, { gap: 0 });
    if (ok) {
      setStatus(statusEl, 'Showing GIF…');
      await sendWithProgress(statusEl, proto.buildView(proto.VIEW.GIF), () => {}, { gap: 1 });
      setStatus(statusEl, 'GIF sent and displayed (experimental).', 'ok');
    }
    setTimeout(() => { wrap.hidden = true; }, 800);
  });
}

// ---- view -------------------------------------------------------------------
function setupViewTab() {
  const statusEl = $('#viewStatus');

  async function switchView(type, label) {
    setStatus(statusEl, `Switching to ${label}…`);
    const ok = await guardedSend(statusEl, proto.buildView(type), { gap: 1 });
    if (ok) setStatus(statusEl, `Now showing ${label}.`, 'ok');
  }

  $('#viewHome').addEventListener('click', () => switchView(proto.VIEW.HOMEPAGE, 'Homepage'));
  $('#viewPicture').addEventListener('click', () => switchView(proto.VIEW.PICTURE, 'Picture'));
  $('#viewGif').addEventListener('click', () => switchView(proto.VIEW.GIF, 'GIF'));

  $('#clearPicture').addEventListener('click', async () => {
    if (!confirm('Erase ALL stored pictures on the keyboard? This cannot be undone.')) return;
    setStatus(statusEl, 'Clearing pictures…');
    const ok = await guardedSend(statusEl, proto.buildClearPicture(), { gap: 2 });
    if (ok) setStatus(statusEl, 'Pictures cleared.', 'ok');
  });

  $('#clearGif').addEventListener('click', async () => {
    if (!confirm('Erase the stored GIF on the keyboard? This cannot be undone.')) return;
    setStatus(statusEl, 'Clearing GIF…');
    const ok = await guardedSend(statusEl, proto.buildClearGif(), { gap: 2 });
    if (ok) setStatus(statusEl, 'GIF cleared.', 'ok');
  });
}

// ---- shortcuts --------------------------------------------------------------
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

function setupShortcutsTab() {
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
