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

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWs() {
  try { ws = new WebSocket(WS_URL); }
  catch (e) { scheduleReconnect(); return; }

  ws.addEventListener('open', () => {
    wsReady = true;
    broadcastToPanels({ type: 'SERVER_STATUS', connected: true });
    while (queue.length) ws.send(queue.shift());
    startPing();
    console.log('[SI] Server connected');
  });

  ws.addEventListener('close', () => {
    wsReady = false;
    ws = null;
    stopPing();
    broadcastToPanels({ type: 'SERVER_STATUS', connected: false });
    scheduleReconnect();
  });

  ws.addEventListener('error', () => { wsReady = false; });

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
  if (!ws || ws.readyState === WebSocket.CLOSED) connectWs();
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
          func: (cfg) => window.postMessage({ __SITE_INSPECTOR__: true, type: 'CONFIG_UPDATE', payload: cfg }, '*'),
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
          func: (pl) => window.postMessage({ __SITE_INSPECTOR__: true, type: 'MANUAL_COLLECT', payload: { plugins: pl } }, '*'),
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
            await chrome.tabs.update(tabId, { url: action.url });
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
        const tab = await chrome.tabs.get(tabId);

        // If marks requested, first get interactive elements from content script
        let elements = null;
        if (opts?.marks) {
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

        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

        // If marks requested and we have elements, overlay them
        let markedDataUrl = null;
        if (opts?.marks && elements?.length) {
          try {
            markedDataUrl = await drawMarksOnImage(dataUrl, elements);
          } catch (_) {
            // Fallback: return unmarked image
          }
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

    case 'EXPLORER_CONTROL': {
      const { tabId, active, strategy } = msg;
      chrome.scripting.executeScript({
        target: { tabId },
        func: (act, strat) => window.postMessage({ __SITE_INSPECTOR__: true, type: 'EXPLORER_CONTROL', payload: { active: act, strategy: strat } }, '*'),
        args: [active, strategy],
        world: 'MAIN',
      }).catch(() => {});
      break;
    }

    case 'EXPLORER_NEXT_ACTION': {
      const { tabId } = msg;
      chrome.scripting.executeScript({
        target: { tabId },
        func: (payload) => window.postMessage({ __SITE_INSPECTOR__: true, type: 'EXPLORER_NEXT_ACTION', payload }, '*'),
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
        func: (rid, wm) => window.postMessage({ __SITE_INSPECTOR__: true, type: 'REQUEST_STATE_HASH', requestId: rid, watchMode: wm }, '*'),
        args: [requestId, watchMode],
        world: 'MAIN',
      }).catch(() => {});
      break;
    }

    case 'CANCEL_WATCH': {
      const tabId = msg.tabId;
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.postMessage({ __SITE_INSPECTOR__: true, type: 'CANCEL_WATCH' }, '*'),
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
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error(`Page action timeout: ${action.type}`));
    }, 12000);

    function listener(message) {
      if (message.type === 'ACTION_COMPLETE' && message.listenerId === listenerId) {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error));
      }
    }
    chrome.runtime.onMessage.addListener(listener);

    chrome.scripting.executeScript({
      target: { tabId },
      func: (act, lid) => {
        window.postMessage({ __SITE_INSPECTOR__: true, type: 'EXECUTE_ACTION_IN_PAGE', payload: act, listenerId: lid }, '*');
      },
      args: [action, listenerId],
      world: 'MAIN',
    }).catch((e) => {
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      reject(e);
    });
  });
}

connectWs();

// ── Messages from content scripts ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.from !== 'collector' && message.type !== 'ACTION_COMPLETE') return;

  if (message.from === 'collector') {
    const enriched = { ...message, tabId: sender.tab?.id, frameId: sender.frameId };
    sendToServer(enriched);
    panelPorts.get(sender.tab?.id)?.postMessage(enriched);
  }
  // ACTION_COMPLETE is handled by the listener inside executeInPage
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
        func: (pl) => window.postMessage({ __SITE_INSPECTOR__: true, type: 'MANUAL_COLLECT', payload: { plugins: pl } }, '*'),
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
  sendToServer({ type: 'TAB_CLOSED', tabId });
});

chrome.webNavigation.onCommitted.addListener(({ tabId, url, frameId }) => {
  if (frameId !== 0) return; // main frame only
  sendToServer({ type: 'PAGE_NAVIGATED', tabId, payload: { url }, from: 'sw' });
});
