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

const CACHE_ROOT = path.join(__dirname, '..', 'cache', 'sessions');
fs.mkdirSync(CACHE_ROOT, { recursive: true });

const STALE_THRESHOLD_MS = 30_000; // 30s

// tabId → { dir, index, networkRequests[], consoleLogs[], updatedAt }
const sessions = new Map();

// ── helpers ──────────────────────────────────────────────────────────────────

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function writeJson(filePath, data) {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[cache] writeJson error:', e.message, filePath);
  }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function getSession(tabId, url, siteVersion) {
  if (!sessions.has(tabId)) {
    const sessionId = Date.now();
    const siteDir = (siteVersion || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const dir = path.join(CACHE_ROOT, siteDir, `${tabId}-${sessionId}`);

    for (const sub of ['raw/react','raw/vue','raw/angular','raw/svelte','raw/dom',
                        'raw/visual','raw/network','raw/css','raw/ui',
                        'raw/accessibility','raw/storage','raw/perf','raw/console','raw/sources']) {
      ensureDir(path.join(dir, sub));
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

    sessions.set(tabId, { dir, index, networkRequests: [], consoleLogs: [], updatedAt: Date.now() });
    writeJson(path.join(dir, '_index.json'), index);
  }
  return sessions.get(tabId);
}

function updateIndex(session) {
  session.index.updatedAt = Date.now();
  writeJson(path.join(session.dir, '_index.json'), session.index);
}

function markFresh(session, pluginId, capturedAt) {
  session.index.dataFreshness[pluginId] = capturedAt || Date.now();
}

// ── public API ────────────────────────────────────────────────────────────────

function handleMessage(msg) {
  const { type, tabId, tabUrl, payload, siteVersion } = msg;
  if (!tabId) return;

  const s = getSession(tabId, tabUrl, siteVersion || 'default');
  s.updatedAt = Date.now();
  if (tabUrl && !s.index.url) { s.index.url = tabUrl; }

  switch (type) {

    case 'FRAMEWORK_DETECTION': {
      s.index.summary.detectedFrameworks = payload.detected.map(d => d.frameworkId || d.id);
      markFresh(s, 'framework-detection', payload.capturedAt);
      console.error(`[cache] FRAMEWORK_DETECTION tabId=${tabId}:`, s.index.summary.detectedFrameworks.join(', '));
      break;
    }

    case 'REACT_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/react/snapshot.json');
      writeJson(fp, payload);
      s.index.files.raw.react_snapshot = 'raw/react/snapshot.json';
      markFresh(s, 'react-fiber', payload.capturedAt);
      console.error(`[cache] REACT_SNAPSHOT tabId=${tabId}`);
      break;
    }

    case 'REACT_TRANSITION': {
      // Accumulate state-transition log (capped by config maxReactStateHistory)
      if (!s.reactTransitions) s.reactTransitions = [];
      s.reactTransitions.push(payload);
      const maxHistory = 100; // reasonable cap; could be wired to config
      if (s.reactTransitions.length > maxHistory) {
        s.reactTransitions.splice(0, s.reactTransitions.length - maxHistory);
      }
      const fp = path.join(s.dir, 'raw/react/transitions.json');
      writeJson(fp, { capturedAt: Date.now(), totalTransitions: s.reactTransitions.length, transitions: s.reactTransitions });
      s.index.files.raw.react_transitions = 'raw/react/transitions.json';
      s.index.summary.reactTransitions = s.reactTransitions.length;
      console.error(`[cache] REACT_TRANSITION tabId=${tabId} total=${s.reactTransitions.length}`);
      break;
    }

    case 'VUE_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/vue/snapshot.json');
      writeJson(fp, payload);
      s.index.files.raw.vue_snapshot = 'raw/vue/snapshot.json';
      markFresh(s, 'vue3', payload.capturedAt);
      break;
    }

    case 'VUE2_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/vue/vue2-snapshot.json');
      writeJson(fp, payload);
      s.index.files.raw.vue2_snapshot = 'raw/vue/vue2-snapshot.json';
      markFresh(s, 'vue2', payload.capturedAt);
      break;
    }

    case 'ANGULAR_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/angular/snapshot.json');
      writeJson(fp, payload);
      s.index.files.raw.angular_snapshot = 'raw/angular/snapshot.json';
      markFresh(s, 'angular', payload.capturedAt);
      break;
    }

    case 'SVELTE_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/svelte/snapshot.json');
      writeJson(fp, payload);
      s.index.files.raw.svelte_snapshot = 'raw/svelte/snapshot.json';
      markFresh(s, 'svelte', payload.capturedAt);
      break;
    }

    case 'DOM_GENERIC_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/dom/snapshot.json');
      writeJson(fp, payload);
      s.index.files.raw.dom_generic = 'raw/dom/snapshot.json';
      s.index.title = payload.docTitle || null;
      markFresh(s, 'dom-generic', payload.capturedAt);
      break;
    }

    case 'TEXT_COORDS': {
      const fp = path.join(s.dir, 'raw/visual/text-coords.json');
      
      // Merge with existing cache to retain offscreen/seen texts
      let existing = {};
      try {
        if (fs.existsSync(fp)) {
          existing = JSON.parse(fs.readFileSync(fp, 'utf8'));
        }
      } catch (_) {}

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

      writeJson(fp, merged);
      s.index.files.raw.text_coords = 'raw/visual/text-coords.json';
      s.index.summary.textWordCount = merged.totalWords || 0;
      markFresh(s, 'text-coords', payload.capturedAt);
      console.error(`[cache] TEXT_COORDS tabId=${tabId} words=${merged.totalWords} (merged: ${existing.words?.length || 0} old)`);
      break;
    }

    case 'NETWORK_REQUEST': {
      const { requestId, method, url: reqUrl, startTime, requestHeaders, requestBody, initiatorType } = payload;
      const req = { requestId, method, url: reqUrl, startTime, initiatorType, requestHeaders, requestBody, status: null, duration: null, responseHeaders: null, responseBody: null };
      const idx = s.networkRequests.findIndex(r => r.requestId === requestId);
      if (idx === -1) s.networkRequests.push(req);
      s.index.summary.networkRequests = s.networkRequests.length;
      markFresh(s, 'network-hook', Date.now());
      _flushNetwork(s);
      break;
    }

    case 'NETWORK_RESPONSE': {
      const { requestId, status, duration, responseHeaders, responseBody, tokens } = payload;
      const req = s.networkRequests.find(r => r.requestId === requestId);
      if (req) {
        req.status = status;
        req.duration = duration;
        req.responseHeaders = responseHeaders;
        req.responseBody = responseBody;
        req.tokens = tokens;
      }
      _flushNetwork(s);
      break;
    }

    case 'UI_CATALOG': {
      const fp = path.join(s.dir, 'raw/ui/elements.json');
      writeJson(fp, payload);
      s.index.files.raw.ui_catalog = 'raw/ui/elements.json';
      markFresh(s, 'ui-catalog', payload.capturedAt);
      console.error(`[cache] UI_CATALOG tabId=${tabId} buttons=${payload.counts?.buttons}`);
      break;
    }

    case 'CSS_ANALYSIS': {
      const fp = path.join(s.dir, 'raw/css/analysis.json');
      writeJson(fp, payload);
      s.index.files.raw.css_analysis = 'raw/css/analysis.json';
      markFresh(s, 'css-analyzer', payload.capturedAt);
      break;
    }

    case 'ACCESSIBILITY_TREE': {
      const fp = path.join(s.dir, 'raw/accessibility/tree.json');
      writeJson(fp, payload);
      s.index.files.raw.accessibility = 'raw/accessibility/tree.json';
      markFresh(s, 'accessibility', payload.capturedAt);
      console.error(`[cache] ACCESSIBILITY_TREE tabId=${tabId}`);
      break;
    }

    case 'STORAGE_SNAPSHOT': {
      const fp = path.join(s.dir, 'raw/storage/data.json');
      writeJson(fp, payload);
      s.index.files.raw.storage = 'raw/storage/data.json';
      markFresh(s, 'storage-reader', payload.capturedAt);
      break;
    }

    case 'CONSOLE_LOG': {
      s.consoleLogs.push(...(payload.entries || [payload]));
      if (s.consoleLogs.length > 2000) s.consoleLogs.splice(0, s.consoleLogs.length - 2000);
      s.index.summary.consoleLogs = s.consoleLogs.length;
      const fp = path.join(s.dir, 'raw/console/logs.json');
      writeJson(fp, { capturedAt: Date.now(), totalEntries: s.consoleLogs.length, entries: s.consoleLogs });
      s.index.files.raw.console_logs = 'raw/console/logs.json';
      markFresh(s, 'console-logger', Date.now());
      break;
    }

    case 'PERF_METRICS': {
      const fp = path.join(s.dir, 'raw/perf/metrics.json');
      writeJson(fp, payload);
      s.index.files.raw.perf = 'raw/perf/metrics.json';
      markFresh(s, 'perf-analyzer', payload.capturedAt);
      break;
    }

    case 'SOURCE_CATALOG': {
      const fp = path.join(s.dir, 'raw/sources/catalog.json');
      writeJson(fp, payload);
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
      s.viewport = null;
      console.error(`[cache] PAGE_NAVIGATED tabId=${tabId} url=${payload.url}`);
      break;
    }

    case 'VIEWPORT_UPDATE': {
      s.viewport = payload;
      const fp = path.join(s.dir, 'raw/visual/viewport.json');
      writeJson(fp, payload);
      s.index.files.raw.viewport = 'raw/visual/viewport.json';
      break;
    }
  }

  updateIndex(s);
}

