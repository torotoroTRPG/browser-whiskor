/**
 * server/mcp/tools/read-basic.js
 * Basic READ tools: sessions, index, text coords, viewport, framework state.
 */
'use strict';

const { fuzzyScore, withFreshness, classifyIntent } = require('./read-helpers');
const { resolveBackend, setBackend } = require('./backend-selector');

module.exports = function registerBasicTools(registry) {
  const tools = [];

  // 1. get_sessions
  tools.push({
    definition: {
      name: 'get_sessions',
      description: 'List all active inspection sessions (one per browser tab). By default returns a lightweight entry per tab (tabId, URL, title, data age, staleness flag, summary), relevance-sorted (pinned, then fresh, then most recently updated). Use q to search tabs by title/URL (mode: exact/fuzzy/semantic), tabId to fetch one tab, sort to reorder, and page/pageSize to page through many tabs. With any of q/tabId/page/pageSize the result is wrapped as { sessions, total, page, totalPages, hasMore, ... }; otherwise it is a bare array. Set verbose:true for the per-plugin freshnessMap; for one tab\'s full detail use get_index instead. Call this first to discover available tabIds.',
      inputSchema: {
        type: 'object',
        properties: {
          q:        { type: 'string', description: 'Search tabs by title + URL. Combine with mode for fuzzy/semantic matching.' },
          mode:     { type: 'string', enum: ['exact', 'fuzzy', 'semantic'], description: 'How q matches: exact (substring, default), fuzzy (typo-tolerant), or semantic (MiniLM meaning; falls back to fuzzy when no model).' },
          tabId:    { type: 'number', description: 'Return only this tab (direct ID lookup).' },
          sort:     { type: 'string', enum: ['relevant', 'recent', 'created', 'title', 'url'], description: 'Order: relevant (default: pinned > fresh > recently updated), recent (updatedAt), created (createdAt), title, url. Ignored when q is a fuzzy/semantic search (those sort by score).' },
          minScore: { type: 'number', description: 'Minimum score for fuzzy/semantic q (0.0-1.0, default 0.3).' },
          page:     { type: 'number', description: 'Page number (1-based) when paging. Use "all" to return every match in one page.' },
          pageSize: { type: 'number', description: 'Items per page (default 20). Paging is opt-in: with no page/pageSize the full list is returned.' },
          verbose:  { type: 'boolean', description: 'Include the per-plugin freshnessMap for every session (default false). Usually unnecessary — prefer get_index for a single tab\'s detail.' },
        },
        required: [],
      },
    },
    handler: async (args, cb) => {
      const list = await cb.cache.getSessionList({ brief: !args?.verbose });

      // Tabs that exist in the browser but have no session (restricted pages or
      // tabs needing a reload) are otherwise invisible here — surface them so the
      // agent knows there's more than what's listed.
      let uninstrumented = [];
      if (cb._uninstrumentedTabs) {
        try { uninstrumented = (await cb._uninstrumentedTabs()) || []; } catch (_) { uninstrumented = []; }
      }
      const uninstWarning = uninstrumented.length ? {
        code: 'UNINSTRUMENTED_TABS',
        message: `${uninstrumented.length} open browser tab(s) have no whiskor session and aren't listed here. ` +
          `reason 'reload_needed' = reload that tab to instrument it; 'restricted' = a browser page (chrome://, web store, etc.) that can't be instrumented. See uninstrumentedTabs.`,
      } : null;

      if (!list || list.length === 0) {
        return {
          sessions: [],
          _warnings: [
            {
              code: "NO_ACTIVE_SESSIONS",
              message: "No active browser sessions found. This usually means the browser extension is not connected to the Whiskor server (ws://127.0.0.1:7891). Please open your browser, ensure the Whiskor extension is enabled, and refresh/visit a page."
            },
            ...(uninstWarning ? [uninstWarning] : []),
          ],
          ...(uninstrumented.length ? { uninstrumentedTabs: uninstrumented } : {}),
          _note: "Whiskor WebSocket server is listening on port 7891. You can verify extension connections via the dashboard at http://127.0.0.1:7892/."
        };
      }
      const { selectSessions } = require('../../session-list');
      // Only pay for backend resolution when semantic search is actually requested.
      let backend = null;
      if (args.mode === 'semantic' && args.q) {
        try { backend = await resolveBackend(cb._config); setBackend(backend); } catch (_) {}
      }
      const result = await selectSessions(list, { ...args, backend });

      if (!uninstWarning) return result;
      // Attach the warning. selectSessions returns a bare array for a plain call;
      // wrap it into an object so the warning has somewhere to live (mirrors the
      // empty-list shape). Enhanced calls already return an object.
      if (Array.isArray(result)) {
        return { sessions: result, _warnings: [uninstWarning], uninstrumentedTabs: uninstrumented };
      }
      result._warnings = [...(result._warnings || []), uninstWarning];
      result.uninstrumentedTabs = uninstrumented;
      return result;
    },
  });

  // 1b. search_all_tabs — cross-session text search (shares server/session-search.js
  // with the HTTP GET /api/search route, so both behave identically).
  tools.push({
    definition: {
      name: 'search_all_tabs',
      description: 'Search the collected text of EVERY active tab at once and return only the tabs that contain the query — instead of calling get_text_coords on each tab and grepping by hand. mode: exact (case-insensitive substring, default) / fuzzy (typo-tolerant) / semantic (MiniLM meaning; transparently falls back to fuzzy when the model is unavailable). Results are sorted most-relevant tab first, each with its top matches (text + absolute coordinates).',
      inputSchema: {
        type: 'object',
        properties: {
          q:         { type: 'string', description: 'The text to search for across all tabs.' },
          mode:      { type: 'string', enum: ['exact', 'fuzzy', 'semantic'], description: 'exact (substring, default), fuzzy (similarity), or semantic (MiniLM; fuzzy fallback when no model).' },
          level:     { type: 'string', enum: ['words', 'lines', 'blocks'], description: 'Text granularity to scan (default words).' },
          minScore:  { type: 'number', description: 'Minimum score for fuzzy/semantic matches (default 0.3).' },
          maxPerTab: { type: 'number', description: 'Max matches returned per tab (default 20).' },
        },
        required: ['q'],
      },
    },
    handler: async (args, cb) => {
      const { searchSessions } = require('../../session-search');
      // Only pay for backend resolution when semantic is actually requested; exact/
      // fuzzy need no model. Same backend path as get_text_coords' match: search.
      let backend = null;
      if (args.mode === 'semantic') {
        try { backend = await resolveBackend(cb._config); setBackend(backend); } catch (_) {}
      }
      return searchSessions(cb.cache, { ...args, backend });
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
      const data = await cb.cache.getSessionData(args.tabId);
      if (!data) return { error: `No session for tabId ${args.tabId}. Call get_sessions first.` };
      return data;
    },
  });

  // 3. get_text_coords
   tools.push({
     definition: {
       name: 'get_text_coords',
       description: 'Get all visible text on the page with absolute pixel coordinates. Use "search" for exact substring match, or "match" for fuzzy similarity search (returns results sorted by score 0.0-1.0). Each item includes a contextHint describing the element role (e.g. "navigation link", "form label", "button"). Set "inViewport: true" to return only text currently within the user\'s visible viewport area. Use "focusScope" to limit search to a specific subtree (e.g. a modal dialog). Note: textarea/input values are NOT included by default (only rendered text); set "includeFormValues: true" to also get them (redacted server-side).',
       inputSchema: {
         type: 'object',
         properties: {
           tabId:      { type: 'number', description: 'Tab ID from get_sessions' },
           search:     { type: 'string', description: 'Exact substring filter (case-insensitive). If unsure of the exact wording, use "match" instead for fuzzy/semantic (MiniLM) search.' },
           match:      { type: 'string', description: 'Fuzzy similarity search — returns results sorted by match score (0.0-1.0). Use when you don\'t know the exact text.' },
           level:      { type: 'string', enum: ['words', 'lines', 'blocks', 'all'], description: 'Granularity (default: words)' },
           maxResults: { type: 'number', description: 'Max items to return. Use with "match" to get top-N results (default: 50)' },
           minScore:   { type: 'number', description: 'Minimum similarity score for "match" mode (0.0-1.0, default: 0.1)' },
           inViewport: { type: 'boolean', description: 'If true, only return text whose bounding box intersects the current viewport (based on scroll position).' },
           focusScope: { type: 'string', description: 'CSS selector identifying the subtree to search within (e.g. \'[role="dialog"]\'). Elements outside this scope are summarized separately in outOfScopeMatches.' },
           includeSuggestions: { type: 'boolean', description: 'Include fuzzy/semantic _suggestions when search/match finds nothing (default: true; set false to disable).' },
           includeFormValues: { type: 'boolean', description: 'Also return form field values (textarea/input value, contentEditable text) under formValues, with coordinates. Opt-in: requires config.options.textCoords.includeFormValues=true on the server for collection. Sensitive fields (password/payment/hidden) carry no value (valueOmitted:true); any value is redacted server-side by secret-guard. Default false.' },
         },
         required: ['tabId'],
       },
     },
     handler: async (args, cb) => {
        const cache = cb.cache;
        const raw = await cache.readSessionFile(args.tabId, 'raw/visual/text-coords.json');
        if (!raw) return { error: 'TEXT_COORDS not available. Trigger refresh_data first.' };

        // Form values are opt-in and live under raw.formValues (already redacted
        // server-side by secret-guard). Pull them out so they never leak through the
        // `{...raw}` path, and re-attach only when the caller explicitly asks.
        const _TC = 'text-coords';
        const formValues = args.includeFormValues === true ? (raw.formValues || []) : null;
        delete raw.formValues;
        const finalize = (result) => {
          if (formValues) result.formValues = formValues;
          return withFreshness(args.tabId, _TC, result, cache);
        };

        const level      = args.level || 'words';
        const search     = args.search?.toLowerCase();
        const matchQuery = args.match;
        const maxResults = args.maxResults || 50;
        const minScore   = args.minScore != null ? args.minScore : 0.1;
        const inViewport = args.inViewport === true;
        const focusScope = args.focusScope;
        const includeSuggestions = args.includeSuggestions !== false;

        // Get session for minScoreOverride and system messages
        const session = cb._toolManager?.getSessionState?.(args._sessionId);
        const effectiveMinScore = session?.minScoreOverride ?? minScore;
        
        const embedService = require('../../services/embed-service');
        const embedNotice = embedService.consumeReadyNotice(args._sessionId);
        
        let systemMessage = undefined;
        if (session?._pendingMinScoreResetNotice) {
          systemMessage = {
              source: 'WHISKOR_SYSTEM',
              type: 'MINSCORE_OVERRIDE_REVERTED',
              message: `minScore override reverted: ${session._pendingMinScoreResetNotice.from} → ${session._pendingMinScoreResetNotice.to}`,
              ...session._pendingMinScoreResetNotice,
          };
          session._pendingMinScoreResetNotice = null;
        } else if (embedNotice) {
          systemMessage = embedNotice;
        }

        // Get backend for semantic search
        const backend = await resolveBackend(cb._config);
        setBackend(backend);

        let vp = null;
        if (inViewport) {
          const liveVp = await cache.readSessionFile(args.tabId, 'raw/visual/viewport.json');
          vp = liveVp || raw.viewport || null;
        }

        // focusScope filtering: filter by selector path prefix/contains match
        function filterByFocusScope(items) {
          if (!focusScope || !items) return { inScope: items, outOfScope: [] };
          const inScope = [];
          const outOfScope = [];
          for (const item of items) {
            const loc = (item.location || item.selector || '').toLowerCase();
            if (loc.includes(focusScope.toLowerCase())) {
              inScope.push(item);
            } else {
              outOfScope.push(item);
            }
          }
          return { inScope, outOfScope };
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

        // Generate suggestions for no-match cases
        async function generateSuggestions(query, allItems, threshold = 0.35) {
          if (!query || !allItems) return [];
          const suggestions = [];
          const texts = allItems.map(i => i.text).filter(Boolean);

          // Use MiniLM batch scoring if available
          if (backend.batchFuzzyScore) {
            const scores = await backend.batchFuzzyScore(query, texts);
            for (let i = 0; i < allItems.length; i++) {
              if (allItems[i].text && scores[i] >= threshold) {
                const intent = await backend.classifyIntent(allItems[i].text, threshold);
                suggestions.push({
                  text: allItems[i].text,
                  score: scores[i],
                  elementType: allItems[i].elementType || 'text',
                  ...(intent ? { intent: intent.intent } : {}),
                });
              }
            }
          } else {
            // Fallback to dictionary-based scoring
            for (const item of allItems) {
              if (item.text) {
                const score = fuzzyScore(query, item.text);
                if (score >= threshold) {
                  const intent = classifyIntent(item.text, threshold);
                  suggestions.push({
                    text: item.text,
                    score,
                    elementType: item.elementType || 'text',
                    ...(intent ? { intent: intent.intent } : {}),
                  });
                }
              }
            }
          }
          return suggestions
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
        }

        if (matchQuery) {
          if (level === 'all') {
            let wArr = raw.words || [], lArr = raw.lines || [], bArr = raw.blocks || [];
            if (inViewport) { wArr = filterByViewport(wArr); lArr = filterByViewport(lArr); bArr = filterByViewport(bArr); }

            if (focusScope) {
              const wSplit = filterByFocusScope(wArr);
              const lSplit = filterByFocusScope(lArr);
              const bSplit = filterByFocusScope(bArr);
              wArr = wSplit.inScope; lArr = lSplit.inScope; bArr = bSplit.inScope;
            }

            // Use MiniLM batch scoring if available
            let w, l, b;
            if (backend.batchFuzzyScore) {
              const allItems = [...wArr, ...lArr, ...bArr];
              const texts = allItems.map(i => i.text);
              const scores = await backend.batchFuzzyScore(matchQuery, texts);
              w = wArr.map((i, idx) => ({ ...i, _score: scores[idx] }))
                .filter(i => i._score >= effectiveMinScore)
                .sort((a, b) => b._score - a._score)
                .slice(0, maxResults);
              l = lArr.map((i, idx) => ({ ...i, _score: scores[wArr.length + idx] }))
                .filter(i => i._score >= effectiveMinScore)
                .sort((a, b) => b._score - a._score)
                .slice(0, maxResults);
              b = bArr.map((i, idx) => ({ ...i, _score: scores[wArr.length + lArr.length + idx] }))
                .filter(i => i._score >= effectiveMinScore)
                .sort((a, b) => b._score - a._score)
                .slice(0, maxResults);
            } else {
              const scored = (arr) => arr
                .map(i => ({ ...i, _score: fuzzyScore(matchQuery, i.text) }))
                .filter(i => i._score >= effectiveMinScore)
                .sort((a, b) => b._score - a._score)
                .slice(0, maxResults);
              w = scored(wArr);
              l = scored(lArr);
              b = scored(bArr);
            }

            const result = {
              capturedAt: raw.capturedAt,
              pageUrl:    raw.pageUrl,
              viewport:   raw.viewport,
              query:      matchQuery,
              minScore:   effectiveMinScore,
              ...(backend.isMiniLM ? { matchBackend: 'minilm' } : {}),
              words:      w,
              lines:      l,
              blocks:     b,
              ...(focusScope ? { scopeApplied: true, scopeSelector: focusScope } : {}),
            };
            if (!w.length && !l.length && !b.length) {
              result._warnings = [{ code: 'NO_MATCH', message: `No text matches "${matchQuery}" with score >= ${effectiveMinScore}. Try a different query or lower minScore.` }];
              if (includeSuggestions) {
                const allItems = [...(raw.words || []), ...(raw.lines || []), ...(raw.blocks || [])];
                result._suggestions = await generateSuggestions(matchQuery, allItems);
              }
            }
            if (systemMessage) result._systemMessage = systemMessage;
            return finalize(result);
          }

          let items = (raw[level] || raw.words || []);
          if (inViewport) items = filterByViewport(items);

          if (focusScope) {
            const split = filterByFocusScope(items);
            items = split.inScope;
          }

          // Use MiniLM batch scoring if available
          let scored;
          if (backend.batchFuzzyScore) {
            const texts = items.map(i => i.text);
            const scores = await backend.batchFuzzyScore(matchQuery, texts);
            scored = items.map((i, idx) => ({ ...i, _score: scores[idx] }))
              .filter(i => i._score >= effectiveMinScore)
              .sort((a, b) => b._score - a._score)
              .slice(0, maxResults);
          } else {
            scored = items
              .map(i => ({ ...i, _score: fuzzyScore(matchQuery, i.text) }))
              .filter(i => i._score >= effectiveMinScore)
              .sort((a, b) => b._score - a._score)
              .slice(0, maxResults);
          }

          const result = {
            capturedAt:   raw.capturedAt,
            pageUrl:      raw.pageUrl,
            viewport:     raw.viewport,
            query:        matchQuery,
            minScore:     effectiveMinScore,
            ...(backend.isMiniLM ? { matchBackend: 'minilm' } : {}),
            totalMatches: items.length,
            level,
            [level]:      scored,
            ...(focusScope ? { scopeApplied: true, scopeSelector: focusScope } : {}),
          };
          if (!scored.length) {
            result._warnings = [{ code: 'NO_MATCH', message: `No ${level} match "${matchQuery}" with score >= ${effectiveMinScore}.` }];
            if (includeSuggestions) {
              result._suggestions = await generateSuggestions(matchQuery, raw[level] || raw.words || []);
            }
          }
          if (systemMessage) result._systemMessage = systemMessage;
          return finalize(result);
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
          if (systemMessage) result._systemMessage = systemMessage;
          return finalize(result);
        }

        let items = raw[level] || raw.words || [];
        if (inViewport) items = filterByViewport(items);
        if (search) items = items.filter(i => i.text.toLowerCase().includes(search));

        const result = {
          capturedAt:   raw.capturedAt,
          pageUrl:      raw.pageUrl,
          viewport:     raw.viewport,
          totalItems:   items.length,
          level,
          [level]:      items,
          fullText:     search ? undefined : raw.fullText,
        };
        // Exact substring search found nothing → offer fuzzy/semantic suggestions by
        // default (opt out with includeSuggestions:false) so a near-miss isn't a dead end.
        if (search && items.length === 0 && includeSuggestions) {
          result._warnings = [{ code: 'NO_MATCH', message: `No text contains "${args.search}". Showing fuzzy suggestions — use match: for full semantic search.` }];
          result._suggestions = await generateSuggestions(args.search, raw[level] || raw.words || []);
        }
        if (systemMessage) result._systemMessage = systemMessage;
        return withFreshness(args.tabId, 'text-coords', result, cache);
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
      const vp = await cache.readSessionFile(args.tabId, 'raw/visual/viewport.json');
      if (!vp) {
        const raw = await cache.readSessionFile(args.tabId, 'raw/visual/text-coords.json');
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
      const index = await cache.getSessionData(args.tabId);
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
      const data = await cache.readSessionFile(args.tabId, targetFile);
      if (!data) return { error: `File ${targetFile} not readable.` };
      return withFreshness(args.tabId, fwPluginMap[targetFw] || targetFw, data, cache);
    },
  });

  registry.registerTools(tools);
};
