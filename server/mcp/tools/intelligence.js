/**
 * server/mcp/tools/intelligence.js
 * INTELLIGENCEカテゴリのMCPツール定義とハンドラ。
 *
 * Tools:
 *   analyze_click        — dry-run clickability analysis (existing)
 *   explain_element      — CSS origin + component + causal chain for a selector
 *   why_did_this_change  — causal chains for a selector within a time window
 *   get_source_file      — text content of a CSS/JS file by URL
 *   detect_site_updates  — SOURCE_CHANGED events since last session
 */
'use strict';

const path = require('path');
const { generateAsciiGraph } = require('../../state-visualizer');
const conclusionCache = require('../../conclusion-cache');
const SourceMapResolver = require('../../source-map-resolver');

// Shared resolver instance (LRU cache, max 10 maps, 4MB limit per map)
const _sourceMapResolver = new SourceMapResolver();

module.exports = function registerIntelligenceTools(registry) {
  const tools = [];

  // ── analyze_click ─────────────────────────────────────────────────────────
  tools.push({
    definition: {
      name: 'analyze_click',
      description: 'Dry-run clickability analysis. Returns ClickabilityReport without executing the click. Reveals whether an element exists, is visible, is in the viewport, has pointer-events enabled, is disabled, or is obstructed by a modal/overlay — plus the recommended click strategy.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID' },
          selector: { type: 'string', description: 'CSS selector' },
          text:     { type: 'string', description: 'Visible text of element (partial match, case-insensitive)' },
          x:        { type: 'number', description: 'Absolute X coordinate' },
          y:        { type: 'number', description: 'Absolute Y coordinate' },
          timeoutMs: { type: 'number', description: 'Action timeout in milliseconds' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, {
        type: 'analyze_click',
        selector: args.selector,
        text: args.text,
        x: args.x,
        y: args.y,
      }, args.timeoutMs || 10000);
    },
  });

  // ── explain_element ───────────────────────────────────────────────────────
  tools.push({
    definition: {
      name: 'explain_element',
      description: 'Comprehensive explanation of a DOM element: which CSS rules apply (and from which source file), which framework component owns it, and what recent network/framework events caused it to change. Triggers on-demand collection if data is stale. Returns conclusions with explicit confidence scores.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:      { type: 'number', description: 'Tab ID' },
          selector:   { type: 'string', description: 'CSS selector for the target element' },
          properties: {
            type: 'array',
            items: { type: 'string' },
            description: 'CSS properties to analyse (e.g. ["color","background","display"]). Omit to analyse up to 20 computed properties.',
          },
          sinceMs: { type: 'number', description: 'How far back to look for causal events (ms, default 5000)' },
          timeoutMs: { type: 'number', description: 'Timeout for on-demand collection (ms, default 8000)' },
        },
        required: ['tabId', 'selector'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      if (!cache) return { error: 'Cache service not available.' };
      const tabId = args.tabId;
      const selector = args.selector;
      const timeoutMs = args.timeoutMs || 8000;
      const sinceMs   = args.sinceMs   || 5000;

      // [0] Conclusion cache check — skip full collection if page state is unchanged
      const sessionDir       = cache.getSessionDir ? cache.getSessionDir(tabId) : null;
      const cssOriginPath    = sessionDir ? require('path').join(sessionDir, 'raw/intelligence/css-origin-map.json')    : null;
      const frameworkMapPath = sessionDir ? require('path').join(sessionDir, 'raw/intelligence/framework-dom-map.json') : null;
      const cachedHash       = cache.readSessionFile(tabId, 'raw/intelligence/_conclusion-key.json');
      const invalidationKey  = conclusionCache.buildInvalidationKey(
        cachedHash?.compositeHash,
        conclusionCache.fileContentHash(cssOriginPath),
        conclusionCache.fileContentHash(frameworkMapPath)
      );
      const cached = conclusionCache.get(tabId, selector, invalidationKey);
      if (cached) return { ...cached, _fromCache: true };

      // [1] Trigger on-demand collection: css-origin + framework-dom-map
      if (cb._triggerCollect) {
        cb._triggerCollect(tabId, ['css-origin', 'framework-dom-map'], {
          targetSelector: selector,
          properties: args.properties || null,
        });
        // Wait for data to arrive (event-driven via collect callback + timeout fallback)
        const data = await _waitForCollectEvent(cache, tabId, 'raw/intelligence/css-origin-map.json', timeoutMs, cb);
      }

      // [2] Read from session cache
      const cssOriginMap   = cache.readSessionFile(tabId, 'raw/intelligence/css-origin-map.json');
      const frameworkMap   = cache.readSessionFile(tabId, 'raw/intelligence/framework-dom-map.json');
      const causalChains   = cache.readSessionFile(tabId, 'raw/intelligence/causal-chains.json');

      // [3] Filter CSS origin data for our selector
      let styles = [];
      if (cssOriginMap && cssOriginMap.entries) {
        const entry = cssOriginMap.entries.find(e =>
          e.element?.selector === selector ||
          (e.element?.selector && selector.includes(e.element.selector))
        );
        if (entry && entry.properties) {
          styles = Object.entries(entry.properties).map(([prop, data]) => {
            const rule = data.rule || null;
            const sourceOrigin = rule?.originalFile
              ? { file: rule.originalFile, line: rule.originalLine }
              : rule?.sheetHref
                ? { file: rule.sheetHref, line: rule.sourceLine }
                : null;
            return {
              property: prop,
              value:    data.computedValue,
              source:   data.source,
              rule,
              sourceOrigin,
              acquisition_level: data.acquisition_level,
              confidence: data.confidence,
            };
          });
        }
      }

      // [4] Filter framework-dom-map for our selector
      let component = null;
      if (frameworkMap && Array.isArray(frameworkMap.entries)) {
        const entry = frameworkMap.entries.find(e => e.domSelector === selector);
        if (entry) component = entry.component;
      } else if (frameworkMap && frameworkMap.component) {
        component = frameworkMap.component;
      }

      // [4b] Task 3: resolve source map for React component if sourceHint is present.
      // sourceHint = { compiledFile, compiledLine, compiledColumn } from framework-dom-map.js.
      // SourceMapResolver maps the compiled bundle position → original .tsx/.jsx position.
      if (component && component.sourceHint) {
        try {
          const { compiledFile, compiledLine, compiledColumn } = component.sourceHint;
          const resolved = await _sourceMapResolver.resolve(compiledFile, compiledLine, compiledColumn);
          if (resolved) {
            // Prefer resolved original source over raw compiled file names
            component = {
              ...component,
              sourceFile: resolved.originalFile,
              sourceLine: resolved.originalLine,
              sourceHint: {
                ...component.sourceHint,
                resolvedFile:   resolved.originalFile,
                resolvedLine:   resolved.originalLine,
                resolvedColumn: resolved.originalColumn,
              },
            };
          }
        } catch (_) {
          // Source map resolution is best-effort; don't fail the whole request
        }
      }

      // [5] Filter causal chains for our selector
      let causedBy = [];
      if (Array.isArray(causalChains)) {
        const cutoff = Date.now() - sinceMs;
        causedBy = causalChains
          .filter(c =>
            c.timestamp >= cutoff &&
            (c.dom?.sampleSelectors || []).some(s =>
              s === selector || s.includes(selector) || selector.includes(s)
            )
          )
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 5);
      }

      // [6] Assemble response
      const mapConfidence = styles.length
        ? Math.min(...styles.map(s => s.confidence))
        : null;

      const result = {
        element: { selector },
        styles,
        component: component || null,
        causedBy,
        map_confidence: mapConfidence,
        collected: {
          cssOrigin:    !!cssOriginMap,
          frameworkMap: !!frameworkMap,
          causalChains: causalChains ? (Array.isArray(causalChains) ? causalChains.length : 0) : 0,
        },
      };

      // Store in conclusion cache for future requests
      if (invalidationKey) {
        conclusionCache.set(tabId, selector, invalidationKey, result);
      }

      return result;
    },
  });

  // ── why_did_this_change ───────────────────────────────────────────────────
  tools.push({
    definition: {
      name: 'why_did_this_change',
      description: 'Returns the most likely causal chains explaining why a DOM element changed recently. Looks up network responses and framework state transitions that preceded the change. Returns up to 3 chains sorted by confidence.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID' },
          selector: { type: 'string', description: 'CSS selector for the element that changed' },
          sinceMs:  { type: 'number', description: 'Look-back window in milliseconds (default 5000)' },
          limit:    { type: 'number', description: 'Max chains to return (default 3)' },
        },
        required: ['tabId', 'selector'],
      },
    },
    handler: async (args, cb) => {
      const cache  = cb.cache;
      if (!cache) return { error: 'Cache service not available.' };

      // Also check in-memory correlator chains if available
      const correlator = cb._correlator;
      const sinceMs    = args.sinceMs || 5000;
      const limit      = args.limit   || 3;

      let chains = [];

      // From in-memory correlator (most recent)
      if (correlator) {
        chains = correlator.getChains(args.tabId, {
          sinceMs,
          selector: args.selector,
          limit: limit * 2,
        });
      }

      // From persisted causal-chains.json
      const persisted = cache.readSessionFile(args.tabId, 'raw/intelligence/causal-chains.json');
      if (Array.isArray(persisted)) {
        const cutoff = Date.now() - sinceMs;
        const filtered = persisted.filter(c =>
          c.timestamp >= cutoff &&
          (c.dom?.sampleSelectors || []).some(s =>
            s === args.selector || s.includes(args.selector) || args.selector.includes(s)
          )
        );
        chains = [...chains, ...filtered];
      }

      // Deduplicate by id, sort by confidence
      const seen = new Set();
      chains = chains
        .filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; })
        .sort((a, b) => b.confidence - a.confidence || b.timestamp - a.timestamp)
        .slice(0, limit);

      return {
        selector: args.selector,
        sinceMs,
        chains,
        count: chains.length,
        note: chains.length === 0
          ? 'No causal chains found. The element may not have changed recently, or correlation data has not been collected yet.'
          : undefined,
      };
    },
  });

  // ── get_source_file ───────────────────────────────────────────────────────
  tools.push({
    definition: {
      name: 'get_source_file',
      description: 'Returns the text content of a CSS or JavaScript file referenced by the current page. Uses Source Layer cache; triggers a fetch from the extension if the file is not cached. Useful for understanding which CSS rules are defined in a stylesheet.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:   { type: 'number', description: 'Tab ID' },
          url:     { type: 'string', description: 'URL of the CSS or JS file' },
          hashOnly: { type: 'boolean', description: 'Return hash only, no content (default false)' },
        },
        required: ['tabId', 'url'],
      },
    },
    handler: async (args, cb) => {
      const cache       = cb.cache;
      const sourceStore = cb._sourceStore;
      if (!cache) return { error: 'Cache service not available.' };

      const sessionDir = cache.getSessionDir ? cache.getSessionDir(args.tabId) : null;

      // Try source-store first
      if (sourceStore) {
        const entry = sourceStore.getSourceFile(args.url, sessionDir);
        if (entry) {
          if (args.hashOnly) {
            return { url: args.url, hash: entry.hash, byteLength: entry.byteLength, kind: entry.kind, acquiredAt: entry.acquiredAt };
          }
          if (entry.content) {
            return { url: args.url, hash: entry.hash, byteLength: entry.byteLength, kind: entry.kind, content: entry.content, acquiredAt: entry.acquiredAt };
          }
        }
      }

      // Trigger on-demand fetch from extension
      if (cb._triggerCollect) {
        cb._triggerCollect(args.tabId, ['source-fetcher'], { urls: [args.url] });
        await _waitMs(3000);

        if (sourceStore) {
          const entry = sourceStore.getSourceFile(args.url, sessionDir);
          if (entry && entry.content) {
            return { url: args.url, hash: entry.hash, byteLength: entry.byteLength, kind: entry.kind, content: entry.content, acquiredAt: entry.acquiredAt };
          }
        }
      }

      return {
        url: args.url,
        error: 'Source file not available. The file may be cross-origin with no CORS headers, or the URL is not a CSS/JS resource.',
        suggestion: 'Try get_css_analysis for computed CSS data, or check the network tab for the file URL.',
      };
    },
  });

  // ── detect_site_updates ───────────────────────────────────────────────────
  tools.push({
    definition: {
      name: 'detect_site_updates',
      description: 'Returns SOURCE_CHANGED events detected since the last session — CSS or JS files that have changed between visits. Useful for detecting deploys or hotfixes between agent sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID (used to scope session context)' },
          sinceMs:  { type: 'number', description: 'Look-back window in ms (default: 86400000 = 24h)' },
          kindFilter: {
            type: 'string',
            enum: ['css', 'js', 'all'],
            description: 'Filter by file type (default: all)',
          },
        },
        required: [],
      },
    },
    handler: async (args, cb) => {
      const sourceStore = cb._sourceStore;
      if (!sourceStore) {
        return { error: 'Source store not available. Intelligence layer may not be initialised.' };
      }

      const sinceMs = args.sinceMs || 86400000;
      const kind    = args.kindFilter || 'all';

      let entries = sourceStore.getRecentChanges(sinceMs);

      if (kind !== 'all') {
        entries = entries.filter(e => e.kind === kind);
      }

      // Also check persisted SOURCE_CHANGED events in the session cache
      const cache = cb.cache;
      if (cache && args.tabId) {
        const persisted = cache.readSessionFile(args.tabId, 'raw/intelligence/source-changes.json');
        if (Array.isArray(persisted)) {
          const cutoff = Date.now() - sinceMs;
          const extra  = persisted.filter(e => e.detectedAt >= cutoff && (kind === 'all' || e.kind === kind));
          entries = [...entries, ...extra];
        }
      }

      // Deduplicate by URL, keep latest
      const byUrl = new Map();
      for (const e of entries) {
        if (!byUrl.has(e.url) || e.acquiredAt > byUrl.get(e.url).acquiredAt) {
          byUrl.set(e.url, e);
        }
      }

      const results = [...byUrl.values()].sort((a, b) => (b.acquiredAt || 0) - (a.acquiredAt || 0));

      return {
        count:   results.length,
        sinceMs,
        entries: results,
        note:    results.length === 0
          ? 'No source file changes detected. Either the site has not changed or source files have not been fetched yet.'
          : undefined,
      };
    },
  });

  // ── get_state_map_visual ──────────────────────────────────────────────────
  tools.push({
    definition: {
      name: 'get_state_map_visual',
      description: 'Returns an ASCII-art state graph for the current site. Shows the navigation topology (● root, ○ visited, ◎ pinned nodes) with edge labels indicating the actions that triggered each transition. Useful for understanding what states the agent has explored and how they relate.',
      inputSchema: {
        type: 'object',
        properties: {
          siteVersion: {
            type: 'string',
            description: 'Site version key. Defaults to the "default" graph when omitted.',
          },
          maxNodes: {
            type: 'number',
            description: 'Maximum nodes to render (default 40).',
          },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const siteVersion = args.siteVersion || 'default';
      const maxNodes = args.maxNodes || 40;
      const graph = generateAsciiGraph(siteVersion, maxNodes);
      return { siteVersion, graph };
    },
  });

  registry.registerTools(tools);
};

// ── Utility: wait for a session file to appear ────────────────────────────────
// Uses a one-shot event listener on the cache, with polling fallback.
async function _waitForCollectEvent(cache, tabId, filePath, timeoutMs, cb) {
  const start = Date.now();

  // Check immediately
  const immediate = cache.readSessionFile(tabId, filePath);
  if (immediate) return immediate;

  // Event-driven: wait for collect to complete (via typed callback)
  if (cb._onCollectComplete) {
    const eventResult = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const unsub = cb._onCollectComplete(tabId, () => {
        clearTimeout(timer);
        unsub();
        const data = cache.readSessionFile(tabId, filePath);
        resolve(data);
      });
    });
    if (eventResult) return eventResult;
  }

  // Fallback: poll with decreasing frequency
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const interval = remaining > 2000 ? 500 : 200;
    await new Promise(r => setTimeout(r, interval));
    const data = cache.readSessionFile(tabId, filePath);
    if (data) return data;
  }
  return null;
}

function _waitMs(ms) {
  return new Promise(r => setTimeout(r, ms));
}
