/**
 * background/background.js  –  MV2 Firefox  (browser-whiskor v3)
 */
'use strict';

// ── App Isolation (optional) ──────────────────────────────────────────────────
// Set APP_ID to a unique string and configure the same id in config.json
// under appIsolation.apps[]. Leave empty for default public (shared) access.
const APP_ID    = '';
const APP_TOKEN = '';

const WS_URL       = 'ws://127.0.0.1:7891';
const RECONNECT_MS = 3000;
const PING_MS      = 20000;
const QUEUE_MAX    = 500;

let ws = null, wsReady = false;
const queue = [], panelPorts = new Map();
const pendingPageActions = new Map();
const PAGE_ACTION_TIMEOUT = 15000;
let pingTimer = null;

// ── Adaptive Collection Scheduler (Firefox MV2 mirror of sw.js version) ───────
// Identical design to the Chrome SW version — only the inject API differs:
// MV2 uses browser.tabs.executeScript({ code }) instead of chrome.scripting.

const SCHEDULER_DEFAULTS = {
  enabled:              false,
  activeIntervalMs:     5000,
  quiescentIntervalMs:  30000,
  quiescentAfterMs:     60000,
};

class CollectionScheduler {
  constructor() {
    this._cfg  = { ...SCHEDULER_DEFAULTS };
    this._tabs = new Map(); // tabId → { timer, lastActivityAt, quiescent }
  }

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

  watchTab(tabId) {
    if (this._tabs.has(tabId)) return;
    this._tabs.set(tabId, { timer: null, lastActivityAt: Date.now(), quiescent: false });
    this._restart(tabId);
  }

  unwatchTab(tabId) {
    const state = this._tabs.get(tabId);
    if (state?.timer != null) clearTimeout(state.timer);
    this._tabs.delete(tabId);
  }

  markActive(tabId) {
    const state = this._tabs.get(tabId);
    if (!state) return;
    const wasQuiescent    = state.quiescent;
    state.lastActivityAt  = Date.now();
    state.quiescent       = false;
    if (wasQuiescent) this._restart(tabId);
  }

  stopAll() {
    for (const tabId of [...this._tabs.keys()]) this.unwatchTab(tabId);
  }

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

    // Firefox MV2: inject via browser.tabs.executeScript
    browser.tabs.executeScript(tabId, {
      code: `window.postMessage({ __BROWSER_WHISKOR__: true, type: 'MANUAL_COLLECT', payload: {} }, '*');`,
    }).catch(() => {});

    if (!state.quiescent && (Date.now() - state.lastActivityAt) >= this._cfg.quiescentAfterMs) {
      state.quiescent = true;
    }
    this._restart(tabId);
  }
}

const collectionScheduler = new CollectionScheduler();


async function cropImage(dataUrl, rect, padding, format, quality, maxPx = 0) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const imgW = img.width;
        const imgH = img.height;
        const viewW = window.innerWidth || document.documentElement.clientWidth || 1920;
        const dpr = Math.round((imgW / viewW) * 10) / 10 || 1;

        const sx = Math.max(0, Math.round((rect.x - padding) * dpr));
        const sy = Math.max(0, Math.round((rect.y - padding) * dpr));
        const sw = Math.min(imgW - sx, Math.round((rect.w + padding * 2) * dpr));
        const sh = Math.min(imgH - sy, Math.round((rect.h + padding * 2) * dpr));

        if (sw <= 0 || sh <= 0) {
          reject(new Error('Crop region is outside the visible viewport'));
          return;
        }

        // Optionally downscale to a thumbnail by capping the longer side to maxPx —
        // crop + downscale in one drawImage.
        let dw = sw, dh = sh;
        if (maxPx && Math.max(sw, sh) > maxPx) {
          const k = maxPx / Math.max(sw, sh);
          dw = Math.max(1, Math.round(sw * k));
          dh = Math.max(1, Math.round(sh * k));
        }
        const canvas = document.createElement('canvas');
        canvas.width  = dw;
        canvas.height = dh;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);

        // png = lossless; jpeg/webp honor quality (webp ~smallest at similar quality).
        if (format === 'jpeg' || format === 'webp') {
          const mimeType = format === 'webp' ? 'image/webp' : 'image/jpeg';
          resolve(canvas.toDataURL(mimeType, (quality ?? 85) / 100));
        } else {
          resolve(canvas.toDataURL('image/png'));
        }
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Failed to load screenshot for crop'));
    img.src = dataUrl;
  });
}

