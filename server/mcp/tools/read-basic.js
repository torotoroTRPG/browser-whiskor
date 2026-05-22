/**
 * server/mcp/tools/read-basic.js
 * Basic READ tools: sessions, index, text coords, viewport, framework state.
 */
'use strict';

const { fuzzyScore, withFreshness } = require('./read-helpers');

module.exports = function registerBasicTools(registry) {
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

  registry.registerTools(tools);
};
