/**
 * background/sw.js  –  MV3 Service Worker  (browser-whiskor v3)
 *
 * Responsibilities:
 *   1. Maintain WebSocket to local server (with keepalive)
 *   2. Receive data from injected scripts via bridge.js → forward to server
 *   3. Receive commands from server → execute in page (actions, screenshot, config)
 *   4. Manage DevTools panel ports
 *   5. Handle tab lifecycle (close, navigate)
 */
'use strict';

// ── App Isolation (optional) ──────────────────────────────────────────────────
// To isolate this extension instance from others sharing the same server,
// set APP_ID to a unique string and configure the same id in config.json
// under appIsolation.apps[]. Leave empty for default public (shared) access.
const APP_ID    = '';
const APP_TOKEN = '';

const WS_URL       = 'ws://127.0.0.1:7891';
const RECONNECT_MS = 3000;
const PING_MS      = 20000;   // keepalive ping interval
const QUEUE_MAX    = 500;

let ws      = null;
let wsReady = false;
const queue = [];
const pendingPageActions = new Map(); // tabId -> [{listenerId, timeout, reject}]
const PAGE_ACTION_TIMEOUT = 15000;

// ── Set-of-Marks: Draw numbered markers on screenshot ────────────────────────
const panelPorts = new Map(); // tabId → port
let pingTimer = null;

// Secret-guard screenshot masking is now done on the captured image (canvas) in
// maskDataUrl — no page overlay, so the user's screen doesn't flicker. The old
// in-page drawWhiskorMasks/removeWhiskorMasks were removed (git history keeps them).

// ── Adaptive Collection Scheduler ─────────────────────────────────────────────
// Periodically fires MANUAL_COLLECT to whiskor-active tabs from the Service
// Worker — so the timing logic lives in the long-running SW, not in the
// ephemeral MAIN-world collector.js (which is destroyed on each navigation).
//
// Design: two-speed cadence.
//   • active     — fast interval while the page is observed as changing
//   • quiescent  — slow interval after quiescentAfterMs of inactivity
//
// A tab is "watched" the first time we receive a collector message from it
// (i.e. whiskor is injected and running).  The scheduler stops cleanly when
// the WebSocket disconnects and resumes when it reconnects.
//
// Configured via config.json → adaptiveCollection.  Default: disabled.

const SCHEDULER_DEFAULTS = {
  enabled:              false,
  activeIntervalMs:     5000,
  quiescentIntervalMs:  30000,
  quiescentAfterMs:     60000,
};

class CollectionScheduler {
  constructor() {
    this._cfg  = { ...SCHEDULER_DEFAULTS };
    // tabId → { timer: TimeoutId|null, lastActivityAt: number, quiescent: bool }
    this._tabs = new Map();
  }

  /** Apply a new config subset (called on SET_CONFIG / CONFIG_FROM_PANEL). */
  configure(cfg = {}) {
    const prev = this._cfg;
    this._cfg  = { ...SCHEDULER_DEFAULTS, ...cfg };
    const changed =
      this._cfg.enabled            !== prev.enabled            ||
      this._cfg.activeIntervalMs   !== prev.activeIntervalMs   ||
      this._cfg.quiescentIntervalMs !== prev.quiescentIntervalMs;
    if (changed) {
      for (const tabId of this._tabs.keys()) this._restart(tabId);
    }
  }

  /** Start tracking a tab (idempotent). */
  watchTab(tabId) {
    if (this._tabs.has(tabId)) return;
    this._tabs.set(tabId, { timer: null, lastActivityAt: Date.now(), quiescent: false });
    this._restart(tabId);
  }

  /** Stop tracking a tab and clear its timer. */
  unwatchTab(tabId) {
    const state = this._tabs.get(tabId);
    if (state?.timer != null) clearTimeout(state.timer);
    this._tabs.delete(tabId);
  }

  /** Signal page activity (navigation, incoming data).  Resumes active cadence. */
  markActive(tabId) {
    const state = this._tabs.get(tabId);
    if (!state) return;
    const wasQuiescent    = state.quiescent;
    state.lastActivityAt  = Date.now();
    state.quiescent       = false;
    if (wasQuiescent) this._restart(tabId); // resume fast cadence immediately
  }

  /** Stop all timers (e.g. WS disconnect). */
  stopAll() {
    for (const tabId of [...this._tabs.keys()]) this.unwatchTab(tabId);
  }

  // ── private ──────────────────────────────────────────────────────────────

  _restart(tabId) {
    const state = this._tabs.get(tabId);
    if (!state) return;
    if (state.timer != null) { clearTimeout(state.timer); state.timer = null; }
    if (!this._cfg.enabled) return;
    const delay = state.quiescent
      ? this._cfg.quiescentIntervalMs
      : this._cfg.activeIntervalMs;
    state.timer = setTimeout(() => this._tick(tabId), delay);
  }

  _tick(tabId) {
    const state = this._tabs.get(tabId);
    if (!state || !this._cfg.enabled) return;
    state.timer = null;

    chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.postMessage(
        { __BROWSER_WHISKOR__: true, type: 'MANUAL_COLLECT', payload: {} }, '*'
      ),
      world: 'MAIN',
    }).catch(() => {});

    // Transition to quiescent cadence after prolonged inactivity
    if (!state.quiescent && (Date.now() - state.lastActivityAt) >= this._cfg.quiescentAfterMs) {
      state.quiescent = true;
    }

    this._restart(tabId); // schedule the next tick
  }
}

const collectionScheduler = new CollectionScheduler();


