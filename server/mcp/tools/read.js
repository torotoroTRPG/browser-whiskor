/**
 * server/mcp/tools/read.js
 * READカテゴリのMCPツール定義とハンドラ。
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// ── Fuzzy text matching ──────────────────────────────────────────────────────
function tokenize(str) {
  return (str || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
}

function bigramSet(str) {
  const s = str.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) { if (b.has(x)) inter++; }
  return inter / (a.size + b.size - inter);
}

function fuzzyScore(query, target) {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (t.includes(q)) return 1.0;
  const qTok = new Set(tokenize(q));
  const tTok = new Set(tokenize(t));
  const tokenSim = jaccard(qTok, tTok);
  const qBi = bigramSet(q);
  const tBi = bigramSet(t);
  const bigramSim = jaccard(qBi, tBi);
  const bw = q.length < 5 ? 0.6 : 0.3;
  return Math.round((tokenSim * (1 - bw) + bigramSim * bw) * 1000) / 1000;
}

// ── Helper ────────────────────────────────────────────────────────────────────
function withFreshness(tabId, pluginId, data, cache) {
  if (!data) return null;
  const info = cache.freshnessInfo(tabId, pluginId);
  const warnings = [];

  if (info && info.isStale) {
    warnings.push({
      code: 'STALE_DATA',
      ageMs: info.ageMs,
      message: `Data is ${Math.round(info.ageMs / 1000)}s old (threshold: 30s). Consider calling refresh_data.`,
    });
  }

  if (data.note) {
    warnings.push({ code: 'ADAPTER_LIMITED', message: data.note });
  }

  if (pluginId === 'solid' && data) {
    if (!data.ownerTree && !data.stores && !data.signals && data.hydrationKeys?.length === 0) {
      warnings.push({ code: 'PARTIAL_TREE', message: 'SolidJS:only hydration markers found. Owner tree, stores, and signals not available (likely production build).' });
    }
  }
  if (pluginId === 'svelte' && data) {
    if (!data.components?.length && !data.ownerTree && !data.stores && data.scopedHashes?.length) {
      warnings.push({ code: 'PARTIAL_TREE', message: 'Svelte: only CSS scoping hashes found. Component instances not accessible (production build limitation).' });
    }
  }
  if (pluginId === 'preact' && data) {
    if (!data.componentTree && data.detectionNote) {
      warnings.push({ code: 'PARTIAL_TREE', message: data.detectionNote });
    }
  }

  if (warnings.length > 0) {
    return { ...data, _freshness: info, _warnings: warnings };
  }
  return { ...data, _freshness: info };
}

// ── Tool Definitions & Handlers ───────────────────────────────────────────────
module.exports = function registerReadTools(registry) {
  const tools = [];

  // 1. get_sessions
  tools.push({
    definition: {
      name: 'get_sessions',
      description: 'List all active inspection sessions (one per browser tab). Returns tabId, URL, title, data age, staleness flag, and a freshness map showing when each plugin last collected data. Call this first to discover available tabIds.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    handler: async (args, cb) => {
      return { sessions: cb.cache.getSessionList() };
    },
  });

  // 2. get_index
  tools.push({
    definition: {
      name: 'get_index',
      description: 'Get the full session index for a tab. Shows which data files are available, summary stats, and data freshness for each plugin. Use this to see what data is available before fetching specific files.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID from get_sessions' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const data = cb.cache.getSessionData(args.tabId);
      if (!data) return { error: `No session for tabId ${args.tabId}. Call get_sessions first.` };
      return data;
    },
  });

  // 3. get_text_coords
  tools.push({
    definition: {
      name: 'get_text_coords',
      description: 'Get all visible text on the page with absolute pixel coordinates. Use "search" for exact substring match, or "match" for fuzzy similarity search (returns results sorted by score 0.0-1.0). Each item includes a contextHint describing the element role (e.g. "navigation link", "form label", "button"). Set "inViewport: true" to return only text currently within the user\'s visible viewport area.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:      { type: 'number', description: 'Tab ID from get_sessions' },
          search:     { type: 'string', description: 'Exact substring filter (case-insensitive)' },
          match:      { type: 'string', description: 'Fuzzy similarity search — returns results sorted by match score (0.0-1.0). Use when you don\'t know the exact text.' },
          level:      { type: 'string', enum: ['words', 'lines', 'blocks', 'all'], description: 'Granularity (default: words)' },
          maxResults: { type: 'number', description: 'Max items to return. Use with "match" to get top-N results (default: 50)' },
          minScore:   { type: 'number', description: 'Minimum similarity score for "match" mode (0.0-1.0, default: 0.1)' },
          inViewport: { type: 'boolean', description: 'If true, only return text whose bounding box intersects the current viewport (based on scroll position).' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = cache.readSessionFile(args.tabId, 'raw/visual/text-coords.json');
      if (!raw) return { error: 'TEXT_COORDS not available. Trigger refresh_data first.' };

      const level      = args.level || 'words';
      const search     = args.search?.toLowerCase();
      const matchQuery = args.match;
      const maxResults = args.maxResults || 50;
      const minScore   = args.minScore != null ? args.minScore : 0.1;
      const inViewport = args.inViewport === true;

      let vp = null;
      if (inViewport) {
        const liveVp = cache.readSessionFile(args.tabId, 'raw/visual/viewport.json');
        vp = liveVp || raw.viewport || null;
      }

      function filterByViewport(items) {
        if (!vp || !items) return items;
        return items.filter(i => {
          const ix = i.absoluteX ?? i.left ?? 0;
          const iy = i.absoluteY ?? i.top ?? 0;
          const iw = i.width ?? 0;
          const ih = i.height ?? 0;
          return !(ix + iw < vp.scrollX || ix > vp.scrollX + vp.width || iy + ih < vp.scrollY || iy > vp.scrollY + vp.height);
        });
      }

      if (matchQuery) {
        if (level === 'all') {
          let wArr = raw.words || [], lArr = raw.lines || [], bArr = raw.blocks || [];
          if (inViewport) { wArr = filterByViewport(wArr); lArr = filterByViewport(lArr); bArr = filterByViewport(bArr); }
          const scored = (arr) => arr
            .map(i => ({ ...i, _score: fuzzyScore(matchQuery, i.text) }))
            .filter(i => i._score >= minScore)
            .sort((a, b) => b._score - a._score)
            .slice(0, maxResults);
          const w = scored(wArr);
          const l = scored(lArr);
          const b = scored(bArr);
          const result = {
            capturedAt: raw.capturedAt,
            pageUrl:    raw.pageUrl,
            viewport:   raw.viewport,
            query:      matchQuery,
            minScore,
            words:      w,
            lines:      l,
            blocks:     b,
          };
          if (!w.length && !l.length && !b.length) {
            result._warnings = [{ code: 'NO_MATCH', message: `No text matches "${matchQuery}" with score >= ${minScore}. Try a different query or lower minScore.` }];
          }
          return withFreshness(args.tabId, 'text-coords', result, cache);
        }
        let items = (raw[level] || raw.words || []);
        if (inViewport) items = filterByViewport(items);
        const scored = items
          .map(i => ({ ...i, _score: fuzzyScore(matchQuery, i.text) }))
          .filter(i => i._score >= minScore)
          .sort((a, b) => b._score - a._score)
          .slice(0, maxResults);
        const result = {
          capturedAt:   raw.capturedAt,
          pageUrl:      raw.pageUrl,
          viewport:     raw.viewport,
          query:        matchQuery,
          minScore,
          totalMatches: items.length,
          level,
          [level]:      items,
        };
        if (!items.length) {
          result._warnings = [{ code: 'NO_MATCH', message: `No ${level} match "${matchQuery}" with score >= ${minScore}.` }];
        }
        return withFreshness(args.tabId, 'text-coords', result, cache);
      }

      if (level === 'all') {
        let wArr = raw.words || [], lArr = raw.lines || [], bArr = raw.blocks || [];
        if (inViewport) { wArr = filterByViewport(wArr); lArr = filterByViewport(lArr); bArr = filterByViewport(bArr); }
        const result = { ...raw, words: wArr, lines: lArr, blocks: bArr };
        if (search) {
          result.words  = wArr.filter(w => w.text.toLowerCase().includes(search));
          result.lines  = lArr.filter(l => l.text.toLowerCase().includes(search));
          result.blocks = bArr.filter(b => b.text.toLowerCase().includes(search));
        }
        return withFreshness(args.tabId, 'text-coords', result, cache);
      }

      let items = raw[level] || raw.words || [];
      if (inViewport) items = filterByViewport(items);
      if (search) items = items.filter(i => i.text.toLowerCase().includes(search));

      return withFreshness(args.tabId, 'text-coords', {
        capturedAt:   raw.capturedAt,
        pageUrl:      raw.pageUrl,
        viewport:     raw.viewport,
        totalItems:   items.length,
        level,
        [level]:      items,
        fullText:     search ? undefined : raw.fullText,
      }, cache);
    },
  });

  // 4. get_viewport
  tools.push({
    definition: {
      name: 'get_viewport',
      description: 'Get the current viewport size and scroll position of the page. Returns window dimensions (width/height), scroll offset (scrollX/scrollY), and total page scroll dimensions. Use this to understand what portion of the page the user is currently seeing.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID from get_sessions' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const vp = cache.readSessionFile(args.tabId, 'raw/visual/viewport.json');
      if (!vp) {
        const raw = cache.readSessionFile(args.tabId, 'raw/visual/text-coords.json');
        if (raw?.viewport) return withFreshness(args.tabId, 'text-coords', { viewport: raw.viewport, note: 'Viewport from last text-coords snapshot. Scroll position may be stale.' }, cache);
        return { error: 'Viewport data not available. Ensure the tab has the extension loaded and trigger refresh_data.' };
      }
      return withFreshness(args.tabId, 'text-coords', { ...vp, note: 'Real-time viewport position from page scroll events.' }, cache);
    },
  });

  // 5. get_framework_state
  tools.push({
    definition: {
      name: 'get_framework_state',
      description: 'Get the component tree and state for the detected frontend framework (React, Vue, Angular, Svelte, Alpine, Preact, Solid, or generic DOM). Includes component props, hooks, context, router location, and Redux/Pinia/Vuex store if detected.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:     { type: 'number', description: 'Tab ID from get_sessions' },
          framework: { type: 'string', enum: ['auto', 'react', 'vue3', 'vue2', 'angular', 'svelte', 'alpine', 'preact', 'solid', 'dom'], description: 'Which framework (auto = first detected)' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const index = cache.getSessionData(args.tabId);
      if (!index) return { error: `No session for tabId ${args.tabId}` };

      const fw = args.framework || 'auto';
      const files = (index.files && index.files.raw) || {};

      const fwFileMap = {
        react:   files.react_snapshot,
        vue3:    files.vue_snapshot,
        vue2:    files.vue2_snapshot,
        angular: files.angular_snapshot,
        svelte:  files.svelte_snapshot,
        alpine:  files.alpine_snapshot,
        preact:  files.preact_snapshot,
        solid:   files.solid_snapshot,
        dom:     files.dom_generic,
      };

      const fwPluginMap = {
        react: 'react-fiber', vue3: 'vue3', vue2: 'vue2',
        angular: 'angular', svelte: 'svelte', alpine: 'alpine',
        preact: 'preact', solid: 'solid', dom: 'dom-generic',
      };

      let targetFw = null;
      let targetFile = null;
      if (fw === 'auto') {
        const priority = ['react','vue3','vue2','angular','svelte','alpine','preact','solid','dom'];
        for (const key of priority) {
          if (fwFileMap[key]) { targetFw = key; targetFile = fwFileMap[key]; break; }
        }
      } else {
        targetFw = fw;
        targetFile = fwFileMap[fw];
      }

      if (!targetFile) return { error: `Framework '${fw}' not detected. Available: ${Object.keys(fwFileMap).filter(k => fwFileMap[k]).join(', ') || 'none'}` };
      const data = cache.readSessionFile(args.tabId, targetFile);
      if (!data) return { error: `File ${targetFile} not readable.` };
      return withFreshness(args.tabId, fwPluginMap[targetFw] || targetFw, data, cache);
    },
  });

  // 6. get_network
  tools.push({
    definition: {
      name: 'get_network',
      description: 'Get captured HTTP requests and responses. Each entry includes method, URL, status, duration, request/response headers, and decoded body (up to configured limit). Useful for understanding what API calls the page makes.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:       { type: 'number', description: 'Tab ID from get_sessions' },
          filterUrl:   { type: 'string', description: 'Only return requests whose URL contains this string' },
          filterType:  { type: 'string', description: 'Filter by initiator type (fetch, xhr, script, img, …)' },
          filterStatus: { type: 'number', description: 'Filter by HTTP status code (e.g. 200, 404, 500)' },
          limit:       { type: 'number', description: 'Max number of requests to return (default: 100)' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = cache.readSessionFile(args.tabId, 'raw/network/requests.json');
      if (!raw) return { requests: [], totalRequests: 0, note: 'No network data yet. Trigger refresh_data.' };

      let reqs = raw.requests || [];
      if (args.filterUrl)    reqs = reqs.filter(r => r.url?.includes(args.filterUrl));
      if (args.filterType)   reqs = reqs.filter(r => r.initiatorType === args.filterType || r.type === args.filterType);
      if (args.filterStatus) reqs = reqs.filter(r => r.status === args.filterStatus);
      const limit = args.limit || 100;
      const total = reqs.length;
      reqs = reqs.slice(-limit);

      return withFreshness(args.tabId, 'network-hook', {
        capturedAt:    raw.capturedAt,
        totalRequests: total,
        returned:      reqs.length,
        requests:      reqs,
      }, cache);
    },
  });

  // 7. get_ui_catalog
  tools.push({
    definition: {
      name: 'get_ui_catalog',
      description: 'Get all interactive UI elements: buttons, links, form inputs, images. Each includes text/label, coordinates (x,y,w,h), and state (disabled, required). Use this to find what you can click or type into.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:  { type: 'number', description: 'Tab ID from get_sessions' },
          search: { type: 'string', description: 'Filter elements by text/label (case-insensitive)' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = cache.readSessionFile(args.tabId, 'raw/ui/elements.json');
      if (!raw) return { error: 'UI catalog not available. Trigger refresh_data.' };

      if (args.search) {
        const s = args.search.toLowerCase();
        const filter = arr => (arr || []).filter(el =>
          (el.text || el.label || el.placeholder || el.name || '').toLowerCase().includes(s)
        );
        return withFreshness(args.tabId, 'ui-catalog', {
          ...raw,
          buttons: filter(raw.buttons),
          links:   filter(raw.links),
          inputs:  filter(raw.inputs),
        }, cache);
      }
      return withFreshness(args.tabId, 'ui-catalog', raw, cache);
    },
  });

  // 8. get_accessibility
  tools.push({
    definition: {
      name: 'get_accessibility',
      description: 'Get the full ARIA accessibility tree. Each node includes computed role, name, description, state (expanded, selected, checked, disabled), and landmark region. Excellent for finding elements without visual selectors.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:     { type: 'number', description: 'Tab ID from get_sessions' },
          role:      { type: 'string', description: 'Filter by ARIA role (e.g. button, link, textbox, dialog, navigation)' },
          maxDepth:  { type: 'number', description: 'Max tree depth to return (default: 10)' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = cache.readSessionFile(args.tabId, 'raw/accessibility/tree.json');
      if (!raw) return { error: 'Accessibility tree not available. Trigger refresh_data with plugins: ["accessibility"].' };

      let tree = raw;
      if (args.role) {
        const filterRole = (node) => {
          if (!node) return null;
          const match = (node.role || '').toLowerCase() === args.role.toLowerCase();
          const filteredChildren = (node.children || []).map(filterRole).filter(Boolean);
          if (match || filteredChildren.length) {
            return { ...node, children: filteredChildren };
          }
          return null;
        };
        tree = { ...raw, tree: filterRole(raw.tree) };
      }

      const maxDepth = args.maxDepth || 10;
      const truncate = (node, depth) => {
        if (!node || depth > maxDepth) return null;
        return {
          ...node,
          children: (node.children || []).map(c => truncate(c, depth + 1)).filter(Boolean),
        };
      };

      return withFreshness(args.tabId, 'accessibility', {
        ...tree,
        tree: truncate(tree.tree, 0),
      }, cache);
    },
  });

  // 9. get_storage
  tools.push({
    definition: {
      name: 'get_storage',
      description: 'Get browser storage data: localStorage, sessionStorage, and cookies (name/value/domain). Useful for reading auth tokens, user preferences, session state, or any persisted data.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:  { type: 'number', description: 'Tab ID from get_sessions' },
          filter: { type: 'string', description: 'Only return keys containing this string' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = cache.readSessionFile(args.tabId, 'raw/storage/data.json');
      if (!raw) return { error: 'Storage data not available. Trigger refresh_data with plugins: ["storage-reader"].' };

      if (args.filter) {
        const f = args.filter.toLowerCase();
        const filterObj = obj => Object.fromEntries(
          Object.entries(obj || {}).filter(([k]) => k.toLowerCase().includes(f))
        );
        return withFreshness(args.tabId, 'storage-reader', {
          ...raw,
          localStorage:   filterObj(raw.localStorage),
          sessionStorage: filterObj(raw.sessionStorage),
          cookies:        (raw.cookies || []).filter(c => c.name?.toLowerCase().includes(f)),
        }, cache);
      }
      return withFreshness(args.tabId, 'storage-reader', raw, cache);
    },
  });

  // 10. get_console_logs
  tools.push({
    definition: {
      name: 'get_console_logs',
      description: 'Get captured console output (log, warn, error, info, debug). Each entry includes level, timestamp, and formatted message. Useful for debugging, finding errors, or understanding app behavior.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:  { type: 'number', description: 'Tab ID from get_sessions' },
          level:  { type: 'string', enum: ['log', 'warn', 'error', 'info', 'debug', 'all'], description: 'Filter by log level (default: all)' },
          search: { type: 'string', description: 'Filter by message content' },
          limit:  { type: 'number', description: 'Max entries to return (default: 200)' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = cache.readSessionFile(args.tabId, 'raw/console/logs.json');
      if (!raw) {
        const logs = cache.getConsoleLogs(args.tabId);
        if (!logs.length) return { error: 'No console logs captured yet. Enable console-logger plugin and trigger refresh_data.' };
        return { totalEntries: logs.length, entries: logs };
      }

      let entries = raw.entries || [];
      if (args.level && args.level !== 'all') {
        entries = entries.filter(e => e.level === args.level);
      }
      if (args.search) {
        const s = args.search.toLowerCase();
        entries = entries.filter(e => (e.message || '').toLowerCase().includes(s));
      }
      const limit = args.limit || 200;
      entries = entries.slice(-limit);

      return withFreshness(args.tabId, 'console-logger', {
        capturedAt:   raw.capturedAt,
        totalEntries: raw.totalEntries || entries.length,
        returned:     entries.length,
        entries,
      }, cache);
    },
  });

  // 11. get_perf_metrics
  tools.push({
    definition: {
      name: 'get_perf_metrics',
      description: 'Get Web Vitals and performance metrics: LCP, FCP, CLS, FID/INP, TTFB, resource timing, long tasks. Useful for diagnosing performance issues.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID from get_sessions' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = cache.readSessionFile(args.tabId, 'raw/perf/metrics.json');
      if (!raw) return { error: 'Performance metrics not available. Trigger refresh_data.' };
      return withFreshness(args.tabId, 'perf-analyzer', raw, cache);
    },
  });

  // 12. get_css_analysis
  tools.push({
    definition: {
      name: 'get_css_analysis',
      description: 'Get CSS custom properties (variables), stylesheet statistics, and computed styles for key elements. Useful for understanding theming, design tokens, or style issues.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID from get_sessions' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = cache.readSessionFile(args.tabId, 'raw/css/analysis.json');
      if (!raw) return { error: 'CSS analysis not available.' };
      return withFreshness(args.tabId, 'css-analyzer', raw, cache);
    },
  });

  // 13. get_dom_snapshot
  tools.push({
    definition: {
      name: 'get_dom_snapshot',
      description: 'Get the generic DOM tree including ARIA attributes, global state variables (window.*), and custom elements. Falls back gracefully when framework adapters are not available.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID from get_sessions' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = cache.readSessionFile(args.tabId, 'raw/dom/snapshot.json');
      if (!raw) return { error: 'DOM snapshot not available.' };
      return withFreshness(args.tabId, 'dom-generic', raw, cache);
    },
  });

  // 14. get_state_map
  tools.push({
    definition: {
      name: 'get_state_map',
      description: 'Get the application state-transition graph built by the autonomous explorer. Shows discovered UI states as nodes (with URL, title, button/link counts) and transitions as edges (with action type and trigger label). Use this to understand app navigation structure.',
      inputSchema: {
        type: 'object',
        properties: {
          siteVersion: { type: 'string', description: 'Site version hash (omit to list all graphs)' },
        },
      },
    },
    handler: async (args, cb) => {
      if (!args.siteVersion) {
        const { getAllGraphs } = require('../state-machine');
        return { graphs: getAllGraphs() };
      }
      const { getGraph } = require('../state-machine');
      const g = getGraph(args.siteVersion);
      if (!g) {
        const graphFile = path.join(__dirname, '..', '..', 'cache', 'graphs', `${args.siteVersion}.json`);
        if (fs.existsSync(graphFile)) {
          return JSON.parse(fs.readFileSync(graphFile, 'utf8'));
        }
        return { error: `No graph for siteVersion "${args.siteVersion}".` };
      }
      const nodeCount = Object.keys(g.nodes).length;
      const edgeCount = Object.values(g.edges).reduce((s, v) => s + Object.keys(v).length, 0);
      return { ...g, nodeCount, edgeCount };
    },
  });

  // 15. list_states
  tools.push({
    definition: {
      name: 'list_states',
      description: 'List all recorded UI states with semantic labels, tags, and visit counts. Use this to discover what states have been observed. Filter by URL pattern, tags, or sort by visitCount/lastSeen. Pinned states appear first.',
      inputSchema: {
        type: 'object',
        properties: {
          siteVersion: { type: 'string', description: 'Filter by site version (omit for all)' },
          filter:      { type: 'string', description: 'URL pattern filter (e.g. "/cart")' },
          tags:        { type: 'array', items: { type: 'string' }, description: 'Required tags (e.g. ["authenticated", "cart-open"])' },
          sortBy:      { type: 'string', enum: ['visitCount', 'lastSeen', 'firstSeen'], description: 'Sort order (default: lastSeen)' },
          limit:       { type: 'number', description: 'Max results (default: 50, max: 500)' },
        },
      },
    },
    handler: async (args, cb) => {
      const stateStore = require('../state-store');
      const states = stateStore.getAllNodesFlat({
        siteVersion: args.siteVersion,
        filter: args.filter,
        tags: args.tags,
        sortBy: args.sortBy || 'lastSeen',
        limit: Math.min(args.limit || 50, 500),
      });
      return { totalStates: states.length, states };
    },
  });

  // 16. search_states
  tools.push({
    definition: {
      name: 'search_states',
      description: 'Fuzzy-search recorded UI states by label, tags, URL, or keyState values. Use natural language queries like "cart", "checkout", "logged in". Returns results ranked by relevance score.',
      inputSchema: {
        type: 'object',
        properties: {
          query:       { type: 'string', description: 'Search query (e.g. "cart", "checkout", "login")' },
          siteVersion: { type: 'string', description: 'Filter by site version (omit for all)' },
          searchIn:    { type: 'string', enum: ['label', 'tags', 'keyState', 'url', 'all'], description: 'Where to search (default: all)' },
          limit:       { type: 'number', description: 'Max results (default: 10)' },
        },
        required: ['query'],
      },
    },
    handler: async (args, cb) => {
      const stateStore = require('../state-store');
      if (!args.query) return { error: 'query is required' };

      const graphs = args.siteVersion
        ? [stateStore.getGraph(args.siteVersion)].filter(Boolean)
        : stateStore.getAllGraphs().map(g => stateStore.getGraph(g.siteVersion)).filter(Boolean);

      const allResults = [];
      for (const g of graphs) {
        const semantic = require('../state-semantic');
        const results = semantic.searchStates(g, args.query, {
          searchIn: args.searchIn || 'all',
          limit: args.limit || 10,
        });
        for (const r of results) {
          r.siteVersion = g.siteVersion;
        }
        allResults.push(...results);
      }
      allResults.sort((a, b) => b.score - a.score);
      return { query: args.query, totalResults: allResults.length, results: allResults.slice(0, args.limit || 10) };
    },
  });

  // 17. get_state_detail
  tools.push({
    definition: {
      name: 'get_state_detail',
      description: 'Get full metadata for a specific state including label, tags, keyState, UI summary, and reachable states. Optionally include the full snapshot (React state + DOM tree).',
      inputSchema: {
        type: 'object',
        properties: {
          hash:            { type: 'string', description: 'State hash (compositeHash, 7-8 chars)' },
          siteVersion:     { type: 'string', description: 'Site version (omit to auto-search)' },
          includeSnapshot: { type: 'boolean', description: 'Include full React/DOM snapshot (default: false)' },
          includeEdges:    { type: 'boolean', description: 'Include reachableFrom/canReachTo edges (default: true)' },
        },
        required: ['hash'],
      },
    },
    handler: async (args, cb) => {
      if (!args.hash) return { error: 'hash is required' };
      const stateStore = require('../state-store');

      let g = args.siteVersion
        ? stateStore.getGraph(args.siteVersion)
        : stateStore.findGraphContaining(args.hash);

      if (!g) return { error: `State "${args.hash}" not found in any graph.` };

      let node = stateStore.getNodeByHash(g.siteVersion, args.hash);
      if (!node) return { error: `State "${args.hash}" not found.` };

      const result = { ...node };

      if (args.includeSnapshot && node.snapshotRef) {
        const snapshot = stateStore.loadSnapshot(g.siteVersion, args.hash);
        result.snapshot = snapshot;
      }

      if (args.includeEdges !== false) {
        const inEdges = g.edgeIndex[args.hash] || [];
        const outEdges = g.edges[args.hash] || {};

        result.reachableFrom = [];
        for (const edgeKey of inEdges) {
          for (const [fromHash, edges] of Object.entries(g.edges)) {
            if (edges[edgeKey]) {
              const fromNode = g.nodes[fromHash];
              if (fromNode) {
                result.reachableFrom.push({
                  fromHash,
                  fromLabel: fromNode.label,
                  action: edges[edgeKey].action,
                  trigger: edges[edgeKey].trigger,
                  confidence: edges[edgeKey].confidence,
                });
              }
              break;
            }
          }
        }

        result.canReachTo = [];
        for (const [edgeKey, edge] of Object.entries(outEdges)) {
          if (edge.to && g.nodes[edge.to]) {
            result.canReachTo.push({
              toHash: edge.to,
              toLabel: g.nodes[edge.to].label,
              action: edge.action,
              trigger: edge.trigger,
              confidence: edge.confidence,
            });
          }
        }
      }

      return result;
    },
  });

  // 18. pin_state
  tools.push({
    definition: {
      name: 'pin_state',
      description: 'Pin a state with a custom label and/or tags. Pinned states are always kept in memory (not evicted) and appear first in list_states results. Use this to bookmark important states for later navigation.',
      inputSchema: {
        type: 'object',
        properties: {
          hash:        { type: 'string', description: 'State hash to pin' },
          siteVersion: { type: 'string', description: 'Site version (omit to auto-search)' },
          label:       { type: 'string', description: 'Custom label for this state' },
          tags:        { type: 'array', items: { type: 'string' }, description: 'Additional tags to add' },
        },
        required: ['hash'],
      },
    },
    handler: async (args, cb) => {
      if (!args.hash) return { error: 'hash is required' };
      const stateStore = require('../state-store');

      let g = args.siteVersion
        ? stateStore.getGraph(args.siteVersion)
        : stateStore.findGraphContaining(args.hash);

      if (!g) return { error: `State "${args.hash}" not found.` };

      const result = stateStore.pinNode(g.siteVersion, args.hash, args.label, args.tags);
      return result;
    },
  });

  registry.registerTools(tools);
};