// ── Set-of-Marks: Draw numbered markers on screenshot ────────────────────────
function connectWs() {
  let wsTarget = WS_URL;
  if (APP_ID) {
    wsTarget += `?appId=${encodeURIComponent(APP_ID)}&token=${encodeURIComponent(APP_TOKEN)}`;
  }
  try { ws = new WebSocket(wsTarget); } catch { scheduleReconnect(); return; }
  ws.addEventListener('open', () => {
    wsReady = true;
    // Version handshake — lets the server spot a stale extension (manifest
    // version tracks package.json) and ask us to reload after `whk setup`.
    try {
      ws.send(JSON.stringify({ type: 'EXT_HELLO', browser: 'firefox-mv2', version: browser.runtime.getManifest().version }));
    } catch (_) {}
    broadcastToPanels({ type: 'SERVER_STATUS', connected: true });
    while (queue.length) ws.send(queue.shift());
    startPing();
    reportTabInventory(); // tell the server which tabs exist (vs. instrumented)
  });
  ws.addEventListener('close', () => {
    wsReady = false; ws = null; stopPing();
    collectionScheduler.stopAll();
    broadcastToPanels({ type: 'SERVER_STATUS', connected: false });
    scheduleReconnect();
  });
  ws.addEventListener('error', () => { wsReady = false; });
  ws.addEventListener('message', (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMessage(msg);
  });
}

function scheduleReconnect() { setTimeout(connectWs, RECONNECT_MS); }
function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (wsReady && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'PING', ts: Date.now() }));
  }, PING_MS);
}
function stopPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

function sendToServer(data) {
  const raw = JSON.stringify(data);
  if (wsReady && ws?.readyState === 1) { try { ws.send(raw); return; } catch { wsReady = false; } }
  if (queue.length < QUEUE_MAX) queue.push(raw);
  if (!ws || ws.readyState === WebSocket.CLOSED) connectWs();
}

// Report the full browser tab list so the server can tell get_sessions which tabs
// exist but have no session (restricted pages / tabs needing a reload). Debounced.
let _tabInvTimer = null;
async function reportTabInventory() {
  try {
    const tabs = await browser.tabs.query({});
    sendToServer({
      type: 'TAB_INVENTORY',
      tabs: tabs
        .filter(t => typeof t.id === 'number')
        .map(t => ({ tabId: t.id, url: t.url || '', title: t.title || '', active: !!t.active }))
        .slice(0, 100),
    });
  } catch (_) { /* best-effort */ }
}
function scheduleTabInventory() {
  if (_tabInvTimer) return;
  _tabInvTimer = setTimeout(() => { _tabInvTimer = null; reportTabInventory(); }, 800);
}

// ── Packed Set-of-Marks (Firefox MV2): crop interactive elements from one
// viewport bitmap and pack into a numbered image. See docs/ideas/PACKED_SOM_CAPTURE.md.
async function _blobToDataURLFx(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(binary);
}

// Secret-guard masking v2 (Firefox): black out redacted regions ON the captured
// image (canvas) so the user's screen never flickers (vs. a live-page overlay).
// Rects are document coords → viewport-image px via the current scroll + dpr.
async function maskDataUrlFx(dataUrl, rects, dpr, scrollX, scrollY) {
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
    return await _blobToDataURLFx(await canvas.convertToBlob({ type: 'image/png' }));
  } finally { bitmap.close?.(); }
}

function _kindFromTagFx(tag) {
  if (tag === 'a') return 'link';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'input';
  return 'button';
}

