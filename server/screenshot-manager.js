/**
 * server/screenshot-manager.js
 * Manages screenshot requests/responses.
 * Extension calls chrome.tabs.captureVisibleTab and sends base64 PNG back.
 */
'use strict';

const { randomUUID } = require('crypto');
const fs   = require('fs');
const path = require('path');

const SCREENSHOT_DIR = path.join(__dirname, '..', 'cache', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const TIMEOUT_MS = 10000;
const pending = new Map(); // reqId → { resolve, reject, timer }

let _broadcast = null;
function setBroadcast(fn) { _broadcast = fn; }

/**
 * Request a screenshot of the given tab.
 * Returns Promise<{ dataUrl, filePath, width, height, capturedAt, elements? }>
 * If opts.marks=true, elements contains {id, tag, text, x, y, w, h, selector}[]
 */
function capture(tabId, opts = {}) {
  return new Promise((resolve, reject) => {
    const reqId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`Screenshot timed out for tabId=${tabId}`));
    }, TIMEOUT_MS);

    pending.set(reqId, { resolve, reject, timer, tabId });

    _broadcast({ type: 'CAPTURE_SCREENSHOT', reqId, tabId, opts });
  });
}

/**
 * Called by index.js when SCREENSHOT_RESULT arrives.
 */
function handleResult(msg) {
  const { reqId, dataUrl, width, height, error, elements } = msg;
  const p = pending.get(reqId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(reqId);

  if (error) {
    p.resolve({ ok: false, error });
    return;
  }

  // Save to disk
  const filename = `${p.tabId}-${Date.now()}.png`;
  const filePath = path.join(SCREENSHOT_DIR, filename);
  try {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  } catch (e) {
    // Non-fatal: still return the dataUrl
  }

  const result = { ok: true, dataUrl, filePath, width, height, capturedAt: Date.now() };
  if (elements) result.elements = elements;
  p.resolve(result);
}

module.exports = { setBroadcast, capture, handleResult };