async function cropImage(dataUrl, rect, padding, format, quality, dpr = 1, maxPx = 0) {
  // MV3 service workers have no Image/document — decode the captured PNG via
  // fetch → blob → createImageBitmap instead of `new Image()`.
  const srcBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(srcBlob);
  try {
    const imgW = bitmap.width;
    const imgH = bitmap.height;
    // captureVisibleTab renders at CSS-px × devicePixelRatio; getBoundingClientRect
    // is in CSS px. Scale crop coords by the page's real dpr (passed from the page).
    const scale = dpr || 1;

    const sx = Math.max(0, Math.round((rect.x - padding) * scale));
    const sy = Math.max(0, Math.round((rect.y - padding) * scale));
    const sw = Math.min(imgW - sx, Math.round((rect.w + padding * 2) * scale));
    const sh = Math.min(imgH - sy, Math.round((rect.h + padding * 2) * scale));

    if (sw <= 0 || sh <= 0) {
      throw new Error('Crop region is outside the visible viewport');
    }

    // Optionally downscale to a thumbnail by capping the longer side to maxPx —
    // crop + downscale in one drawImage (no second decode/encode pass).
    let dw = sw, dh = sh;
    if (maxPx && Math.max(sw, sh) > maxPx) {
      const k = maxPx / Math.max(sw, sh);
      dw = Math.max(1, Math.round(sw * k));
      dh = Math.max(1, Math.round(sh * k));
    }
    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);

    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blobOpts = format === 'jpeg'
      ? { type: mimeType, quality: (quality ?? 85) / 100 }
      : { type: mimeType };

    const outBlob = await canvas.convertToBlob(blobOpts);
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror   = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(outBlob);
    });
  } finally {
    bitmap.close?.();
  }
}

// Downscale a screenshot dataUrl to cap its width, re-encoding in the given format.
// Service workers have no Image/document, so decode via fetch → blob → createImageBitmap.
async function downscaleDataUrl(dataUrl, maxWidth, format, quality) {
  const srcBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(srcBlob);
  try {
    if (!maxWidth || bitmap.width <= maxWidth) return dataUrl;
    const scale = maxWidth / bitmap.width;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const blobOpts = format === 'png' ? { type: mime } : { type: mime, quality: (quality ?? 70) / 100 };
    const outBlob = await canvas.convertToBlob(blobOpts);
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror   = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(outBlob);
    });
  } finally {
    bitmap.close?.();
  }
}

// Secret-guard masking v2: black out redacted regions ON the captured image so the
// user's screen never flickers (vs. drawing a DOM overlay on the live page). Rects
// are document coords; convert to viewport-image px via the current scroll + dpr.
async function maskDataUrl(dataUrl, rects, dpr, scrollX, scrollY, format, quality) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = '#000';
    for (const r of (rects || [])) {
      const x = Math.round((r.x - (scrollX || 0)) * dpr);
      const y = Math.round((r.y - (scrollY || 0)) * dpr);
      ctx.fillRect(x, y, Math.ceil(r.width * dpr), Math.ceil(r.height * dpr));
    }
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const blobOpts = format === 'png' ? { type: mime } : { type: mime, quality: (quality ?? 70) / 100 };
    const outBlob = await canvas.convertToBlob(blobOpts);
    return await _blobToDataURL(outBlob);
  } finally {
    bitmap.close?.();
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWs() {
  let wsTarget = WS_URL;
  if (APP_ID) {
    wsTarget += `?appId=${encodeURIComponent(APP_ID)}&token=${encodeURIComponent(APP_TOKEN)}`;
  }
  try { ws = new WebSocket(wsTarget); }
  catch (e) { scheduleReconnect(); return; }

  const connectTimer = setTimeout(() => {
    if (ws && ws.readyState !== WebSocket.OPEN) {
      ws.close();
    }
  }, 3000);

  ws.addEventListener('open', () => {
    clearTimeout(connectTimer);
    wsReady = true;
    broadcastToPanels({ type: 'SERVER_STATUS', connected: true });
    while (queue.length) ws.send(queue.shift());
    startPing();
    console.log('[SI] Server connected');
  });

  ws.addEventListener('close', () => {
    clearTimeout(connectTimer);
    wsReady = false;
    ws = null;
    stopPing();
    collectionScheduler.stopAll();
    broadcastToPanels({ type: 'SERVER_STATUS', connected: false });
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    clearTimeout(connectTimer);
    wsReady = false;
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleServerMessage(msg);
  });
}

function scheduleReconnect() { setTimeout(connectWs, RECONNECT_MS); }

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (wsReady && ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'PING', ts: Date.now() }));
    }
  }, PING_MS);
}
function stopPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

function sendToServer(data) {
  const raw = JSON.stringify(data);
  if (wsReady && ws?.readyState === 1) {
    try { ws.send(raw); return; }
    catch { wsReady = false; }
  }
  if (queue.length < QUEUE_MAX) queue.push(raw);
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) connectWs();
}

// ── Element collection for capture markers ────────────────────────────────────
function collectElements() {
  function _hasRealEffect(el) {
    var t = el.tagName.toLowerCase();
    var href = el.getAttribute('href');
    var type = (el.getAttribute('type') || '').toLowerCase();
    var role = el.getAttribute('role');
    if (t === 'a' && href && href !== '#' && !href.startsWith('javascript:')) return true;
    if ((t === 'button' || t === 'input') && (type === 'submit' || type === 'reset' || type === 'image' || type === 'file')) return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('onsubmit') || el.hasAttribute('onchange') || el.hasAttribute('oninput') || el.hasAttribute('onkeydown')) return true;
    if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem' || role === 'option' || role === 'switch' || role === 'checkbox' || role === 'radio' || role === 'combobox') return true;
    if (el.hasAttribute('aria-haspopup')) return true;
    if (t === 'input' && (!type || type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === 'tel' || type === 'number' || type === 'password')) return true;
    if (t === 'textarea' || t === 'select') return true;
    if (el.hasAttribute('data-action') || el.hasAttribute('data-command') || el.hasAttribute('data-href') || el.hasAttribute('data-toggle')) return true;
    if (el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked') || el.hasAttribute('aria-selected')) return true;
    if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
    if (el.hasAttribute('aria-label')) return true;
    return t === 'button' || t === 'a';
  }

  var els = [];
  var nodes = document.querySelectorAll(
    'button, a, [role=button], [role=link], input, select, textarea, [aria-label], [onclick], [tabindex]:not([tabindex="-1"])'
  );
  var idx = 0;
  var seen = new Set();
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    var tag = el.tagName.toLowerCase();
    var text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 80);
    if (!text && tag !== 'input' && tag !== 'select' && tag !== 'textarea') continue;
    idx++;
    if (!_hasRealEffect(el)) continue;
    var hrefAttr = el.getAttribute('href');
    var selector = '';
    if (el.id) {
      selector = '#' + el.id;
    } else if (el.className && typeof el.className === 'string') {
      var cls = el.className.trim().split(/\s+/).filter(function(c) { return c; }).slice(0, 2).join('.');
      selector = tag + (cls ? '.' + cls : '');
    } else {
      selector = tag;
    }
    var key = tag + ':' + Math.round(rect.left) + ':' + Math.round(rect.top);
    if (seen.has(key)) { idx--; continue; }
    seen.add(key);
    var kind = 'action';
    if (tag === 'a' && hrefAttr && hrefAttr !== '#' && !hrefAttr.startsWith('javascript:')) kind = 'nav';
    else if (el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked') || el.hasAttribute('aria-selected')) kind = 'toggle';
    els.push({
      id: idx,
      tag: tag,
      text: text,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      selector: selector,
      kind: kind
    });
  }
  return { elements: els, vpWidth: window.innerWidth, vpHeight: window.innerHeight };
}