async function buildPackedSomFx(tabId, windowId, opts) {
  const max = (opts && opts.max) || 40;
  const cellMax = (opts && opts.cellMaxPx) || 96;
  const types = opts && opts.types;

  let elements = [], dpr = 1;
  try {
    const results = await browser.tabs.executeScript(tabId, {
      code: `(${function() {
        const els = [];
        const nodes = document.querySelectorAll('button, a, [role=button], [role=link], input, select, textarea, [aria-label]');
        for (const el of nodes) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 80);
          if (!text && tag !== 'input' && tag !== 'select' && tag !== 'textarea') continue;
          els.push({
            tag, text,
            x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
            w: Math.round(rect.width), h: Math.round(rect.height),
            selector: el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? tag + '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : tag),
          });
        }
        return JSON.stringify({ elements: els, dpr: window.devicePixelRatio || 1 });
      }})()`,
    });
    const r = JSON.parse(results?.[0] || '{}');
    elements = r.elements || [];
    dpr = r.dpr || 1;
  } catch (_) {}

  let els = elements.filter((e) => e.w >= 2 && e.h >= 2);
  if (types && types.length) els = els.filter((e) => types.includes(_kindFromTagFx(e.tag)));
  els = els.slice(0, max);
  if (!els.length) return { dataUrl: null, marks: [], width: 0, height: 0 };

  const shotUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(shotUrl)).blob());

  const PAD = 4, MAXW = 800;
  const cells = els.map((e) => {
    const s = Math.min(1, cellMax / Math.max(e.w, e.h, 1));
    return { e, dw: Math.max(8, Math.round(e.w * s)), dh: Math.max(8, Math.round(e.h * s)) };
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
  // emitThumbs: crop each element into its own small jpeg from the SAME bitmap
  // (no extra captureVisibleTab) so the server can warm the per-element cache.
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
        mark.thumb = await _blobToDataURLFx(await tcv.convertToBlob({ type: 'image/jpeg', quality: 0.6 }));
      } catch (_) { /* best-effort thumbnail */ }
    }
    marks.push(mark);
  }
  const dataUrl = await _blobToDataURLFx(await canvas.convertToBlob({ type: 'image/png' }));
  return { dataUrl, marks, width: W, height: H };
}

// Auto tab switch (agentControl.autoSwitchTab, default ON): when an action or a
// capture targets a tab that is not active, activate it first. Without this,
// captureVisibleTab returns the ACTIVE tab's pixels — i.e. a screenshot of the
// wrong tab — and visibility-dependent page behaviour diverges. Only the tab is
// activated (within its own window); OS window focus is not stolen.
async function ensureTabActive(tabId) {
  try {
    const { SI_CONFIG } = await browser.storage.local.get('SI_CONFIG');
    if (SI_CONFIG?.agentControl?.autoSwitchTab === false) return;
    const tab = await browser.tabs.get(tabId);
    if (!tab.active) await browser.tabs.update(tabId, { active: true });
  } catch (_) { /* tab gone — the caller's normal error path reports it */ }
}

// Wait for a tab's top-frame navigation to reach a lifecycle milestone.
// waitUntil: 'domcontentloaded' (default) → webNavigation.onDOMContentLoaded,
//            'load'                        → webNavigation.onCompleted.
// Returns { promise, cancel }. Listeners are attached synchronously so the
// caller can register BEFORE triggering tabs.update and not miss a fast event.
// Resolves { timedOut:false } on the milestone, { timedOut:true } after timeoutMs.
function waitForNavigation(tabId, waitUntil, timeoutMs) {
  const evt = waitUntil === 'load'
    ? browser.webNavigation.onCompleted
    : browser.webNavigation.onDOMContentLoaded;
  let done = false;
  let timer = null;
  let listener = null;
  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    try { evt.removeListener(listener); } catch (_) {}
  };
  const promise = new Promise((resolve) => {
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ timedOut });
    };
    listener = (details) => {
      if (details.tabId === tabId && details.frameId === 0) finish(false);
    };
    evt.addListener(listener);
    timer = setTimeout(() => finish(true), timeoutMs);
  });
  return { promise, cancel: () => { done = true; cleanup(); } };
}

// EXECUTE_ACTION types that manage tabs themselves (or have no page target) —
// auto-switching before these would be wrong or redundant.
const NO_AUTO_SWITCH_ACTIONS = new Set(['list_tabs', 'switch_tab', 'open_tab', 'close_tab', 'create_tab']);

