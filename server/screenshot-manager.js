/**
 * server/screenshot-manager.js
 * Manages screenshot requests/responses.
 * Extension calls chrome.tabs.captureVisibleTab and sends base64 PNG back.
 */
'use strict';

const { randomUUID } = require('crypto');
const fs   = require('fs');
const path = require('path');

// handleResult persists every capture to disk. The location is overridable via
// WHISKOR_SCREENSHOT_DIR so the test suite can redirect writes to a throwaway
// temp dir — otherwise unit tests that feed placeholder data URLs through the
// real handleResult would litter the developer's production cache/screenshots
// with 1-byte junk files (they did: see scripts/_run-tests.js).
const SCREENSHOT_DIR = process.env.WHISKOR_SCREENSHOT_DIR
  ? path.resolve(process.env.WHISKOR_SCREENSHOT_DIR)
  : path.join(__dirname, '..', 'cache', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const TIMEOUT_MS = 10000;
const pending = new Map(); // reqId → { resolve, reject, timer }

// Disk retention for cache/screenshots. handleResult writes every captureVisibleTab
// result to disk and nothing used to clean it up, so the directory grew without
// bound (see local_issues/2026-06-17_capture-image-cache-and-disk-leak.md). We cap
// it two ways: drop files older than maxAgeMs, then evict oldest until under maxMB.
// Pruned at startup (index.js) and opportunistically every PRUNE_EVERY writes.
const _retention = { maxMB: 100, maxAgeMs: 24 * 60 * 60 * 1000 };
const PRUNE_EVERY = 50;
let _writesSincePrune = 0;
function setRetention(opts = {}) {
  if (opts.maxMB != null)    _retention.maxMB = Number(opts.maxMB);
  if (opts.maxAgeMs != null) _retention.maxAgeMs = Number(opts.maxAgeMs);
}

/**
 * Prune cache/screenshots: delete files older than maxAgeMs, then (if still over)
 * evict oldest-first until total size is under maxMB. Best-effort; never throws.
 * @param {string} [dir] - directory to prune (default SCREENSHOT_DIR; injectable for tests)
 * @param {object} [opts] - { maxMB, maxAgeMs } (default _retention)
 * @returns {{deleted:number, freedMB:number, remainingMB:number}}
 */
function pruneOldScreenshots(dir = SCREENSHOT_DIR, opts = _retention) {
  const maxBytes = Math.max(0, (opts.maxMB != null ? Number(opts.maxMB) : 100)) * 1024 * 1024;
  const maxAgeMs = opts.maxAgeMs != null ? Number(opts.maxAgeMs) : 24 * 60 * 60 * 1000;
  const now = Date.now();
  let names;
  try { names = fs.readdirSync(dir); } catch { return { deleted: 0, freedMB: 0, remainingMB: 0 }; }

  const files = [];
  for (const name of names) {
    const fp = path.join(dir, name);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (st.isFile()) files.push({ fp, size: st.size, mtime: st.mtimeMs });
  }

  let deleted = 0, freed = 0;
  const unlink = (f) => { try { fs.unlinkSync(f.fp); deleted++; freed += f.size; f.gone = true; } catch { /* ignore */ } };

  // 1. age-based
  if (maxAgeMs > 0) for (const f of files) if (now - f.mtime > maxAgeMs) unlink(f);

  // 2. size cap: oldest first until under the limit
  let total = files.reduce((s, f) => s + (f.gone ? 0 : f.size), 0);
  if (total > maxBytes) {
    for (const f of files.filter(x => !x.gone).sort((a, b) => a.mtime - b.mtime)) {
      if (total <= maxBytes) break;
      const before = f.size; unlink(f); if (f.gone) total -= before;
    }
  }

  const remaining = files.reduce((s, f) => s + (f.gone ? 0 : f.size), 0);
  return { deleted, freedMB: freed / 1024 / 1024, remainingMB: remaining / 1024 / 1024 };
}

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
let _somThumbs = null;
let _thumbPrefetch = false;
function setSomCache(c) { _somCache = c; }
function setSomStats(s) { _somStats = s; }
function setSomThumbs(t) { _somThumbs = t; }
// When on, a packed-SoM capture also emits a per-element thumbnail (cropped from
// the same bitmap — no extra captureVisibleTab) and warms the thumbnail cache, so
// a later get_element_thumbnail({selector}) is an instant hit. Off by default.
function setThumbPrefetch(b) { _thumbPrefetch = !!b; }

// Warm the per-element thumbnail cache from a packed result's marks. Keyed to
// match get_element_thumbnail's selector default (selector + the default maxPx),
// so a selector-only lookup hits it.
const PREFETCH_THUMB_MAXPX = 96; // matches buildPackedSom cellMax + the tool default
function _storePackedThumbs(tabId, marks) {
  if (!_somThumbs || !Array.isArray(marks)) return;
  for (const m of marks) {
    if (!m || !m.thumb || !m.selector) continue;
    try {
      // Prefetched packed thumbs are jpeg (see the extension's emitThumbs path);
      // the format is part of the key so a later webp request doesn't reuse them.
      const sig = _somThumbs.thumbSignature(`${m.selector}#${PREFETCH_THUMB_MAXPX}#jpeg`, {});
      _somThumbs.set(tabId, sig, { dataUrl: m.thumb, rect: m.rect });
    } catch (_) { /* best-effort prefetch */ }
  }
}

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

// Secret-guard screenshot masking is computed here, on the worker, so every
// caller — MCP stdio, HTTP /api/screenshot, and the proxy's HTTP forward — gets
// masked images. (It used to live in the MCP tool and was dead under the proxy,
// which never received the guard, and dropped on the HTTP path.) The provider is
// injected (nullable no-op) and returns the rects to black out for a tab.
let _maskProvider = null;
function setMaskProvider(fn) { _maskProvider = fn; }

async function capture(tabId, opts = {}) {
  // Resolve mask rects unless the caller already supplied them. Best-effort:
  // masking must never block or fail a capture.
  if (_maskProvider && !opts.maskRects) {
    try {
      const rects = await _maskProvider(tabId);
      if (rects && rects.length) opts = { ...opts, maskRects: rects };
    } catch (_) { /* never block a capture on masking */ }
  }
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
    const wantThumbs = _thumbPrefetch && !!_somThumbs;
    base = await _rawCapturePackedSom(tabId, wantThumbs ? { ...opts, emitThumbs: true } : opts);
    if (!base || !base.ok) return base; // pass through errors untouched
    if (_somCache) _somCache.set(tabId, base);
    if (wantThumbs) _storePackedThumbs(tabId, base.marks); // warm the per-element cache
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
    // Opportunistic prune so a single long-running session can't grow the
    // directory without bound between restarts. Fire-and-forget, off the hot path.
    if (++_writesSincePrune >= PRUNE_EVERY) {
      _writesSincePrune = 0;
      setImmediate(() => { try { pruneOldScreenshots(); } catch { /* best-effort */ } });
    }
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

/**
 * Per-element thumbnail capture with a worker-side view-aware cache (T2). Wraps
 * the existing single-element crop (captureElement) so a repeat reference to an
 * unchanged element is served from cache instead of re-capturing. Worker-side, so
 * MCP stdio / HTTP / proxy forward all share it. Resolution downscaling to a
 * low-quality thumbnail is an extension-canvas refinement left for a later slice;
 * here jpeg compression keeps the payload modest.
 */
async function captureElementThumbnail(tabId, opts = {}) {
  const baseSel = opts.selector || (opts.rect ? `rect:${opts.rect.x},${opts.rect.y}` : null);
  // Fold the thumbnail size cap AND format into the key so different maxPx/format
  // requests for the same element don't collide (a webp must not reuse a jpeg crop).
  const keyBase = baseSel ? `${baseSel}#${opts.maxPx || 0}#${opts.format || 'jpeg'}` : null;
  const sig = (_somThumbs && keyBase) ? _somThumbs.thumbSignature(keyBase, opts.rect || {}) : null;

  if (_somThumbs && sig) {
    const hit = _somThumbs.get(tabId, sig);
    if (hit) return { ok: true, dataUrl: hit.dataUrl, rect: hit.rect, capturedAt: hit.capturedAt, _cached: true };
  }

  const result = await captureElement(tabId, opts);
  if (!result || !result.ok) return result;
  if (_somThumbs && sig) _somThumbs.set(tabId, sig, { dataUrl: result.dataUrl, rect: result.rect });
  return { ...result, _cached: false };
}

module.exports = { setBroadcast, setSomCache, setSomStats, setSomThumbs, setThumbPrefetch, setMaskProvider, capture, captureElement, capturePackedSom, captureElementThumbnail, handleResult, setRetention, pruneOldScreenshots, SCREENSHOT_DIR };