// ── Packed Set-of-Marks: crop interactive elements from one viewport bitmap and
// pack them into a single numbered image (OffscreenCanvas — available in MV3 SW).
// See docs/ideas/PACKED_SOM_CAPTURE.md.
async function _blobToDataURL(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(binary);
}

function _kindFromTag(tag) {
  if (tag === 'a') return 'link';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'input';
  return 'button';
}

async function buildPackedSom(tabId, windowId, opts) {
  const max = (opts && opts.max) || 40;
  const cellMax = (opts && opts.cellMaxPx) || 96;
  const types = opts && opts.types;

  // Interactive elements (reuse collectElements) + the page's devicePixelRatio.
  let elements = [];
  for (const world of ['MAIN', 'ISOLATED']) {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, func: collectElements, world });
      elements = (r && r[0] && r[0].result && r[0].result.elements) || [];
      if (elements.length) break;
    } catch (_) { /* try the other world */ }
  }
  let dpr = 1;
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => window.devicePixelRatio || 1 });
    dpr = (r && r[0] && r[0].result) || 1;
  } catch (_) {}

  let els = elements.filter((e) => e.w >= 2 && e.h >= 2);
  if (types && types.length) els = els.filter((e) => types.includes(_kindFromTag(e.tag)));
  els = els.slice(0, max);
  if (!els.length) return { dataUrl: null, marks: [], width: 0, height: 0 };

  // Capture the viewport once (CSS-px × dpr) and decode to a bitmap.
  const shotUrl = await chrome.tabs.captureVisibleTab(windowId || undefined, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(shotUrl)).blob());

  // Shelf-pack: each element scaled to fit cellMax, wrapped at MAXW.
  const PAD = 4, MAXW = 800;
  const cells = els.map((e) => {
    const scale = Math.min(1, cellMax / Math.max(e.w, e.h, 1));
    return { e, dw: Math.max(8, Math.round(e.w * scale)), dh: Math.max(8, Math.round(e.h * scale)) };
  });
  let cx = PAD, cy = PAD, rowH = 0, usedW = 0;
  for (const c of cells) {
    if (cx + c.dw + PAD > MAXW && cx > PAD) { cx = PAD; cy += rowH + PAD; rowH = 0; }
    c.dx = cx; c.dy = cy;
    cx += c.dw + PAD; rowH = Math.max(rowH, c.dh); usedW = Math.max(usedW, cx);
  }
  const W = Math.min(MAXW, usedW + PAD), H = cy + rowH + PAD;

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1e1e1e'; ctx.fillRect(0, 0, W, H);
  // emitThumbs: also crop each element into its own small jpeg from the SAME
  // bitmap (no extra captureVisibleTab), so the server can warm the per-element
  // thumbnail cache (prefetch) for free. Off unless the server asks for it.
  const emitThumbs = !!(opts && opts.emitThumbs);
  const marks = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i], n = i + 1, e = c.e;
    const sx = (e.x - e.w / 2) * dpr, sy = (e.y - e.h / 2) * dpr, sw = e.w * dpr, sh = e.h * dpr;
    try { ctx.drawImage(bitmap, sx, sy, sw, sh, c.dx, c.dy, c.dw, c.dh); } catch (_) {}
    ctx.fillStyle = 'rgba(255,70,70,0.92)'; ctx.fillRect(c.dx, c.dy, 16, 13);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textBaseline = 'top';
    ctx.fillText(String(n), c.dx + 3, c.dy + 2);
    const mark = { n, text: e.text, selector: e.selector, rect: { x: Math.round(e.x - e.w / 2), y: Math.round(e.y - e.h / 2), w: e.w, h: e.h } };
    if (emitThumbs) {
      try {
        const tcv = new OffscreenCanvas(c.dw, c.dh);
        const tctx = tcv.getContext('2d');
        tctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, c.dw, c.dh);
        mark.thumb = await _blobToDataURL(await tcv.convertToBlob({ type: 'image/jpeg', quality: 0.6 }));
      } catch (_) { /* best-effort thumbnail */ }
    }
    marks.push(mark);
  }

  const dataUrl = await _blobToDataURL(await canvas.convertToBlob({ type: 'image/png' }));
  return { dataUrl, marks, width: W, height: H };
}

// ── Server → Extension commands ───────────────────────────────────────────────