// ── Download tracking ─────────────────────────────────────────────────────────
// A click that starts a download changes nothing on the page (no DOM/URL/title
// change), so diagnosis honestly reports no_state_change — and agents misread
// the click as failed. Track downloads.onCreated in a small buffer and stamp
// click-ish action results with the downloads that began during the action.
const recentDownloads = new Map(); // downloadId → { id, url, filename, state, startedAt }
if (browser.downloads && browser.downloads.onCreated) {
  browser.downloads.onCreated.addListener((item) => {
    recentDownloads.set(item.id, {
      id: item.id,
      url: item.url || '',
      filename: item.filename || '',
      state: item.state || 'in_progress',
      startedAt: Date.now(),
    });
    if (recentDownloads.size > 20) recentDownloads.delete(recentDownloads.keys().next().value);
  });
  // The final filename (and completion state) arrive after onCreated.
  browser.downloads.onChanged.addListener((delta) => {
    const d = recentDownloads.get(delta.id);
    if (!d) return;
    if (delta.filename && delta.filename.current) d.filename = delta.filename.current;
    if (delta.state && delta.state.current)       d.state    = delta.state.current;
  });
}

function downloadsSince(ts) {
  const out = [];
  for (const d of recentDownloads.values()) {
    // small negative margin: onCreated can be stamped just before our own Date.now()
    if (d.startedAt >= ts - 250) out.push({ id: d.id, url: d.url, filename: d.filename, state: d.state });
  }
  return out;
}

const DOWNLOAD_WATCH_ACTIONS = new Set(['click', 'press_key']);

// Attach downloads that began during the action window, and clear the misleading
// no_state_change verdict when the "no change" was in fact a download starting.
async function annotateDownloads(action, result, startedAt) {
  if (!browser.downloads || !DOWNLOAD_WATCH_ACTIONS.has(action.type)) return result;
  if (!result || typeof result !== 'object') return result;
  let dls = downloadsSince(startedAt);
  if (!dls.length && result.diagnosis && result.diagnosis.unexpectedBehavior === 'no_state_change') {
    await new Promise(r => setTimeout(r, 300)); // download creation can lag the click slightly
    dls = downloadsSince(startedAt);
  }
  if (!dls.length) return result;
  result.downloadsStarted = dls;
  if (result.diagnosis && result.diagnosis.unexpectedBehavior === 'no_state_change') {
    result.diagnosis.unexpectedBehavior = 'download_started';
    result.diagnosis.note = 'The page state did not change because the click started a download — treat as success.';
  }
  return result;
}

// dev-exec badge: a red "DEV" tag on the toolbar icon while dev mode is active.
// Firefox MV2 uses browser.browserAction. Best-effort. (dev-exec.md 7.2 可視)
function applyDevBadge(active) {
  try {
    var a = (typeof browser !== 'undefined' && browser.browserAction) || (typeof chrome !== 'undefined' && chrome.browserAction);
    if (!a) return;
    if (active) {
      a.setBadgeText && a.setBadgeText({ text: 'DEV' });
      a.setBadgeBackgroundColor && a.setBadgeBackgroundColor({ color: '#c0392b' });
      a.setTitle && a.setTitle({ title: 'browser-whiskor — DEV MODE ACTIVE (can run operator artifacts)' });
    } else {
      a.setBadgeText && a.setBadgeText({ text: '' });
      a.setTitle && a.setTitle({ title: 'browser-whiskor' });
    }
  } catch (_) { /* badge is best-effort */ }
}

