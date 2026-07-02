/**
 * server/cache-writer.js  –  Enhanced with staleness tracking
 *
 * Directory layout per session:
 *   cache/sessions/{siteVersion}/{tabId}-{sessionId}/
 *     _index.json
 *     raw/
 *       react/snapshot.json      visual/text-coords.json
 *       vue/snapshot.json        network/requests.json
 *       angular/snapshot.json    css/analysis.json
 *       svelte/snapshot.json     ui/elements.json
 *       dom/snapshot.json        accessibility/tree.json
 *       storage/data.json        perf/metrics.json
 *       console/logs.json        sources/catalog.json
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const fsp  = fs.promises;

const CACHE_ROOT = process.env.WHISKOR_CACHE_DIR || path.join(__dirname, '..', 'cache', 'sessions');

const STALE_THRESHOLD_MS = 30_000; // 30s
const MAX_SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours
// A session whose browser tab is known to be CLOSED (TAB_CLOSED from the
// extension) is kept briefly for retrospection, then dropped — well before the
// 2h idle backstop. Pinned (keep) sessions are never swept.
const CLOSED_SESSION_RETENTION_MS = 15 * 60 * 1000; // 15 min

// tabId → { dir, index, networkRequests[], consoleLogs[], updatedAt, closedAt? }
const sessions = new Map();

// Periodic cleanup of inactive/closed sessions
setInterval(() => {
  const now = Date.now();
  for (const [tabId, s] of sessions.entries()) {
    if (s.keep) continue;
    const closedAt = s.closedAt || (s.index && s.index.closedAt);
    if (closedAt && now - closedAt > CLOSED_SESSION_RETENTION_MS) {
      console.log(`[cache] Evicting closed-tab session for tabId=${tabId}`);
      removeSession(tabId);
    } else if (now - s.updatedAt > MAX_SESSION_IDLE_MS) {
      console.log(`[cache] Evicting inactive session for tabId=${tabId}`);
      removeSession(tabId);
    }
  }
}, 5 * 60 * 1000).unref(); // check every 5 minutes

// ── Load existing sessions from disk on startup ───────────────────────────────────
async function loadSessionsFromDisk() {
  await fsp.mkdir(CACHE_ROOT, { recursive: true });
  
  const siteDirs = await fsp.readdir(CACHE_ROOT, { withFileTypes: true });
  
  for (const siteDir of siteDirs) {
    if (!siteDir.isDirectory()) continue;
    const sitePath = path.join(CACHE_ROOT, siteDir.name);
    const sessionDirs = await fsp.readdir(sitePath, { withFileTypes: true });
    
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const fullPath = path.join(sitePath, sessionDir.name);
      const indexPath = path.join(fullPath, '_index.json');
      
      try {
        const index = await readJsonAsync(indexPath);
        if (index && index.tabId) {
          // Only load if not already in memory
          if (!sessions.has(index.tabId)) {
            sessions.set(index.tabId, {
              dir: fullPath,
              index,
              networkRequests: [],
              consoleLogs: [],
              // Fallback to now: a missing timestamp made the idle-sweep compare
              // against NaN (always false), so the session could never be evicted.
              updatedAt: index.updatedAt || index.createdAt || Date.now(),
              closedAt: index.closedAt || null,
              keep: false,
            });
          }
        }
      } catch (e) {
        console.error(`[cache] Failed to load session ${siteDir.name}/${sessionDir.name}:`, e.message);
      }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Atomic-write helper: write to a unique temp file in the same directory, then
// rename over the target. rename(2) is atomic on the same volume (Windows uses
// MoveFileEx with MOVEFILE_REPLACE_EXISTING), so a crash mid-write leaves either
// the old file intact or the fully-written new one — never a half-written JSON.
// The pid+counter suffix avoids collisions between concurrent writes to one path.
let _tmpCounter = 0;
function _tmpPath(filePath) {
  return `${filePath}.${process.pid}.${(_tmpCounter = (_tmpCounter + 1) & 0xffffff)}.tmp`;
}

// On Windows the atomic rename (MoveFileEx) can transiently fail with EPERM/
// EBUSY/EACCES/EEXIST when the target is briefly locked by antivirus, the search
// indexer, or another handle. These clear in milliseconds, so retry a few times
// with a short backoff before giving up. ENOENT is NOT retried — it means the
// target directory was removed under us (session deleted / test teardown), which
// is expected and handled by the callers (no error log).
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);
const RENAME_BACKOFFS_MS = [10, 30, 80];

function _sleepSync(ms) {
  // Block without busy-spinning (sync path is legacy / cold only).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// renameImpl is injectable purely for tests; production uses the fs default.
function _renameWithRetrySync(tmp, filePath, renameImpl = fs.renameSync) {
  for (let attempt = 0; ; attempt++) {
    try { return renameImpl(tmp, filePath); }
    catch (e) {
      if (!RENAME_RETRY_CODES.has(e.code) || attempt >= RENAME_BACKOFFS_MS.length) throw e;
      _sleepSync(RENAME_BACKOFFS_MS[attempt]);
    }
  }
}

async function _renameWithRetryAsync(tmp, filePath, renameImpl = fsp.rename) {
  for (let attempt = 0; ; attempt++) {
    try { return await renameImpl(tmp, filePath); }
    catch (e) {
      if (!RENAME_RETRY_CODES.has(e.code) || attempt >= RENAME_BACKOFFS_MS.length) throw e;
      await new Promise((r) => setTimeout(r, RENAME_BACKOFFS_MS[attempt]));
    }
  }
}

// sync helpers (legacy – not used in the hot handleMessage path)
function writeJson(filePath, data) {
  const tmp = _tmpPath(filePath);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    _renameWithRetrySync(tmp, filePath);
  } catch (e) {
    // ENOENT = target dir removed under us (session deleted / teardown) — expected.
    if (e.code !== 'ENOENT') console.error('[cache] writeJson error:', e.message, filePath);
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
  }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

async function writeJsonAsync(filePath, data) {
  const tmp = _tmpPath(filePath);
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await _renameWithRetryAsync(tmp, filePath);
  } catch (e) {
    // ENOENT = target dir removed under us (session deleted / teardown) — expected.
    if (e.code !== 'ENOENT') console.error('[cache] writeJson error:', e.message, filePath);
    try { await fsp.unlink(tmp); } catch { /* tmp may not exist */ }
  }
}