async function handleServerMessage(msg) {
  switch (msg.type) {

    case 'SET_CONFIG': {
      await chrome.storage.local.set({ SI_CONFIG: msg.config });
      collectionScheduler.configure(msg.config?.adaptiveCollection);
      // Push config into every open tab
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (cfg) => window.postMessage({ __BROWSER_WHISKOR__: true, type: 'CONFIG_UPDATE', payload: cfg }, '*'),
          args: [msg.config],
          world: 'MAIN',
        }).catch(() => {});
      }
      broadcastToPanels({ type: 'CONFIG_UPDATED', config: msg.config });
      break;
    }

    case 'MANUAL_COLLECT': {
      const tabId   = msg.tabId;
      const plugins = msg.plugins || null;
      const targets = tabId ? [{ id: tabId }] : await chrome.tabs.query({ active: true });
      for (const tab of targets) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (pl) => window.postMessage({ __BROWSER_WHISKOR__: true, type: 'MANUAL_COLLECT', payload: { plugins: pl } }, '*'),
          args: [plugins],
          world: 'MAIN',
        }).catch(() => {});
      }
      break;
    }

    case 'EXECUTE_ACTION': {
      const { actionId, tabId, action } = msg;
      if (!action || !action.type) {
        sendToServer({ type: 'ACTION_RESULT', actionId, ok: false, error: 'Action must have a "type" property' });
        break;
      }
      try {
        let result;

        switch (action.type) {

          case 'navigate':
            try {
              await chrome.tabs.update(tabId, { url: action.url });
            } catch (_) {
              // Chrome race: tabs.update can throw "No tab with id" even when
              // navigation starts (e.g. tab reloading). Verify tab exists.
              try { await chrome.tabs.get(tabId); } catch { throw _; }
            }
            result = { navigating: true, url: action.url };
            break;

          case 'go_back':
            await chrome.tabs.goBack(tabId);
            result = { ok: true };
            break;

          case 'go_forward':
            await chrome.tabs.goForward(tabId);
            result = { ok: true };
            break;

          case 'reload':
            await chrome.tabs.reload(tabId, { bypassCache: !!action.hard });
            result = { ok: true };
            break;

          case 'create_tab':
            const newTab = await chrome.tabs.create({ url: action.url || 'about:blank' });
            result = { ok: true, tabId: newTab.id, url: newTab.url };
            break;

          case 'list_tabs': {
            const query = action.currentWindowOnly ? { currentWindow: true } : {};
            const tabs = await chrome.tabs.query(query);
            result = {
              ok: true,
              tabs: tabs.map(t => ({
                tabId:    t.id,
                url:      t.url || t.pendingUrl || '',
                title:    t.title || '',
                active:   !!t.active,
                windowId: t.windowId,
                index:    t.index,
                status:   t.status || null,
                pinned:   !!t.pinned,
                audible:  !!t.audible,
              })),
            };
            break;
          }

          case 'switch_tab': {
            const target = await chrome.tabs.update(action.targetTabId, { active: true });
            try { await chrome.windows.update(target.windowId, { focused: true }); } catch (_) {}
            result = { ok: true, tabId: target.id, url: target.url || '', title: target.title || '' };
            break;
          }

          case 'open_tab': {
            const opened = await chrome.tabs.create({
              url: action.url || 'about:blank',
              active: action.active !== false,
            });
            result = { ok: true, tabId: opened.id, url: opened.url || opened.pendingUrl || (action.url || 'about:blank') };
            break;
          }

          case 'close_tab': {
            await chrome.tabs.remove(action.targetTabId);
            result = { ok: true, closedTabId: action.targetTabId };
            break;
          }

          case 'set_viewport':
            await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, {
              width: action.width,
              height: action.height,
            });
            result = { ok: true, width: action.width, height: action.height };
            break;

          case 'get_xml': {
            const results = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => new XMLSerializer().serializeToString(document),
              world: 'MAIN',
            });
            result = { xml: results?.[0]?.result || '' };
            break;
          }

          default:
            if (CDP_AVAILABLE && action.inputMode && action.inputMode !== 'off' &&
                (action.type === 'click' || action.type === 'type' || action.type === 'press_key')) {
              // High-fidelity (CDP) input path — see executeHighFidelity.
              result = await executeHighFidelity(tabId, action);
            } else {
              // Delegate to injected executor.js (synthetic events)
              result = await executeInPage(tabId, action);
            }
        }

        sendToServer({ type: 'ACTION_RESULT', actionId, ok: true, result });
      } catch (e) {
        if (isTabGone(e)) {
          sendToServer({ type: 'ACTION_RESULT', actionId, ...(await tabGoneInfo(tabId)) });
        } else {
          sendToServer({ type: 'ACTION_RESULT', actionId, ok: false, error: e.message });
        }
      }
      break;
    }

    case 'CAPTURE_SCREENSHOT': {
      const { reqId, tabId, opts } = msg;
      try {
        let windowId;
        try { windowId = (await chrome.tabs.get(tabId)).windowId; } catch (_) { windowId = null; }
        if (windowId == null) {
          sendToServer({ type: 'SCREENSHOT_RESULT', reqId, ...(await tabGoneInfo(tabId)) });
          break;
        }

        let elements = null, vpWidth = null, vpHeight = null;
        if (opts?.marks && windowId) {
          let lastErr = null;
          for (const world of ['MAIN', 'ISOLATED']) {
            try {
              const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: collectElements,
                world: world,
              });
              const r = results?.[0]?.result || {};
              elements = r.elements || [];
              vpWidth  = r.vpWidth  || null;
              vpHeight = r.vpHeight || null;
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e;
            }
          }
          if (lastErr) {
            console.warn('[capture] collectElements failed in both MAIN and ISOLATED world:', lastErr.message);
          }
        }

        const fmt = opts?.format === 'png' ? 'png' : 'jpeg';
        const captureOpts = fmt === 'jpeg'
          ? { format: 'jpeg', quality: typeof opts?.quality === 'number' ? opts.quality : 70 }
          : { format: 'png' };

        let dataUrl = await chrome.tabs.captureVisibleTab(windowId || undefined, captureOpts);

        // Secret guard: black out redacted regions ON THE CAPTURED IMAGE (canvas),
        // not by drawing an overlay on the live page — so the user's screen never
        // flickers. Rects are document coords; convert to viewport-image px with the
        // current scroll + dpr.
        if (Array.isArray(opts?.maskRects) && opts.maskRects.length && windowId) {
          try {
            const vp = await chrome.scripting.executeScript({
              target: { tabId }, world: 'MAIN',
              func: () => ({ dpr: window.devicePixelRatio || 1, sx: window.scrollX || 0, sy: window.scrollY || 0 }),
            });
            const m = (vp && vp[0] && vp[0].result) || { dpr: 1, sx: 0, sy: 0 };
            dataUrl = await maskDataUrl(dataUrl, opts.maskRects, m.dpr, m.sx, m.sy, fmt, captureOpts.quality);
          } catch (e) { console.warn('[capture] secret mask failed:', e.message); }
        }

        // Optional downscale to cap width — shrinks the base64 payload (and tokens) for
        // large/full-page screenshots. No-op when the image is already within maxWidth.
        const maxWidth = typeof opts?.maxWidth === 'number' ? opts.maxWidth : 0;
        if (maxWidth > 0) {
          try { dataUrl = await downscaleDataUrl(dataUrl, maxWidth, fmt, captureOpts.quality); } catch (_) {}
        }

        sendToServer({
          type: 'SCREENSHOT_RESULT',
          reqId,
          dataUrl: dataUrl,
          elements: elements || null,
          vpWidth:  vpWidth,
          vpHeight: vpHeight,
          capturedAt: Date.now(),
        });
      } catch (e) {
        if (isTabGone(e)) {
          sendToServer({ type: 'SCREENSHOT_RESULT', reqId, ...(await tabGoneInfo(tabId)) });
        } else {
          sendToServer({ type: 'SCREENSHOT_RESULT', reqId, error: e.message });
        }
      }
      break;
    }

    case 'CAPTURE_PACKED_SOM': {
      const { reqId, tabId, opts = {} } = msg;
      try {
        let windowId;
        try { windowId = (await chrome.tabs.get(tabId)).windowId; } catch (_) { windowId = null; }
        if (windowId == null) {
          sendToServer({ type: 'PACKED_SOM_RESULT', reqId, ...(await tabGoneInfo(tabId)) });
          break;
        }
        const packed = await buildPackedSom(tabId, windowId, opts);
        sendToServer({
          type: 'PACKED_SOM_RESULT', reqId,
          dataUrl: packed.dataUrl,
          marks:   packed.marks,
          width:   packed.width,
          height:  packed.height,
          capturedAt: Date.now(),
        });
      } catch (e) {
        if (isTabGone(e)) {
          sendToServer({ type: 'PACKED_SOM_RESULT', reqId, ...(await tabGoneInfo(tabId)) });
        } else {
          sendToServer({ type: 'PACKED_SOM_RESULT', reqId, error: e.message });
        }
      }
      break;
    }

    case 'CAPTURE_ELEMENT': {
      const { reqId, tabId, opts = {} } = msg;

      try {
        let windowId;
        try { windowId = (await chrome.tabs.get(tabId)).windowId; } catch (_) { windowId = null; }
        if (windowId == null) {
          sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId, ...(await tabGoneInfo(tabId)) });
          break;
        }
        let rect = null;
        let dpr = 1;

        // Fetch the page's real devicePixelRatio (and the element rect, if a selector
        // was given) in a single MAIN-world call. dpr cannot be read in the SW.
        if (windowId) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              func: (selector) => {
                const out = { dpr: window.devicePixelRatio || 1, rect: null };
                if (selector) {
                  const el = document.querySelector(selector);
                  if (el) {
                    const r = el.getBoundingClientRect();
                    out.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
                  }
                }
                return out;
              },
              args: [opts.selector || null],
            });
            const res = results?.[0]?.result;
            if (res) {
              dpr = res.dpr || 1;
              if (opts.selector) rect = res.rect;
            }
          } catch (_) {}
        }

        if (opts.selector && !rect) {
          sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId,
            error: `selector not found: ${opts.selector}` });
          break;
        }
        if (!rect && opts.rect) rect = opts.rect;
        if (!rect) {
          sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId,
            error: 'CAPTURE_ELEMENT requires opts.selector or opts.rect' });
          break;
        }

        const pad = typeof opts.padding === 'number' ? Math.max(0, opts.padding) : 4;
        const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
        const fullDataUrl = await chrome.tabs.captureVisibleTab(windowId || undefined, {
          format,
          quality: format === 'jpeg' ? (opts.quality ?? 85) : undefined,
        });

        const croppedDataUrl = await cropImage(fullDataUrl, rect, pad, format, opts.quality, dpr, opts.maxPx);

        sendToServer({
          type:       'ELEMENT_CAPTURE_RESULT',
          reqId,
          dataUrl:    croppedDataUrl,
          rect,
          padding:    pad,
          capturedAt: Date.now(),
        });

      } catch (e) {
        if (isTabGone(e)) {
          sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId, ...(await tabGoneInfo(tabId)) });
        } else {
          sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId, error: e.message });
        }
      }
      break;
    }

    case 'EXPLORER_CONTROL': {
      const { tabId, active, strategy } = msg;
      chrome.scripting.executeScript({
        target: { tabId },
        func: (act, strat) => window.postMessage({ __BROWSER_WHISKOR__: true, type: 'EXPLORER_CONTROL', payload: { active: act, strategy: strat } }, '*'),
        args: [active, strategy],
        world: 'MAIN',
      }).catch(() => {});
      break;
    }

    case 'EXPLORER_NEXT_ACTION': {
      const { tabId } = msg;
      chrome.scripting.executeScript({
        target: { tabId },
        func: (payload) => window.postMessage({ __BROWSER_WHISKOR__: true, type: 'EXPLORER_NEXT_ACTION', payload }, '*'),
        args: [msg.payload],
        world: 'MAIN',
      }).catch(() => {});
      break;
    }

    case 'PONG':
      break; // keepalive ack

    case 'REQUEST_STATE_HASH': {
      const { tabId, requestId, watchMode } = msg;
      chrome.scripting.executeScript({
        target: { tabId: tabId || msg.tabId },
        func: (rid, wm) => window.postMessage({ __BROWSER_WHISKOR__: true, type: 'REQUEST_STATE_HASH', requestId: rid, watchMode: wm }, '*'),
        args: [requestId, watchMode],
        world: 'MAIN',
      }).catch(() => {});
      break;
    }

    case 'CANCEL_WATCH': {
      const tabId = msg.tabId;
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.postMessage({ __BROWSER_WHISKOR__: true, type: 'CANCEL_WATCH' }, '*'),
        world: 'MAIN',
      }).catch(() => {});
      break;
    }
  }
}