async function handleServerMessage(msg) {
  switch (msg.type) {
    case 'SET_CONFIG': {
      await browser.storage.local.set({ SI_CONFIG: msg.config });
      collectionScheduler.configure(msg.config?.adaptiveCollection);
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        browser.tabs.executeScript(tab.id, {
          code: `window.postMessage({ __BROWSER_WHISKOR__: true, type: 'CONFIG_UPDATE', payload: ${JSON.stringify(msg.config)} }, '*');`,
        }).catch(() => {});
      }
      broadcastToPanels({ type: 'CONFIG_UPDATED', config: msg.config });
      break;
    }
    case 'SOURCE_CAPTURE_REQUEST': {
      // Agent asked (via server) to capture this tab's sources. getResources()
      // lives in the DevTools panel, so forward to that tab's panel port. If no
      // panel is open, ack immediately so the server waiter doesn't hang.
      const port = panelPorts.get(msg.tabId);
      if (port) {
        port.postMessage({ type: 'SOURCE_CAPTURE_REQUEST', reqId: msg.reqId, tabId: msg.tabId, opts: msg.opts || null });
      } else {
        sendToServer({ type: 'SOURCE_CAPTURE_DONE', reqId: msg.reqId, tabId: msg.tabId, ok: false, error: 'no_devtools' });
      }
      break;
    }
    case 'MANUAL_COLLECT': {
      const tabId = msg.tabId, plugins = JSON.stringify(msg.plugins || null);
      const code = `window.postMessage({ __BROWSER_WHISKOR__: true, type: 'MANUAL_COLLECT', payload: { plugins: ${plugins} } }, '*');`;
      if (tabId) {
        browser.tabs.executeScript(tabId, { code }).catch(() => {});
      } else {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        for (const t of tabs) browser.tabs.executeScript(t.id, { code }).catch(() => {});
      }
      break;
    }
    case 'EXECUTE_ACTION': {
      const { actionId, tabId, action } = msg;
      try {
        if (tabId != null && !NO_AUTO_SWITCH_ACTIONS.has(action.type)) await ensureTabActive(tabId);
        const actionStart = Date.now();
        let result;
        if (action.type === 'navigate') {
          // waitUntil: 'none' keeps the old fire-and-forget behavior; default
          // 'domcontentloaded' waits so a follow-up read/collect isn't empty.
          const waitUntil = String(action.waitUntil || 'domcontentloaded').toLowerCase();
          const timeoutMs = Number.isFinite(action.timeoutMs) ? action.timeoutMs : 10000;
          const wantWait  = waitUntil !== 'none';
          // Register the lifecycle listener BEFORE navigating to avoid a race
          // where DOMContentLoaded fires before we start listening.
          const navWait = wantWait ? waitForNavigation(tabId, waitUntil, timeoutMs) : null;
          try {
            await browser.tabs.update(tabId, { url: action.url });
          } catch (e) {
            if (navWait) navWait.cancel();
            throw e;
          }
          if (!wantWait) {
            result = { navigating: true, url: action.url };
          } else {
            const { timedOut } = await navWait.promise;
            result = { navigated: true, url: action.url, waitUntil };
            if (timedOut) result.timedOut = true;
            if (action.thenCollect) {
              const pl = JSON.stringify(action.plugins || null);
              const code = `window.postMessage({ __BROWSER_WHISKOR__: true, type: 'MANUAL_COLLECT', payload: { plugins: ${pl} } }, '*');`;
              browser.tabs.executeScript(tabId, { code }).catch(() => {});
              result.collected = true;
            }
          }
        } else if (action.type === 'go_back') {
          await browser.tabs.goBack(tabId); result = { ok: true };
        } else if (action.type === 'go_forward') {
          await browser.tabs.goForward(tabId); result = { ok: true };
        } else if (action.type === 'reload') {
          await browser.tabs.reload(tabId, { bypassCache: !!action.hard }); result = { ok: true };
        } else if (action.type === 'list_tabs') {
          const query = action.currentWindowOnly ? { currentWindow: true } : {};
          const tabs = await browser.tabs.query(query);
          result = {
            ok: true,
            tabs: tabs.map(t => ({
              tabId:    t.id,
              url:      t.url || '',
              title:    t.title || '',
              active:   !!t.active,
              windowId: t.windowId,
              index:    t.index,
              status:   t.status || null,
              pinned:   !!t.pinned,
              audible:  !!t.audible,
            })),
          };
        } else if (action.type === 'switch_tab') {
          const target = await browser.tabs.update(action.targetTabId, { active: true });
          try { await browser.windows.update(target.windowId, { focused: true }); } catch (_) {}
          result = { ok: true, tabId: target.id, url: target.url || '', title: target.title || '' };
        } else if (action.type === 'open_tab') {
          const opened = await browser.tabs.create({
            url: action.url || 'about:blank',
            active: action.active !== false,
          });
          result = { ok: true, tabId: opened.id, url: opened.url || (action.url || 'about:blank') };
        } else if (action.type === 'close_tab') {
          await browser.tabs.remove(action.targetTabId);
          result = { ok: true, closedTabId: action.targetTabId };
        } else {
          result = await executeInPage(tabId, action);
        }
        result = await annotateDownloads(action, result, actionStart);
        sendToServer({ type: 'ACTION_RESULT', actionId, ok: true, result });
      } catch (e) {
        sendToServer({ type: 'ACTION_RESULT', actionId, ok: false, error: e.message });
      }
      break;
    }
    case 'CAPTURE_SCREENSHOT': {
      const { reqId, tabId, opts } = msg;
      try {
        await ensureTabActive(tabId); // captureVisibleTab shoots the ACTIVE tab
        const tab = await browser.tabs.get(tabId);

        let elements = null, vpWidth = null, vpHeight = null;
        if (opts?.marks) {
          try {
            const results = await browser.tabs.executeScript(tabId, {
              code: `(${function() {
                const els = [];
                const nodes = document.querySelectorAll('button, a, [role=button], [role=link], input, select, textarea, [aria-label]');
                let idx = 0;
                for (const el of nodes) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width === 0 || rect.height === 0) continue;
                  const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 80);
                  if (!text && el.tagName.toLowerCase() !== 'input' && el.tagName.toLowerCase() !== 'select') continue;
                  idx++;
                  els.push({
                    id: idx, tag: el.tagName.toLowerCase(), text,
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                    w: Math.round(rect.width), h: Math.round(rect.height),
                    selector: el.id ? '#' + el.id : el.className ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase(),
                  });
                }
                return JSON.stringify({ elements: els, vpWidth: window.innerWidth, vpHeight: window.innerHeight });
              }})()`,
            });
            const r = JSON.parse(results?.[0] || '{}');
            elements = r.elements || [];
            vpWidth  = r.vpWidth  || null;
            vpHeight = r.vpHeight || null;
          } catch (_) {}
        }

        let dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

        // Secret guard v2: black out redacted regions ON the captured image (canvas),
        // not by overlaying the live page — so the user's screen never flickers.
        if (Array.isArray(opts?.maskRects) && opts.maskRects.length) {
          try {
            const res = await browser.tabs.executeScript(tabId, {
              code: '({dpr: window.devicePixelRatio||1, sx: window.scrollX||0, sy: window.scrollY||0})',
            });
            const m = (res && res[0]) || { dpr: 1, sx: 0, sy: 0 };
            dataUrl = await maskDataUrlFx(dataUrl, opts.maskRects, m.dpr, m.sx, m.sy);
          } catch (e) { console.warn('[capture] secret mask failed:', e && e.message); }
        }

        sendToServer({
          type: 'SCREENSHOT_RESULT', reqId,
          dataUrl: dataUrl,
          elements: elements || null,
          vpWidth:  vpWidth,
          vpHeight: vpHeight,
          capturedAt: Date.now(),
        });
      } catch (e) {
        sendToServer({ type: 'SCREENSHOT_RESULT', reqId, error: e.message });
      }
      break;
    }

    case 'CAPTURE_PACKED_SOM': {
      const { reqId, tabId, opts = {} } = msg;
      try {
        await ensureTabActive(tabId); // captureVisibleTab shoots the ACTIVE tab
        const tab = await browser.tabs.get(tabId);
        const packed = await buildPackedSomFx(tabId, tab.windowId, opts);
        sendToServer({
          type: 'PACKED_SOM_RESULT', reqId,
          dataUrl: packed.dataUrl, marks: packed.marks,
          width: packed.width, height: packed.height, capturedAt: Date.now(),
        });
      } catch (e) {
        sendToServer({ type: 'PACKED_SOM_RESULT', reqId, error: e.message });
      }
      break;
    }

    case 'CAPTURE_ELEMENT': {
      const { reqId, tabId, opts = {} } = msg;
      try {
        await ensureTabActive(tabId); // captureVisibleTab shoots the ACTIVE tab
        const tab = await browser.tabs.get(tabId);
        let rect = null;

        if (opts.selector) {
          const results = await browser.tabs.executeScript(tabId, {
            code: `document.querySelector(${JSON.stringify(opts.selector)}).getBoundingClientRect()`,
          });
          const r = results?.[0];
          if (!r || r.w === 0) {
            sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId,
              error: 'selector not found: ' + opts.selector });
            break;
          }
          rect = { x: r.left, y: r.top, w: r.width, h: r.height };
        } else if (opts.rect) {
          rect = opts.rect;
        } else {
          sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId,
            error: 'CAPTURE_ELEMENT requires opts.selector or opts.rect' });
          break;
        }

        const pad = typeof opts.padding === 'number' ? Math.max(0, opts.padding) : 4;
        // Output format may be webp; captureVisibleTab only emits png/jpeg, so a
        // webp crop is re-encoded from a lossless png source (no jpeg artifacts).
        const outFormat = opts.format === 'jpeg' ? 'jpeg' : opts.format === 'webp' ? 'webp' : 'png';
        const srcFormat = outFormat === 'jpeg' ? 'jpeg' : 'png';
        const fullDataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
          format:  srcFormat,
          quality: srcFormat === 'jpeg' ? (opts.quality ?? 85) : undefined,
        });

        const croppedDataUrl = await cropImage(fullDataUrl, rect, pad, outFormat, opts.quality, opts.maxPx);

        sendToServer({
          type:       'ELEMENT_CAPTURE_RESULT',
          reqId,
          dataUrl:    croppedDataUrl,
          rect,
          padding:    pad,
          capturedAt: Date.now(),
        });

      } catch (e) {
        sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId, error: e.message });
      }
      break;
    }
    case 'EXPLORER_CONTROL': {
      const code = `window.postMessage({ __BROWSER_WHISKOR__: true, type: 'EXPLORER_CONTROL', payload: ${JSON.stringify(msg)} }, '*');`;
      browser.tabs.executeScript(msg.tabId, { code }).catch(() => {});
      break;
    }
    case 'EXPLORER_NEXT_ACTION': {
      const code = `window.postMessage({ __BROWSER_WHISKOR__: true, type: 'EXPLORER_NEXT_ACTION', payload: ${JSON.stringify(msg.payload)} }, '*');`;
      browser.tabs.executeScript(msg.tabId, { code }).catch(() => {});
      break;
    }
    case 'PONG': break;
    // dev-exec mode visibility: badge the toolbar icon while dev mode is active.
    case 'DEV_MODE':
      applyDevBadge(!!msg.active);
      break;
    // Server asks us to reload from disk (after `whk setup` refreshed the
    // managed extension files, or on a version mismatch at connect time).
    // Temporary add-ons re-read their files on runtime.reload().
    case 'RELOAD_EXTENSION':
      console.log('[SI] Reload requested by server (' + (msg.reason || 'manual') + ') — reloading extension');
      browser.runtime.reload();
      break;
    case 'REQUEST_STATE_HASH': {
      var code = 'window.postMessage({ __BROWSER_WHISKOR__: true, type: "REQUEST_STATE_HASH", requestId: ' + JSON.stringify(msg.requestId) + ', watchMode: ' + JSON.stringify(msg.watchMode) + ' }, "*");';
      browser.tabs.executeScript(msg.tabId, { code }).catch(function() {});
      break;
    }
    case 'CANCEL_WATCH': {
      var code2 = 'window.postMessage({ __BROWSER_WHISKOR__: true, type: "CANCEL_WATCH" }, "*");';
      browser.tabs.executeScript(msg.tabId, { code: code2 }).catch(function() {});
      break;
    }
  }
}