function _flushNetwork(session) {
  const fp = path.join(session.dir, 'raw/network/requests.json');
  writeJson(fp, {
    capturedAt: Date.now(),
    totalRequests: session.networkRequests.length,
    requests: session.networkRequests,
  });
  session.index.files.raw.network = 'raw/network/requests.json';
}

// ── Query API ────────────────────────────────────────────────────────────────

function getSessionList() {
  const now = Date.now();
  return [...sessions.entries()].map(([tabId, s]) => ({
    tabId,
    url:       s.index.url,
    title:     s.index.title,
    createdAt: s.index.createdAt,
    updatedAt: s.updatedAt,
    dataAgeMs: now - s.updatedAt,
    isStale:   (now - s.updatedAt) > STALE_THRESHOLD_MS,
    summary:   s.index.summary,
    freshnessMap: Object.fromEntries(
      Object.entries(s.index.dataFreshness).map(([k, v]) => [k, { capturedAt: v, ageMs: now - v, isStale: (now - v) > STALE_THRESHOLD_MS }])
    ),
  }));
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
  return readJson(path.join(dir, relPath));
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

// Remove a session (tab closed)
function removeSession(tabId) {
  sessions.delete(tabId);
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

module.exports = {
  handleMessage, getSessionList, getSessionData, getSessionDir,
  readSessionFile, getConsoleLogs, freshnessInfo, removeSession,
  storeSmartDelta, getSmartDelta,
};