// ── CDP high-fidelity input (Chromium only) ───────────────────────────────────
// Drives mouse/keyboard via the DevTools Protocol so events are isTrusted:true —
// the only way to reach widgets that gate on trusted input or user activation
// (popups, clipboard, file pickers, some payment/OAuth flows). Synthetic events
// (executor.js) stay the default; this is opt-in via config agentControl.input.
// highFidelity = 'off' | 'fallback' | 'always'. A short idle keep-alive reuses one
// attach across a burst so the "is debugging this browser" banner flashes minimally.
const CDP_AVAILABLE = typeof chrome !== 'undefined' && !!(chrome.debugger && chrome.debugger.attach);
const cdpAttached = new Set();       // tabId currently attached
const cdpDetachTimers = new Map();   // tabId → idle-detach timer
const CDP_IDLE_DETACH_MS = 1200;

function cdpSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(res);
    });
  });
}
function cdpAttach(tabId) {
  if (cdpAttached.has(tabId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      cdpAttached.add(tabId);
      resolve();
    });
  });
}
function cdpDetach(tabId) {
  if (!cdpAttached.has(tabId)) return;
  try { chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; }); } catch (_) {}
  cdpAttached.delete(tabId);
}
// Defer detach so a burst of CDP ops on the same tab reuses one attach.
function cdpKeepAlive(tabId) {
  const prev = cdpDetachTimers.get(tabId);
  if (prev) clearTimeout(prev);
  cdpDetachTimers.set(tabId, setTimeout(() => {
    cdpDetachTimers.delete(tabId);
    cdpDetach(tabId);
  }, CDP_IDLE_DETACH_MS));
}
if (CDP_AVAILABLE) {
  // If Chrome detaches us (e.g. the user opens DevTools on the tab), forget our state.
  chrome.debugger.onDetach.addListener((source) => {
    if (source && typeof source.tabId === 'number') {
      cdpAttached.delete(source.tabId);
      const t = cdpDetachTimers.get(source.tabId);
      if (t) { clearTimeout(t); cdpDetachTimers.delete(source.tabId); }
    }
  });
}