function executeInPage(tabId, action) {
  return new Promise((resolve, reject) => {
    const lid = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      cleanupPageAction(tabId, lid);
      reject(new Error(`Action timeout: ${action.type}`));
    }, PAGE_ACTION_TIMEOUT);
    function listener(msg) {
      if (msg.type !== 'ACTION_COMPLETE') return;
      // The executor nests reply fields under `payload` (bridge relays event.data.payload);
      // read from payload but tolerate a flat shape so the two ends can't drift again.
      const r = msg.payload || msg;
      if (r.listenerId !== lid) return;
      clearTimeout(timer);
      cleanupPageAction(tabId, lid);
      r.ok ? resolve(r.result) : reject(new Error(r.error));
    }
    if (!pendingPageActions.has(tabId)) pendingPageActions.set(tabId, []);
    pendingPageActions.get(tabId).push({ listenerId: lid, timeout: timer, reject });
    browser.runtime.onMessage.addListener(listener);
    const code = `window.postMessage({ __BROWSER_WHISKOR__: true, type: 'EXECUTE_ACTION_IN_PAGE', payload: ${JSON.stringify(action)}, listenerId: '${lid}' }, '*');`;
    browser.tabs.executeScript(tabId, { code }).catch((e) => {
      clearTimeout(timer); cleanupPageAction(tabId, lid); reject(e);
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

connectWs();

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.from === 'collector') {
    // ── CSS Origin Level 1 bridge ─────────────────────────────────────────
    if (message.type === 'CSS_ORIGIN_RESOURCE_REQUEST') {
      const tabId = sender.tab?.id;
      const port  = panelPorts.get(tabId);
      if (!port) {
        const code = `window.postMessage({ __BROWSER_WHISKOR__: true, type: 'CSS_ORIGIN_RESOURCE_RESPONSE', reqId: ${JSON.stringify(message.reqId)}, resources: [] }, '*');`;
        browser.tabs.executeScript(tabId, { code }).catch(() => {});
      } else {
        port.postMessage({ type: 'CSS_ORIGIN_RESOURCE_REQUEST', reqId: message.reqId, tabId });
      }
      return;
    }
    const enriched = { ...message, tabId: sender.tab?.id };
    const senderTabId = sender.tab?.id;
    if (senderTabId != null) {
      collectionScheduler.watchTab(senderTabId);
      collectionScheduler.markActive(senderTabId);
    }
    sendToServer(enriched);
    panelPorts.get(senderTabId)?.postMessage(enriched);
  }
});