async function readJsonAsync(filePath) {
  try { return JSON.parse(await fsp.readFile(filePath, 'utf8')); }
  catch { return null; }
}

async function getSession(tabId, url, siteVersion) {
  if (!sessions.has(tabId)) {
    const sessionId = Date.now();
    const siteDir = (siteVersion || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const dir = path.join(CACHE_ROOT, siteDir, `${tabId}-${sessionId}`);

    // Framework dirs (react/vue/angular/svelte/preact/alpine/solid) are NOT
    // pre-created: a page uses at most one or two frameworks, so pre-making them
    // all leaves empty noise dirs. writeJsonAsync creates the parent on demand when
    // a snapshot actually lands. Only dirs that nearly always receive data are made
    // up front.
    for (const sub of ['raw/dom', 'raw/visual', 'raw/network', 'raw/css', 'raw/ui',
                        'raw/accessibility', 'raw/storage', 'raw/perf', 'raw/console', 'raw/sources']) {
      await fsp.mkdir(path.join(dir, sub), { recursive: true });
    }

    const index = {
      tabId, sessionId, siteVersion,
      createdAt: sessionId,
      updatedAt: sessionId,
      url: url || null,
      title: null,
      summary: { detectedFrameworks: [], textWordCount: 0, networkRequests: 0, consoleLogs: 0 },
      dataFreshness: {},    // pluginId → capturedAt
      files: { raw: {} },
    };

    sessions.set(tabId, { dir, index, networkRequests: [], consoleLogs: [], updatedAt: Date.now(), keep: false });
    await writeJsonAsync(path.join(dir, '_index.json'), index);
  }
  return sessions.get(tabId);
}

async function updateIndexAsync(session) {
  session.index.updatedAt = Date.now();
  await writeJsonAsync(path.join(session.dir, '_index.json'), session.index);
}

function markFresh(session, pluginId, capturedAt) {
  session.index.dataFreshness[pluginId] = capturedAt || Date.now();
}

// ── public API ────────────────────────────────────────────────────────────────

// Whiskor's own HTTP port — set at startup so we never capture our own dashboard
// or API endpoints (the /export download, /api/*) as if they were a real site.
let _selfPort = null;
function setSelfOrigin(httpPort) { _selfPort = httpPort ? String(httpPort) : null; }
function isSelfOrigin(url) {
  if (!_selfPort || !url) return false;
  try {
    const u = new URL(url);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]';
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return loopback && port === _selfPort;
  } catch (_) { return false; }
}