// Trusted mouse click at viewport coordinates (CSS px).
async function cdpMouseClick(tabId, x, y, opts = {}) {
  const button = opts.button === 'right' ? 'right' : opts.button === 'middle' ? 'middle' : 'left';
  const mask   = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  const clicks = opts.double ? 2 : 1;
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  for (let i = 1; i <= clicks; i++) {
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button, buttons: mask, clickCount: i });
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0,    clickCount: i });
  }
}

// Named-key descriptors for Input.dispatchKeyEvent (windowsVirtualKeyCode + code/key).
const CDP_KEYS = {
  Enter:      { code: 'Enter',      key: 'Enter',      keyCode: 13, text: '\r' },
  Tab:        { code: 'Tab',        key: 'Tab',        keyCode: 9  },
  Backspace:  { code: 'Backspace',  key: 'Backspace',  keyCode: 8  },
  Delete:     { code: 'Delete',     key: 'Delete',     keyCode: 46 },
  Escape:     { code: 'Escape',     key: 'Escape',     keyCode: 27 },
  ArrowUp:    { code: 'ArrowUp',    key: 'ArrowUp',    keyCode: 38 },
  ArrowDown:  { code: 'ArrowDown',  key: 'ArrowDown',  keyCode: 40 },
  ArrowLeft:  { code: 'ArrowLeft',  key: 'ArrowLeft',  keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  Home:       { code: 'Home',       key: 'Home',       keyCode: 36 },
  End:        { code: 'End',        key: 'End',        keyCode: 35 },
  PageUp:     { code: 'PageUp',     key: 'PageUp',     keyCode: 33 },
  PageDown:   { code: 'PageDown',   key: 'PageDown',   keyCode: 34 },
  Space:      { code: 'Space',      key: ' ',          keyCode: 32, text: ' ' },
};
// Send a trusted key (or modifier combo like "Control+a", "Shift+Tab").
async function cdpPressKey(tabId, combo) {
  const parts   = String(combo).split('+');
  const keyName = parts.pop();
  let modifiers = 0;
  if (parts.includes('Alt'))                                modifiers |= 1;
  if (parts.includes('Control') || parts.includes('Ctrl')) modifiers |= 2;
  if (parts.includes('Meta')    || parts.includes('Command')) modifiers |= 4;
  if (parts.includes('Shift'))                              modifiers |= 8;

  let base;
  if (CDP_KEYS[keyName]) base = { ...CDP_KEYS[keyName] };
  else if (keyName.length === 1) {
    base = {
      key: keyName,
      code: /[a-zA-Z]/.test(keyName) ? 'Key' + keyName.toUpperCase() : undefined,
      keyCode: keyName.toUpperCase().charCodeAt(0),
      // Only treat as text-producing when no non-shift modifier is held (so Ctrl+A is a shortcut, not "a").
      text: (modifiers & ~8) ? undefined : keyName,
    };
  } else base = { key: keyName };

  const common = { modifiers, windowsVirtualKeyCode: base.keyCode, code: base.code, key: base.key };
  await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: base.text ? 'keyDown' : 'rawKeyDown', ...common, text: base.text });
  await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

// Resolve the submit gesture for CDP. 'auto' inference is page-side only, so for
// CDP it degrades to no submit (the caller is told to specify explicitly).
function cdpSubmitKey(action) {
  const s = typeof action.submit === 'string' ? action.submit : (action.pressEnter ? 'enter' : 'none');
  if (s === 'auto' || s === 'none') return null;
  return { 'enter': 'Enter', 'shift-enter': 'Shift+Enter', 'ctrl-enter': 'Control+Enter', 'cmd-enter': 'Meta+Enter' }[s] || null;
}

// Resolve a click point (viewport CSS px) for a selector / text / absolute coords.
async function cdpResolvePoint(tabId, action) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (sel, txt, ax, ay) => {
        let el = null;
        if (sel) { try { el = document.querySelector(sel); } catch (_) {} }
        if (!el && txt) {
          const low = String(txt).toLowerCase();
          for (const n of document.querySelectorAll('button,a,input,summary,label,[role=button],[onclick],div,span,li,td,th')) {
            if (n.children.length <= 2 && (n.textContent || '').trim().toLowerCase().includes(low)) { el = n; break; }
          }
        }
        if (el) {
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
          const r = el.getBoundingClientRect();
          return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        if (ax != null && ay != null) return { ok: true, x: ax - window.scrollX, y: ay - window.scrollY };
        return { ok: false, error: 'Element not found for CDP click' };
      },
      args: [action.selector || null, action.text || null,
             action.x != null ? action.x : null, action.y != null ? action.y : null],
    });
    return (res && res[0] && res[0].result) || { ok: false, error: 'No result resolving CDP point' };
  } catch (e) {
    if (isTabGone(e)) throw e;
    return { ok: false, error: e.message };
  }
}