// ── CSS Origin Level 1: panel → content script reply ─────────────────────
browser.runtime.onMessage.addListener((message) => {
  if (message.type !== 'CSS_ORIGIN_RESOURCE_RESPONSE') return;
  const { reqId, resources, tabId } = message;
  const code = `window.postMessage({ __BROWSER_WHISKOR__: true, type: 'CSS_ORIGIN_RESOURCE_RESPONSE', reqId: ${JSON.stringify(reqId)}, resources: ${JSON.stringify(resources)} }, '*');`;
  browser.tabs.executeScript(tabId, { code }).catch(() => {});
});

// ── DevTools source capture → server ─────────────────────────────────────
// panel.js captures page resources via getResources()/getContent() (which reads
// from the browser cache, bypassing the CORS limits that block the page-context
// fetch() in source-fetcher.js) and sends the result here. Forward it as
// SOURCE_CONTENT so the server stores it through the same pipeline as Layer 1.
// The panel supplies tabId (devtools-page messages have no sender.tab).
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'SOURCE_CAPTURE_RESULT') {
    sendToServer({ type: 'SOURCE_CONTENT', tabId: message.tabId, payload: message.payload, from: 'devtools' });
  } else if (message.type === 'SOURCE_CAPTURE_DONE') {
    // Ack for a server-initiated capture — resolves core.requestSourceCapture().
    sendToServer({ type: 'SOURCE_CAPTURE_DONE', reqId: message.reqId, tabId: message.tabId,
      ok: message.ok, stored: message.stored, count: message.count, error: message.error });
  }
});

