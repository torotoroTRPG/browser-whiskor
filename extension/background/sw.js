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


async function cropImage(dataUrl, rect, padding, format, quality, dpr = 1) {
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

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

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
            // Delegate to injected executor.js
            result = await executeInPage(tabId, action);
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

        const croppedDataUrl = await cropImage(fullDataUrl, rect, pad, format, opts.quality, dpr);

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
  sendToServer({ type: 'TAB_CLOSED', tabId });
});

chrome.webNavigation.onCommitted.addListener(({ tabId, url, frameId }) => {
  if (frameId !== 0) return; // main frame only
  // Navigation is strong activity evidence — reset quiescent state if the tab
  // is already being watched.  (watchTab is called on first data message.)
  collectionScheduler.markActive(tabId);
  sendToServer({ type: 'PAGE_NAVIGATED', tabId, payload: { url }, from: 'sw' });
});
