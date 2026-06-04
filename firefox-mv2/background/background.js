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

        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        if (format === 'jpeg') {
          resolve(canvas.toDataURL(mimeType, (quality ?? 85) / 100));
        } else {
          resolve(canvas.toDataURL(mimeType));
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
    broadcastToPanels({ type: 'SERVER_STATUS', connected: true });
    while (queue.length) ws.send(queue.shift());
    startPing();
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

// ── Packed Set-of-Marks (Firefox MV2): crop interactive elements from one
// viewport bitmap and pack into a numbered image. See docs/ideas/PACKED_SOM_CAPTURE.md.
async function _blobToDataURLFx(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(binary);
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
  const marks = [];
  cells.forEach((c, i) => {
    const n = i + 1, e = c.e;
    try { ctx.drawImage(bitmap, (e.x - e.w / 2) * dpr, (e.y - e.h / 2) * dpr, e.w * dpr, e.h * dpr, c.dx, c.dy, c.dw, c.dh); } catch (_) {}
    ctx.fillStyle = 'rgba(255,70,70,0.92)'; ctx.fillRect(c.dx, c.dy, 16, 13);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textBaseline = 'top';
    ctx.fillText(String(n), c.dx + 3, c.dy + 2);
    marks.push({ n, text: e.text, selector: e.selector, rect: { x: Math.round(e.x - e.w / 2), y: Math.round(e.y - e.h / 2), w: e.w, h: e.h } });
  });
  const dataUrl = await _blobToDataURLFx(await canvas.convertToBlob({ type: 'image/png' }));
  return { dataUrl, marks, width: W, height: H };
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
        let result;
        if (action.type === 'navigate') {
          await browser.tabs.update(tabId, { url: action.url });
          result = { navigating: true, url: action.url };
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
        sendToServer({ type: 'ACTION_RESULT', actionId, ok: true, result });
      } catch (e) {
        sendToServer({ type: 'ACTION_RESULT', actionId, ok: false, error: e.message });
      }
      break;
    }
    case 'CAPTURE_SCREENSHOT': {
      const { reqId, tabId, opts } = msg;
      try {
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

        // Secret guard: draw opaque masks over redacted regions, capture, remove.
        // Rects are absolute page coordinates (text-coords left/top).
        let _whiskorMasked = false;
        if (Array.isArray(opts?.maskRects) && opts.maskRects.length) {
          try {
            await browser.tabs.executeScript(tabId, {
              code: `(${function(rects) {
                const ID = '__whiskor_secret_masks__';
                let layer = document.getElementById(ID);
                if (!layer) { layer = document.createElement('div'); layer.id = ID; (document.documentElement || document.body).appendChild(layer); }
                layer.setAttribute('style', 'position:absolute;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483647;pointer-events:none;');
                layer.innerHTML = '';
                for (const r of rects) { const b = document.createElement('div'); b.setAttribute('style', 'position:absolute;left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.width + 'px;height:' + r.height + 'px;background:#000;'); layer.appendChild(b); }
              }})(${JSON.stringify(opts.maskRects)})`,
            });
            _whiskorMasked = true;
          } catch (e) { console.warn('[capture] secret mask draw failed:', e && e.message); }
        }

        let dataUrl;
        try {
          dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        } finally {
          if (_whiskorMasked) {
            try {
              await browser.tabs.executeScript(tabId, {
                code: `(function(){ const el = document.getElementById('__whiskor_secret_masks__'); if (el) el.remove(); })()`,
              });
            } catch (_) {}
          }
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
        const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
        const fullDataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
          format,
          quality: format === 'jpeg' ? (opts.quality ?? 85) : undefined,
        });

        const croppedDataUrl = await cropImage(fullDataUrl, rect, pad, format, opts.quality, opts.maxPx);

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
      if (msg.type === 'ACTION_COMPLETE' && msg.listenerId === lid) {
        clearTimeout(timer);
        cleanupPageAction(tabId, lid);
        msg.ok ? resolve(msg.result) : reject(new Error(msg.error));
      }
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
});
browser.webNavigation.onCommitted.addListener(({ tabId, url, frameId }) => {
  if (frameId !== 0) return;
  collectionScheduler.markActive(tabId);
  sendToServer({ type: 'PAGE_NAVIGATED', tabId, payload: { url }, from: 'sw' });
});