browser.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('devtools-')) return;
  const tabId = parseInt(port.name.replace('devtools-', ''), 10);
  panelPorts.set(tabId, port);
  port.postMessage({ type: 'SERVER_STATUS', connected: wsReady });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'MANUAL_COLLECT') {
      const code = `window.postMessage({ __BROWSER_WHISKOR__: true, type: 'MANUAL_COLLECT', payload: { plugins: ${JSON.stringify(msg.plugins || null)} } }, '*');`;
      browser.tabs.executeScript(tabId, { code }).catch(() => {});
    }
  });
  port.onDisconnect.addListener(() => panelPorts.delete(tabId));
});

function broadcastToPanels(msg) {
  for (const p of panelPorts.values()) { try { p.postMessage(msg); } catch (_) {} }
}

browser.tabs.onRemoved.addListener((tabId) => {
  cleanupTabActions(tabId);
  collectionScheduler.unwatchTab(tabId);
  sendToServer({ type: 'TAB_CLOSED', tabId });
  scheduleTabInventory();
});
// Keep the server's tab inventory roughly in sync (debounced) so get_sessions can
// flag uninstrumented tabs.
browser.tabs.onCreated.addListener(() => scheduleTabInventory());
browser.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url || info.title) scheduleTabInventory(); });
browser.webNavigation.onCommitted.addListener(({ tabId, url, frameId }) => {
  if (frameId !== 0) return;
  collectionScheduler.markActive(tabId);
  sendToServer({ type: 'PAGE_NAVIGATED', tabId, payload: { url }, from: 'sw' });
});