// Route click/type/press_key through CDP per action.inputMode ('fallback' | 'always').
// Any CDP failure degrades to the synthetic path so the action still does its best.
async function executeHighFidelity(tabId, action) {
  const mode = action.inputMode;
  try {
    if (action.type === 'click') {
      if (mode === 'always') {
        const pt = await cdpResolvePoint(tabId, action);
        if (!pt.ok) return pt;
        await cdpAttach(tabId);
        await cdpMouseClick(tabId, pt.x, pt.y, { button: action.button, double: action.double });
        cdpKeepAlive(tabId);
        return { ok: true, via: 'cdp', trusted: true, at: { x: pt.x, y: pt.y }, _note: 'Clicked via CDP (isTrusted event).' };
      }
      // fallback: synthetic first; escalate only when it landed but nothing changed.
      const syn = await executeInPage(tabId, action);
      if (syn && syn.diagnosis && syn.diagnosis.unexpectedBehavior === 'no_state_change') {
        const rect = syn.clickability && syn.clickability.rect;
        const pt = rect ? { ok: true, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : await cdpResolvePoint(tabId, action);
        if (pt.ok) {
          try {
            await cdpAttach(tabId);
            await cdpMouseClick(tabId, pt.x, pt.y, { button: action.button, double: action.double });
            cdpKeepAlive(tabId);
            return { ...syn, escalatedToCdp: true, cdpAt: { x: pt.x, y: pt.y },
                     _note: 'Synthetic click produced no state change; retried via CDP (isTrusted event).' };
          } catch (e) {
            return { ...syn, escalatedToCdp: false, cdpError: e.message,
                     _note: `Synthetic click had no effect; CDP escalation failed (${e.message}). Is DevTools open on this tab?` };
          }
        }
      }
      return syn;
    }

    if (action.type === 'type') {
      if (mode === 'always') {
        if (action.selector) { try { await executeInPage(tabId, { type: 'focus', selector: action.selector }); } catch (_) {} }
        await cdpAttach(tabId);
        if (action.clear) { await cdpPressKey(tabId, 'Control+a'); await cdpPressKey(tabId, 'Delete'); }
        if (action.text) await cdpSend(tabId, 'Input.insertText', { text: String(action.text) });
        const submitKey = cdpSubmitKey(action);
        if (submitKey) await cdpPressKey(tabId, submitKey);
        cdpKeepAlive(tabId);
        return { ok: true, via: 'cdp', trusted: true, typedLength: (action.text || '').length,
                 submitted: submitKey || undefined,
                 ...(typeof action.submit === 'string' && action.submit === 'auto'
                     ? { _hint: "submit:'auto' is page-side only; CDP did not submit. Pass submit:'enter' (etc.) explicitly." } : {}),
                 _note: 'Typed via CDP Input.insertText (isTrusted).' };
      }
      // fallback: typing has no reliable post-hoc failure signal, so synthetic only.
      const syn = await executeInPage(tabId, action);
      return { ...syn, _hint: "type fallback stays synthetic; set agentControl.input.highFidelity='always' for trusted typing." };
    }

    if (action.type === 'press_key') {
      if (mode === 'always') {
        await cdpAttach(tabId);
        await cdpPressKey(tabId, action.key);
        cdpKeepAlive(tabId);
        return { ok: true, via: 'cdp', trusted: true, key: action.key, _note: 'Key sent via CDP (isTrusted).' };
      }
      const syn = await executeInPage(tabId, action);
      return { ...syn, _hint: "press_key fallback stays synthetic; set highFidelity='always' for trusted keys." };
    }

    // Unhandled type — should not happen (caller gates on type).
    return executeInPage(tabId, action);
  } catch (e) {
    if (isTabGone(e)) throw e;
    const syn = await executeInPage(tabId, action).catch(() => null);
    return syn
      ? { ...syn, cdpError: e.message, _note: `CDP input path failed (${e.message}); used synthetic fallback.` }
      : { ok: false, error: `High-fidelity input failed: ${e.message}` };
  }
}

// Execute action in MAIN world via scripting API
function executeInPage(tabId, action) {
  return new Promise((resolve, reject) => {
    const listenerId = crypto.randomUUID();
    let settled = false;

    function finish(ok, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      try { chrome.webNavigation.onCommitted.removeListener(navListener); } catch (_) {}
      cleanupPageAction(tabId, listenerId);
      if (ok) resolve(value); else reject(value);
    }

    const timeout = setTimeout(() => {
      finish(false, new Error(`Page action timeout: ${action.type}`));
    }, PAGE_ACTION_TIMEOUT);

    function listener(message) {
      if (message.type === 'ACTION_COMPLETE' && message.listenerId === listenerId) {
        if (message.ok) finish(true, message.result);
        else finish(false, new Error(message.error || 'Action failed'));
      }
    }

    // A full-page navigation tears down the MAIN-world context before it can post
    // ACTION_COMPLETE back; without this the promise would hang until PAGE_ACTION_TIMEOUT
    // and the action (e.g. a click on a link/router target) would be reported as a
    // failure even though it clearly took effect. Treat an in-flight main-frame
    // navigation as a soft success. SPA pushState transitions keep the context alive and
    // reply via ACTION_COMPLETE, so they never reach here (onCommitted = document loads).
    function navListener(details) {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      finish(true, {
        navigated: true,
        url: details.url,
        _note: 'Action triggered a page navigation; the in-page result was not awaited because the page context was replaced.',
      });
    }

    if (!pendingPageActions.has(tabId)) pendingPageActions.set(tabId, []);
    pendingPageActions.get(tabId).push({ listenerId, timeout, reject });
    chrome.runtime.onMessage.addListener(listener);
    try { chrome.webNavigation.onCommitted.addListener(navListener); } catch (_) {}

    chrome.scripting.executeScript({
      target: { tabId },
      func: (act, lid) => {
        window.postMessage({ __BROWSER_WHISKOR__: true, type: 'EXECUTE_ACTION_IN_PAGE', payload: act, listenerId: lid }, '*');
      },
      args: [action, listenerId],
      world: 'MAIN',
    }).catch((e) => {
      finish(false, e);
    });
  });
}

function cleanupPageAction(tabId, listenerId) {
  const actions = pendingPageActions.get(tabId);
  if (!actions) return;
  const idx = actions.findIndex(a => a.listenerId === listenerId);
  if (idx !== -1) {
    clearTimeout(actions[idx].timeout);
    actions.splice(idx, 1);
  }
  if (actions.length === 0) pendingPageActions.delete(tabId);
}

function cleanupTabActions(tabId) {
  const actions = pendingPageActions.get(tabId);
  if (!actions) return;
  for (const a of actions) {
    clearTimeout(a.timeout);
    a.reject(new Error('Tab closed before action completed'));
  }
  pendingPageActions.delete(tabId);
}

// ── Tab-gone recovery ─────────────────────────────────────────────────────────
// Action/capture handlers target a tab by id via chrome.tabs.*; if that tab was closed
// or reloaded into a new id, Chrome throws "No tab with id: N". Turn that into an
// actionable result that lists the currently open tabs (with URLs) so the agent can
// retarget — match the URL you were on, then retry / switch_tab.
function isTabGone(e) {
  const m = (e && e.message) || String(e || '');
  return /no tab with id|no frame with id|frame .* was removed|no window with id|cannot access contents|the tab was closed/i.test(m);
}

async function tabGoneInfo(tabId) {
  let liveTabs = [];
  try {
    const tabs = await chrome.tabs.query({});
    liveTabs = tabs
      .filter(t => typeof t.id === 'number')
      .map(t => ({ tabId: t.id, url: t.url || t.pendingUrl || '', title: t.title || '', active: !!t.active }))
      .slice(0, 40);
  } catch (_) {}
  return {
    ok: false,
    tabGone: true,
    error: `Tab ${tabId} is no longer open (it was closed or reloaded and now has a different id). Pick the matching tab from liveTabs (compare the URL) and retry with that tabId, or use list_tabs / switch_tab.`,
    liveTabs,
  };
}

connectWs();

// ── Messages from content scripts ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.from !== 'collector' && message.type !== 'ACTION_COMPLETE') return;

  if (message.from === 'collector') {
    // ── CSS Origin Level 1 bridge ───────────────────────────────────────────
    // css-origin.js (MAIN world) requests DevTools resources.
    // Route to the panel port for this tab; panel.js calls getResources() and
    // replies via chrome.runtime.sendMessage back here, which we inject back.
    if (message.type === 'CSS_ORIGIN_RESOURCE_REQUEST') {
      const tabId = sender.tab?.id;
      const port  = panelPorts.get(tabId);
      if (!port) {
        // No DevTools panel open — inject empty response so css-origin falls back
        chrome.scripting.executeScript({
          target: { tabId },
          func: (reqId) => window.postMessage({
            __BROWSER_WHISKOR__: true,
            type: 'CSS_ORIGIN_RESOURCE_RESPONSE',
            reqId,
            resources: [],
          }, '*'),
          args: [message.reqId],
          world: 'MAIN',
        }).catch(() => {});
      } else {
        // Forward request to panel; panel will reply via runtime.sendMessage
        port.postMessage({ type: 'CSS_ORIGIN_RESOURCE_REQUEST', reqId: message.reqId, tabId });
      }
      return; // Don't forward to WS server
    }

    const enriched = { ...message, tabId: sender.tab?.id, frameId: sender.frameId };
    // Register this tab with the scheduler (idempotent) and mark it active so
    // the adaptive cadence resets to the fast interval.
    const senderTabId = sender.tab?.id;
    if (senderTabId != null) {
      collectionScheduler.watchTab(senderTabId);
      collectionScheduler.markActive(senderTabId);
    }
    sendToServer(enriched);
    panelPorts.get(senderTabId)?.postMessage(enriched);
  }
  // ACTION_COMPLETE is handled by the listener inside executeInPage
});

