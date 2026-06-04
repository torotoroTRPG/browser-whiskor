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

// Worker-side packed-SoM cache + usage-stats, injected (nullable → no-op). These
// live here, on the process that actually captures, so every caller — MCP stdio,
// HTTP /api/packed-som, and the proxy's HTTP forward — shares one cache and one
// ranking. Putting them in the MCP layer instead would silently disable them in
// proxy mode (the MCP process is separate there). Kept loosely coupled (plain
// get/set/rank) so a future implementation can be swapped in by re-injecting.
let _somCache = null;
let _somStats = null;
function setSomCache(c) { _somCache = c; }
function setSomStats(s) { _somStats = s; }

/**
 * Request a screenshot of the given tab.
 * Returns Promise<{ dataUrl, filePath, width, height, capturedAt, elements? }>
 * If opts.marks=true, elements contains {id, tag, text, x, y, w, h, selector}[]
 */
function captureElement(tabId, opts = {}) {
  return new Promise((resolve, reject) => {
    const reqId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`Element capture timed out for tabId=${tabId}`));
    }, TIMEOUT_MS);

    pending.set(reqId, { resolve, reject, timer, tabId, isElement: true });
    _broadcast({ type: 'CAPTURE_ELEMENT', reqId, tabId, opts });
  });
}

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
 * Packed Set-of-Marks capture: the extension crops only the interactive elements
 * from one viewport bitmap and packs them into a single numbered image (canvas).
 * Resolves Promise<{ ok, dataUrl, filePath, marks: [{n, selector, rect, text}] }>.
 * See docs/ideas/PACKED_SOM_CAPTURE.md.
 */
// Raw capture: ask the extension to crop+pack and resolve the base result.
function _rawCapturePackedSom(tabId, opts = {}) {
  return new Promise((resolve, reject) => {
    const reqId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`Packed SoM capture timed out for tabId=${tabId}`));
    }, TIMEOUT_MS);

    pending.set(reqId, { resolve, reject, timer, tabId });

    _broadcast({ type: 'CAPTURE_PACKED_SOM', reqId, tabId, opts });
  });
}

// Shape a base result into the response: project marks to {n,text,selector,rect},
// then bias the order by usage stats (never drops a mark; the image numbers `n`
// are unchanged). Re-applied on every return so cache hits reflect current stats.
function _shapePackedResult(base, fromCache) {
  let marks = (base.marks || []).map((m) => ({ n: m.n, text: m.text, selector: m.selector, rect: m.rect }));
  let ordered = false;
  if (_somStats && typeof _somStats.rank === 'function') {
    try {
      const ranked = _somStats.rank(marks.map((m) => m.text));
      const scoreByText = new Map(ranked.map((r) => [r.text, r.score]));
      for (const m of marks) m.score = scoreByText.get(m.text) || 0;
      marks.sort((a, b) => (b.score - a.score) || (a.n - b.n));
      ordered = marks.some((m) => m.score > 0);
    } catch (_) { /* stats are best-effort */ }
  }
  return { ...base, marks, _cached: fromCache, _ordered: ordered };
}

/**
 * Packed Set-of-Marks capture with a freshness cache and usage-stats ordering.
 * Cache hit → reuse the last image+marks for an unchanged page (no re-capture);
 * miss → capture and store. The cache/stats are worker-side (see setSomCache),
 * so this single path serves MCP stdio, HTTP, and the proxy forward identically.
 */
async function capturePackedSom(tabId, opts = {}) {
  let base = (_somCache && _somCache.get(tabId)) || null;
  const fromCache = !!base;
  if (!base) {
    base = await _rawCapturePackedSom(tabId, opts);
    if (!base || !base.ok) return base; // pass through errors untouched
    if (_somCache) _somCache.set(tabId, base);
  }
  return _shapePackedResult(base, fromCache);
}

/**
 * Called by index.js when SCREENSHOT_RESULT arrives.
 */
function handleResult(msg) {
  const { reqId, dataUrl, width, height, error, elements, tabGone, liveTabs } = msg;
  const p = pending.get(reqId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(reqId);

  if (error) {
    p.resolve({ ok: false, error, ...(tabGone ? { tabGone: true, liveTabs: liveTabs || [] } : {}) });
    return;
  }

  // Save to disk (derive extension from the data URL's mime so a jpeg isn't saved as .png)
  const mimeMatch = /^data:image\/(\w+);base64,/.exec(dataUrl || '');
  const ext = mimeMatch ? (mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1]) : 'png';
  const filename = `${p.tabId}-${Date.now()}.${ext}`;
  const filePath = path.join(SCREENSHOT_DIR, filename);
  try {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  } catch (e) {
    // Non-fatal: still return the dataUrl
  }

  const result = { ok: true, dataUrl, filePath, width, height, capturedAt: Date.now() };
  if (elements) result.elements = elements;
  if (msg.marks) result.marks = msg.marks; // packed Set-of-Marks: number → element map
  if (msg.rect) result.rect = msg.rect;
  if (msg.padding) result.padding = msg.padding;
  if (msg.vpWidth) result.vpWidth = msg.vpWidth;
  if (msg.vpHeight) result.vpHeight = msg.vpHeight;
  p.resolve(result);
}

module.exports = { setBroadcast, setSomCache, setSomStats, capture, captureElement, capturePackedSom, handleResult };
