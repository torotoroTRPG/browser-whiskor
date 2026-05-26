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
async function drawMarksOnImage(dataUrl, elements) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = new OffscreenCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const radius = Math.max(12, Math.min(img.width, img.height) * 0.015);
        const fontSize = Math.max(10, radius * 0.9);

        for (const el of elements) {
          const { x, y, id } = el;

          // Background circle with shadow
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 4;
          ctx.shadowOffsetX = 1;
          ctx.shadowOffsetY = 1;

          // Circle
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fillStyle = '#e53e3e';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();

          // Number
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#fff';
          ctx.fillText(String(id), x, y + 1);
        }

        canvas.convertToBlob({ type: 'image/png' }).then(blob => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('Failed to load image for marks overlay'));
    img.src = dataUrl;
  });
}
const panelPorts = new Map(); // tabId → port
let pingTimer = null;

// ── Element crop helper ───────────────────────────────────────────────────────
async function cropImage(dataUrl, rect, padding, format, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const imgW = img.width;
        const imgH = img.height;
        const viewW = self.innerWidth || 1920;
        const dpr = Math.round((imgW / viewW) * 10) / 10 || 1;

        const sx = Math.max(0, Math.round((rect.x - padding) * dpr));
        const sy = Math.max(0, Math.round((rect.y - padding) * dpr));
        const sw = Math.min(imgW - sx, Math.round((rect.w + padding * 2) * dpr));
        const sh = Math.min(imgH - sy, Math.round((rect.h + padding * 2) * dpr));

        if (sw <= 0 || sh <= 0) {
          reject(new Error('Crop region is outside the visible viewport'));
          return;
        }

        const canvas = new OffscreenCanvas(sw, sh);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const blobOpts = format === 'jpeg'
          ? { type: mimeType, quality: (quality ?? 85) / 100 }
          : { type: mimeType };

        canvas.convertToBlob(blobOpts).then(blob => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror   = () => reject(new Error('FileReader failed'));
          reader.readAsDataURL(blob);
        }).catch(reject);

      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Failed to load screenshot for crop'));
    img.src = dataUrl;
  });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWs() {
  try { ws = new WebSocket(WS_URL); }
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

// ── Server → Extension commands ───────────────────────────────────────────────

async function handleServerMessage(msg) {
  switch (msg.type) {

    case 'SET_CONFIG': {
      await chrome.storage.local.set({ SI_CONFIG: msg.config });
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

          case 'set_viewport':
            await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, {
              width: action.width,
              height: action.height,
            });
            result = { ok: true, width: action.width, height: action.height };
            break;

          default:
            // Delegate to injected executor.js
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
        let windowId;
        try { windowId = (await chrome.tabs.get(tabId)).windowId; } catch (_) { windowId = null; }

        let elements = null;
        if (opts?.marks && windowId) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
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
                    id: idx,
                    tag: el.tagName.toLowerCase(),
                    text,
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                    w: Math.round(rect.width),
                    h: Math.round(rect.height),
                    selector: el.id ? `#${el.id}` : el.className ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : el.tagName.toLowerCase(),
                  });
                }
                return els;
              },
              world: 'MAIN',
            });
            elements = results?.[0]?.result || [];
          } catch (_) {}
        }

        const dataUrl = await chrome.tabs.captureVisibleTab(windowId || undefined, { format: 'png' });

        let markedDataUrl = null;
        if (opts?.marks && elements?.length) {
          try {
            markedDataUrl = await drawMarksOnImage(dataUrl, elements);
          } catch (_) {}
        }

        sendToServer({
          type: 'SCREENSHOT_RESULT',
          reqId,
          dataUrl: markedDataUrl || dataUrl,
          elements: elements || null,
          capturedAt: Date.now(),
        });
      } catch (e) {
        sendToServer({ type: 'SCREENSHOT_RESULT', reqId, error: e.message });
      }
      break;
    }

    case 'CAPTURE_ELEMENT': {
      const { reqId, tabId, opts = {} } = msg;

      try {
        let windowId;
        try { windowId = (await chrome.tabs.get(tabId)).windowId; } catch (_) { windowId = null; }
        let rect = null;

        if (opts.selector && windowId) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              func: (selector) => {
                const el = document.querySelector(selector);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height };
              },
              args: [opts.selector],
            });
            rect = results?.[0]?.result || null;
          } catch (_) {}
          if (!rect) {
            sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId,
              error: `selector not found: ${opts.selector}` });
            break;
          }
        } else if (opts.rect) {
          rect = opts.rect;
        } else {
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

        const croppedDataUrl = await cropImage(fullDataUrl, rect, pad, format, opts.quality);

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
    const timeout = setTimeout(() => {
      cleanupPageAction(tabId, listenerId);
      reject(new Error(`Page action timeout: ${action.type}`));
    }, PAGE_ACTION_TIMEOUT);

    function listener(message) {
      if (message.type === 'ACTION_COMPLETE' && message.listenerId === listenerId) {
        clearTimeout(timeout);
        cleanupPageAction(tabId, listenerId);
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error || 'Action failed'));
      }
    }

    if (!pendingPageActions.has(tabId)) pendingPageActions.set(tabId, []);
    pendingPageActions.get(tabId).push({ listenerId, timeout, reject });
    chrome.runtime.onMessage.addListener(listener);

    chrome.scripting.executeScript({
      target: { tabId },
      func: (act, lid) => {
        window.postMessage({ __BROWSER_WHISKOR__: true, type: 'EXECUTE_ACTION_IN_PAGE', payload: act, listenerId: lid }, '*');
      },
      args: [action, listenerId],
      world: 'MAIN',
    }).catch((e) => {
      clearTimeout(timeout);
      cleanupPageAction(tabId, listenerId);
      reject(e);
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
    sendToServer(enriched);
    panelPorts.get(sender.tab?.id)?.postMessage(enriched);
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
  sendToServer({ type: 'TAB_CLOSED', tabId });
});

chrome.webNavigation.onCommitted.addListener(({ tabId, url, frameId }) => {
  if (frameId !== 0) return; // main frame only
  sendToServer({ type: 'PAGE_NAVIGATED', tabId, payload: { url }, from: 'sw' });
});