// ── CSS Origin Level 1: panel → content script reply ─────────────────────────
// devtools.js sends the getResources() result back here.
// We inject it into the MAIN world so css-origin.js's listener fires.
chrome.runtime.onMessage.addListener((message, _sender) => {
  if (message.type !== 'CSS_ORIGIN_RESOURCE_RESPONSE') return;
  const { reqId, resources, tabId } = message;
  chrome.scripting.executeScript({
    target: { tabId },
    func: (reqId, resources) => window.postMessage({
      __BROWSER_WHISKOR__: true,
      type: 'CSS_ORIGIN_RESOURCE_RESPONSE',
      reqId,
      resources,
    }, '*'),
    args: [reqId, resources],
    world: 'MAIN',
  }).catch(() => {});
});

// ── DevTools panel ports ───────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('devtools-')) return;
  const tabId = parseInt(port.name.replace('devtools-', ''), 10);
  panelPorts.set(tabId, port);
  port.postMessage({ type: 'SERVER_STATUS', connected: wsReady });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'MANUAL_COLLECT') {
      chrome.scripting.executeScript({
        target: { tabId },
        func: (pl) => window.postMessage({ __BROWSER_WHISKOR__: true, type: 'MANUAL_COLLECT', payload: { plugins: pl } }, '*'),
        args: [msg.plugins || null],
        world: 'MAIN',
      }).catch(() => {});
    }
    if (msg.type === 'SET_CONFIG') {
      chrome.storage.local.set({ SI_CONFIG: msg.config });
      collectionScheduler.configure(msg.config?.adaptiveCollection);
      sendToServer({ type: 'CONFIG_FROM_PANEL', config: msg.config });
    }
  });

  port.onDisconnect.addListener(() => panelPorts.delete(tabId));
});

function broadcastToPanels(msg) {
  for (const p of panelPorts.values()) {
    try { p.postMessage(msg); } catch (_) {}
  }
}

// ── Tab lifecycle ─────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTabActions(tabId);
  collectionScheduler.unwatchTab(tabId);
  if (CDP_AVAILABLE) {
    const t = cdpDetachTimers.get(tabId);
    if (t) { clearTimeout(t); cdpDetachTimers.delete(tabId); }
    cdpAttached.delete(tabId); // debugger auto-detaches with the tab; just drop our state
  }
  sendToServer({ type: 'TAB_CLOSED', tabId });
});

chrome.webNavigation.onCommitted.addListener(({ tabId, url, frameId }) => {
  if (frameId !== 0) return; // main frame only
  // Navigation is strong activity evidence — reset quiescent state if the tab
  // is already being watched.  (watchTab is called on first data message.)
  collectionScheduler.markActive(tabId);
  sendToServer({ type: 'PAGE_NAVIGATED', tabId, payload: { url }, from: 'sw' });
});