async function handleMessage(msg) {
  const { type, tabId, tabUrl, payload, siteVersion } = msg;
  if (!tabId) return;
  // Don't capture whiskor's own dashboard / API (self-monitoring noise: the
  // dashboard tab, and a fresh session per /export download).
  if (isSelfOrigin(tabUrl)) return;

  const s = await getSession(tabId, tabUrl, siteVersion || 'default');
  s.updatedAt = Date.now();
  if (tabUrl && !s.index.url) { s.index.url = tabUrl; }

  switch (type) {

    case 'FRAMEWORK_DETECTION': {
      s.index.summary.detectedFrameworks = payload.detected.map(d => d.frameworkId || d.id);
      markFresh(s, 'framework-detection', payload.capturedAt);
      console.log(`[cache] FRAMEWORK_DETECTION tabId=${tabId}:`, s.index.summary.detectedFrameworks.join(', '));
      break;
    }

    case 'REACT_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/react/snapshot.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.react_snapshot = 'raw/react/snapshot.json';
      markFresh(s, 'react-fiber', payload.capturedAt);
      console.log(`[cache] REACT_SNAPSHOT tabId=${tabId}`);
      break;
    }

    case 'REACT_TRANSITION': {
      if (!s.reactTransitions) s.reactTransitions = [];
      s.reactTransitions.push(payload);
      const maxHistory = 100;
      if (s.reactTransitions.length > maxHistory) {
        s.reactTransitions.splice(0, s.reactTransitions.length - maxHistory);
      }
      const fp = path.join(s.dir, 'raw/react/transitions.json');
      await writeJsonAsync(fp, { capturedAt: Date.now(), totalTransitions: s.reactTransitions.length, transitions: s.reactTransitions });
      s.index.files.raw.react_transitions = 'raw/react/transitions.json';
      s.index.summary.reactTransitions = s.reactTransitions.length;
      console.log(`[cache] REACT_TRANSITION tabId=${tabId} total=${s.reactTransitions.length}`);
      break;
    }

    // vue3.js emits VUE3_SNAPSHOT; VUE_SNAPSHOT is the legacy alias (no current
    // producer). Handle both so Vue 3 state actually lands in the cache.
    case 'VUE_SNAPSHOT':
    case 'VUE3_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/vue/snapshot.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.vue_snapshot = 'raw/vue/snapshot.json';
      markFresh(s, 'vue3', payload.capturedAt);
      break;
    }

    case 'VUE2_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/vue/vue2-snapshot.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.vue2_snapshot = 'raw/vue/vue2-snapshot.json';
      markFresh(s, 'vue2', payload.capturedAt);
      break;
    }

    case 'ANGULAR_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/angular/snapshot.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.angular_snapshot = 'raw/angular/snapshot.json';
      markFresh(s, 'angular', payload.capturedAt);
      break;
    }

    case 'SVELTE_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/svelte/snapshot.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.svelte_snapshot = 'raw/svelte/snapshot.json';
      markFresh(s, 'svelte', payload.capturedAt);
      break;
    }

    case 'PREACT_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/preact/snapshot.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.preact_snapshot = 'raw/preact/snapshot.json';
      markFresh(s, 'preact', payload.capturedAt);
      break;
    }

    case 'ALPINE_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/alpine/snapshot.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.alpine_snapshot = 'raw/alpine/snapshot.json';
      markFresh(s, 'alpine', payload.capturedAt);
      break;
    }

    case 'SOLID_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/solid/snapshot.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.solid_snapshot = 'raw/solid/snapshot.json';
      markFresh(s, 'solid', payload.capturedAt);
      break;
    }

    case 'DOM_GENERIC_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/dom/snapshot.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.dom_generic = 'raw/dom/snapshot.json';
      s.index.title = payload.docTitle || null;
      markFresh(s, 'dom-generic', payload.capturedAt);
      break;
    }

    case 'SHADOW_DOM_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/dom/shadow-snapshot.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.shadow_snapshot = 'raw/dom/shadow-snapshot.json';
      markFresh(s, 'shadow-dom', payload.capturedAt);
      break;
    }

    case 'DOM_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/dom/snapshot2.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.dom_snapshot2 = 'raw/dom/snapshot2.json';
      markFresh(s, 'dom-snapshot', payload.capturedAt);
      break;
    }

    case 'TEXT_COORDS': {
      const fp = path.join(s.dir, 'raw/visual/text-coords.json');
      
      // Merge with existing cache to retain offscreen/seen texts
      const existing = await readJsonAsync(fp) || {};

      const merged = { ...payload };
      
      if (existing.words && existing.words.length > 0) {
        const existingByXpath = new Map();
        for (const w of existing.words) {
          if (w.xpath) existingByXpath.set(w.xpath, w);
        }

        // Update with new words, keep old ones if not present in new payload
        const newXPaths = new Set((payload.words || []).map(w => w.xpath));
        const mergedWords = [...(payload.words || [])];

        for (const [xpath, oldWord] of existingByXpath.entries()) {
          if (!newXPaths.has(xpath) && oldWord.fromCache !== true) {
            // Mark as cached and add to merged list
            mergedWords.push({ ...oldWord, fromCache: true, inViewport: false });
          }
        }

        merged.words = mergedWords;
        merged.totalWords = mergedWords.length;
        // Regenerate fullText from merged words
        merged.fullText = mergedWords.map(w => w.text).join(' ');
        
        // Re-aggregate lines/blocks if needed (simplified: keep new payload's aggregation for now)
        // In a full implementation, we'd re-run aggregateLines/Blocks here.
      }

      await writeJsonAsync(fp, merged);
      s.index.files.raw.text_coords = 'raw/visual/text-coords.json';
      s.index.summary.textWordCount = merged.totalWords || 0;
      markFresh(s, 'text-coords', payload.capturedAt);

      // VIEWPORT_UPDATE only fires on scroll/resize, so on pages that never scroll
      // viewport.json would never exist. The TEXT_COORDS payload carries the same
      // viewport snapshot — persist it here so the file exists after every collect.
      if (payload.viewport) {
        const vp = { ...payload.viewport, capturedAt: payload.capturedAt || Date.now() };
        s.viewport = vp;
        await writeJsonAsync(path.join(s.dir, 'raw/visual/viewport.json'), vp);
        s.index.files.raw.viewport = 'raw/visual/viewport.json';
      }
      console.log(`[cache] TEXT_COORDS tabId=${tabId} words=${merged.totalWords} (merged: ${existing.words?.length || 0} old)`);
      break;
    }

    case 'NETWORK_REQUEST': {
      // The page-JS hooks (injected/analyzers/network.js) and mock-data emit the
      // same event under different field names. Accept both so live fetch/XHR/WS
      // capture isn't silently dropped (reqId vs requestId, headers vs requestHeaders…).
      const requestId      = payload.requestId != null ? payload.requestId : payload.reqId;
      const { method, url: reqUrl } = payload;
      const startTime      = payload.startTime != null ? payload.startTime : (payload.ts || Date.now());
      const requestHeaders = payload.requestHeaders || payload.headers || null;
      const requestBody    = payload.requestBody != null ? payload.requestBody : (payload.bodyPreview != null ? payload.bodyPreview : null);
      const initiatorType  = payload.initiatorType || payload.kind || null;
      const req = { requestId, method, url: reqUrl, startTime, initiatorType, requestHeaders, requestBody, tokens: payload.tokens || null, status: null, duration: null, responseHeaders: null, responseBody: null };
      // Only dedup when we actually have an id; a null id must never collapse all
      // requests onto the first null-id entry (the old bug that capped totals at 1).
      const idx = requestId != null ? s.networkRequests.findIndex(r => r.requestId === requestId) : -1;
      if (idx === -1) s.networkRequests.push(req);
      else s.networkRequests[idx] = { ...s.networkRequests[idx], ...req };
      s.index.summary.networkRequests = s.networkRequests.length;
      markFresh(s, 'network-hook', Date.now());
      await _flushNetwork(s);
      break;
    }

    case 'NETWORK_RESPONSE': {
      const requestId       = payload.requestId != null ? payload.requestId : payload.reqId;
      const { status }      = payload;
      const responseHeaders = payload.responseHeaders || payload.headers || null;
      const responseBody    = payload.responseBody != null ? payload.responseBody : (payload.bodyPreview != null ? payload.bodyPreview : null);
      const req = requestId != null ? s.networkRequests.find(r => r.requestId === requestId) : null;
      if (req) {
        // Guard status: streaming connections (WS/SSE) send throttled mid-stream
        // frame summaries with no status, which must not wipe the open/close code.
        if (status != null) req.status = status;
        // injected sends no duration; derive it from request/response timestamps.
        req.duration = payload.duration != null ? payload.duration
          : (payload.ts != null && req.startTime != null ? payload.ts - req.startTime : req.duration ?? null);
        if (responseHeaders) req.responseHeaders = responseHeaders;
        if (responseBody != null) req.responseBody = responseBody;
        // WebSocket / EventSource running frame summary (counts/bytes/samples).
        if (payload.frames) req.frames = payload.frames;
        if (payload.tokens) req.tokens = payload.tokens;
      }
      await _flushNetwork(s);
      break;
    }

    case 'NETWORK_ERROR': {
      const requestId = payload.requestId != null ? payload.requestId : payload.reqId;
      const req = requestId != null ? s.networkRequests.find(r => r.requestId === requestId) : null;
      if (req) {
        req.error = payload.error || 'error';
        if (req.status == null) req.status = 'error';
        if (req.duration == null && payload.ts != null && req.startTime != null) req.duration = payload.ts - req.startTime;
      } else {
        // Error fired without a recorded request — keep a minimal failed entry so
        // the failure is still visible rather than silently dropped.
        s.networkRequests.push({
          requestId, url: payload.url, method: payload.method || null,
          startTime: payload.ts || Date.now(), initiatorType: null,
          requestHeaders: null, requestBody: null, tokens: null,
          status: 'error', duration: null, responseHeaders: null, responseBody: null,
          error: payload.error || 'error',
        });
        s.index.summary.networkRequests = s.networkRequests.length;
      }
      markFresh(s, 'network-hook', Date.now());
      await _flushNetwork(s);
      break;
    }

    case 'UI_CATALOG': {
      const fp = path.join(s.dir, 'raw/ui/elements.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.ui_catalog = 'raw/ui/elements.json';
      markFresh(s, 'ui-catalog', payload.capturedAt);
      console.log(`[cache] UI_CATALOG tabId=${tabId} buttons=${payload.counts?.buttons}`);
      break;
    }

    case 'CSS_ANALYSIS': {
      const fp = path.join(s.dir, 'raw/css/analysis.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.css_analysis = 'raw/css/analysis.json';
      markFresh(s, 'css-analyzer', payload.capturedAt);
      break;
    }

    case 'ACCESSIBILITY_TREE': {
      const fp = path.join(s.dir, 'raw/accessibility/tree.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.accessibility = 'raw/accessibility/tree.json';
      markFresh(s, 'accessibility', payload.capturedAt);
      console.log(`[cache] ACCESSIBILITY_TREE tabId=${tabId}`);
      break;
    }

    case 'STORAGE_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/storage/data.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.storage = 'raw/storage/data.json';
      markFresh(s, 'storage-reader', payload.capturedAt);
      break;
    }

    case 'CONSOLE_LOG': {
      s.consoleLogs.push(...(payload.entries || [payload]));
      if (s.consoleLogs.length > 2000) s.consoleLogs.splice(0, s.consoleLogs.length - 2000);
      s.index.summary.consoleLogs = s.consoleLogs.length;
      const fp = path.join(s.dir, 'raw/console/logs.json');
      await writeJsonAsync(fp, { capturedAt: Date.now(), totalEntries: s.consoleLogs.length, entries: s.consoleLogs });
      s.index.files.raw.console_logs = 'raw/console/logs.json';
      markFresh(s, 'console-logger', Date.now());
      break;
    }

    case 'PERF_METRICS': {
      const fp = path.join(s.dir, 'raw/perf/metrics.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.perf = 'raw/perf/metrics.json';
      markFresh(s, 'perf-analyzer', payload.capturedAt);
      break;
    }

    case 'SOURCE_CATALOG': {
      const fp = path.join(s.dir, 'raw/sources/catalog.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.sources = 'raw/sources/catalog.json';
      break;
    }

    case 'PAGE_NAVIGATED': {
      // Page navigated: clear stale data, update URL
      s.index.url = payload.url || s.index.url;
      s.index.title = payload.title || s.index.title;
      s.networkRequests = [];
      s.consoleLogs = [];
      s.index.dataFreshness = {};
      s.index.summary.networkRequests = 0;
      s.index.summary.consoleLogs = 0;
      s.index.summary.textWordCount = 0;
      s.viewport = null;
      // Delete stale visual files so dashboard never loads old page data
      const textCoordsPath = path.join(s.dir, 'raw/visual/text-coords.json');
      const viewportPath = path.join(s.dir, 'raw/visual/viewport.json');
      try { await fsp.unlink(textCoordsPath); } catch (_) {}
      try { await fsp.unlink(viewportPath); } catch (_) {}
      console.log(`[cache] PAGE_NAVIGATED tabId=${tabId} url=${payload.url}`);
      break;
    }

    case 'VIEWPORT_UPDATE': {
      s.viewport = payload;
      const fp = path.join(s.dir, 'raw/visual/viewport.json');
      await writeJsonAsync(fp, payload);
      s.index.files.raw.viewport = 'raw/visual/viewport.json';
      break;
    }
  }

  await updateIndexAsync(s);
}

async function _flushNetwork(session) {
  const fp = path.join(session.dir, 'raw/network/requests.json');
  await writeJsonAsync(fp, {
    capturedAt: Date.now(),
    totalRequests: session.networkRequests.length,
    requests: session.networkRequests,
  });
  session.index.files.raw.network = 'raw/network/requests.json';
}

// ── Query API ────────────────────────────────────────────────────────────────

// opts.brief === true drops the per-plugin freshnessMap, which is the bulk of each
// entry's size (13-14 plugins × 3 fields). The brief list is for *discovery* (which
// tabs exist); per-tab freshness detail lives in getSessionData (get_index). Default
// stays full for backward compatibility — internal callers (/health count, dashboard,
// capture lookup) are unaffected.
function getSessionList(opts = {}) {
  const now = Date.now();
  const brief = opts.brief === true;
  return [...sessions.entries()].map(([tabId, s]) => {
    const closedAt = s.closedAt || s.index.closedAt || null;
    const entry = {
      tabId,
      url:       s.index.url,
      title:     s.index.title,
      createdAt: s.index.createdAt,
      updatedAt: s.updatedAt,
      dataAgeMs: now - s.updatedAt,
      isStale:   (now - s.updatedAt) > STALE_THRESHOLD_MS,
      keep:      !!s.keep,
      // Tab no longer exists in the browser — data is read-only history and the
      // session will be auto-removed after the closed-session retention window.
      ...(closedAt ? { closed: true, closedAt } : {}),
      summary:   s.index.summary,
    };
    if (brief) return entry;
    entry.freshnessMap = Object.fromEntries(
      Object.entries(s.index.dataFreshness).map(([k, v]) => [k, { capturedAt: v, ageMs: now - v, isStale: (now - v) > STALE_THRESHOLD_MS }])
    );
    return entry;
  });
}

function getSessionData(tabId) {
  const s = sessions.get(tabId);
  if (!s) return null;
  const now = Date.now();
  return {
    ...s.index,
    dataAgeMs: now - s.updatedAt,
    isStale:   (now - s.updatedAt) > STALE_THRESHOLD_MS,
  };
}

function getSessionDir(tabId) {
  return sessions.get(tabId)?.dir || null;
}

function readSessionFile(tabId, relPath) {
  const dir = getSessionDir(tabId);
  if (!dir) return null;
  const resolved = path.resolve(path.join(dir, relPath));
  const normalizedDir = path.resolve(dir) + path.sep;
  if (!resolved.startsWith(normalizedDir)) {
    console.error(`[cache] readSessionFile: blocked path traversal (tabId=${tabId}, relPath=${relPath})`);
    return null;
  }
  return readJson(resolved);
}

function getConsoleLogs(tabId) {
  return sessions.get(tabId)?.consoleLogs || [];
}

function freshnessInfo(tabId, pluginId) {
  const s = sessions.get(tabId);
  if (!s) return null;
  const capturedAt = s.index.dataFreshness[pluginId];
  if (!capturedAt) return { available: false };
  const ageMs = Date.now() - capturedAt;
  return { available: true, capturedAt, ageMs, isStale: ageMs > STALE_THRESHOLD_MS };
}

// Remove a session (tab closed / cleanup)
function removeSession(tabId) {
  const s = sessions.get(tabId);
  if (s) {
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (_) {}
  }
  sessions.delete(tabId);
}

// The browser tab was closed (TAB_CLOSED from the extension). Mark rather than
// delete: the session stays readable for CLOSED_SESSION_RETENTION_MS so a
// just-finished flow can still be inspected, then the sweep removes it.
// Persisted into _index.json so the retention also applies across restarts.
function markSessionClosed(tabId) {
  const s = sessions.get(tabId);
  if (!s) return false;
  s.closedAt = Date.now();
  s.index.closedAt = s.closedAt;
  writeJson(path.join(s.dir, '_index.json'), s.index);
  return true;
}

function setSessionKeep(tabId, keep) {
  const s = sessions.get(tabId);
  if (s) s.keep = !!keep;
}

// Smart delta storage (aggregated from delta-engine)
function storeSmartDelta(tabId, delta) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.smartDelta = delta;
  s.smartDeltaAt = Date.now();
}

function getSmartDelta(tabId) {
  const s = sessions.get(tabId);
  if (!s || !s.smartDelta) return null;
  return {
    ...s.smartDelta,
    ageMs: Date.now() - (s.smartDeltaAt || 0),
    isStale: (Date.now() - (s.smartDeltaAt || 0)) > STALE_THRESHOLD_MS,
  };
}

// Best-effort SYNCHRONOUS flush of all in-memory session state. Used by the
// shutdown/crash handlers in index.js so a restart loses as little as possible.
// Must stay synchronous (no await): an uncaughtException handler runs with the
// event loop in an undefined state, so we cannot rely on async I/O completing.
// Every write is individually guarded — one bad session must not abort the rest.
function flushAllSync() {
  let flushed = 0;
  for (const s of sessions.values()) {
    try {
      if (Array.isArray(s.networkRequests) && s.networkRequests.length) {
        writeJson(path.join(s.dir, 'raw/network/requests.json'), {
          capturedAt: Date.now(),
          totalRequests: s.networkRequests.length,
          requests: s.networkRequests,
        });
        s.index.files.raw.network = 'raw/network/requests.json';
      }
      if (Array.isArray(s.consoleLogs) && s.consoleLogs.length) {
        writeJson(path.join(s.dir, 'raw/console/logs.json'), {
          capturedAt: Date.now(),
          totalEntries: s.consoleLogs.length,
          entries: s.consoleLogs,
        });
        s.index.files.raw.console = 'raw/console/logs.json';
      }
      s.index.updatedAt = Date.now();
      writeJson(path.join(s.dir, '_index.json'), s.index);
      flushed++;
    } catch (_) { /* keep going — partial flush beats no flush */ }
  }
  return flushed;
}

module.exports = {
  handleMessage, getSessionList, getSessionData, getSessionDir,
  readSessionFile, getConsoleLogs, freshnessInfo, removeSession,
  markSessionClosed,
  storeSmartDelta, getSmartDelta, setSessionKeep, setSelfOrigin,
  loadSessionsFromDisk, flushAllSync,
  // exposed for tests
  isSelfOrigin, _renameWithRetryAsync, _renameWithRetrySync, RENAME_BACKOFFS_MS,
};
