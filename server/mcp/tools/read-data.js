/**
 * server/mcp/tools/read-data.js
 * Data inspection READ tools: network, UI catalog, accessibility, storage, console, perf, CSS, DOM.
 */
'use strict';

const { withFreshness, filterByViewport, fuzzyScore, classifyIntent } = require('./read-helpers');
const { resolveBackend, setBackend } = require('./backend-selector');

module.exports = function registerDataTools(registry) {
  const tools = [];

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
      const raw = await cache.readSessionFile(args.tabId, 'raw/network/requests.json');
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
        description: 'Get all interactive UI elements: buttons, links, form inputs, images. Each includes text/label (accessible name from aria-label/title/tooltip), coordinates (x,y,w,h), and state (disabled, required). Form inputs also include enterKey — an inferred submit gesture {key, confidence} (key=null when it could not be inferred) — and now cover contenteditable / rich-text editors (chat boxes), not just native fields. Each interactive element carries a collection-time clickable hint (true/false/null) with obstructedBy when something covers it. Use this to find what you can click or type into. Use "focusScope" to limit search to a specific subtree (e.g. a modal dialog).',
        inputSchema: {
          type: 'object',
          properties: {
            tabId:     { type: 'number', description: 'Tab ID from get_sessions' },
            search:    { type: 'string', description: 'Exact substring filter over text/label/placeholder/name (case-insensitive). If unsure of the exact label, also set includeSuggestions:true for fuzzy/semantic suggestions, or use get_text_coords(match:) for fuzzy text search.' },
            type:      { type: 'string', description: 'Filter by element type (button, link, input, image)' },
            disabled:  { type: 'boolean', description: 'Filter for disabled elements only' },
            required:  { type: 'boolean', description: 'Filter for required form inputs only' },
            selector:  { type: 'string', description: 'Filter by CSS selector substring (e.g. ".btn-primary", "#submit")' },
            inViewport: { type: 'boolean', description: 'Only return elements currently in the viewport' },
            focusScope: { type: 'string', description: 'CSS selector identifying the subtree to search within (e.g. \'[role="dialog"]\'). Elements outside this scope are summarized separately in outOfScopeMatches.' },
            includeSuggestions: { type: 'boolean', description: 'Include fuzzy/semantic _suggestions when search finds nothing (default: true; set false to disable).' },
          },
          required: ['tabId'],
        },
      },
      handler: async (args, cb) => {
         const cache = cb.cache;
         const raw = await cache.readSessionFile(args.tabId, 'raw/ui/elements.json');
         if (!raw) return { error: 'UI catalog not available. Trigger refresh_data.' };

         // Get session for system messages
         const session = cb._toolManager?.getSessionState?.(args._sessionId);
         const systemMessage = session?._pendingMinScoreResetNotice
           ? {
               source: 'WHISKOR_SYSTEM',
               type: 'MINSCORE_OVERRIDE_REVERTED',
               message: `minScore override reverted: ${session._pendingMinScoreResetNotice.from} → ${session._pendingMinScoreResetNotice.to}`,
               ...session._pendingMinScoreResetNotice,
             }
           : undefined;
         if (session) session._pendingMinScoreResetNotice = null;

         // Get backend for semantic search
         const backend = await resolveBackend(cb._config);
         setBackend(backend);

         // Get viewport for inViewport filtering
         let vp = null;
         if (args.inViewport) {
           const liveVp = await cache.readSessionFile(args.tabId, 'raw/visual/viewport.json');
           vp = liveVp || raw.viewport || null;
         }

         // focusScope filtering: filter by selector path prefix/contains match
         function filterByFocusScope(elements) {
           if (!args.focusScope || !elements) return { inScope: elements, outOfScope: [] };
           const inScope = [];
           const outOfScope = [];
           for (const el of elements) {
             const loc = (el.selector || el.location || '').toLowerCase();
             if (loc.includes(args.focusScope.toLowerCase())) {
               inScope.push(el);
             } else {
               outOfScope.push(el);
             }
           }
           return { inScope, outOfScope };
         }

         // Generate suggestions for no-match cases
         async function generateSuggestions(query, allElements, threshold = 0.35) {
           if (!query || !allElements) return [];
           const suggestions = [];
           const texts = allElements.map(el => el.text || el.label || el.placeholder || el.name).filter(Boolean);

           // Use MiniLM batch scoring if available
           if (backend.batchFuzzyScore) {
             const scores = await backend.batchFuzzyScore(query, texts);
             for (let i = 0; i < allElements.length; i++) {
               const text = allElements[i].text || allElements[i].label || allElements[i].placeholder || allElements[i].name;
               if (text && scores[i] >= threshold) {
                 const intent = await backend.classifyIntent(text, threshold);
                 suggestions.push({
                   text,
                   score: scores[i],
                   elementType: allElements[i].elementType || allElements[i].type || 'element',
                   ...(intent ? { intent: intent.intent } : {}),
                 });
               }
             }
           } else {
             // Fallback to dictionary-based scoring
             for (const el of allElements) {
               const text = el.text || el.label || el.placeholder || el.name;
               if (text) {
                 const score = fuzzyScore(query, text);
                 if (score >= threshold) {
                   const intent = classifyIntent(text, threshold);
                   suggestions.push({
                     text,
                     score,
                     elementType: el.elementType || el.type || 'element',
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

         const filterElement = (el) => {
           // Text/label search
           if (args.search) {
             const s = args.search.toLowerCase();
             if (!(el.text || el.label || el.placeholder || el.name || '').toLowerCase().includes(s)) {
               return false;
             }
           }
           // CSS selector filter
           if (args.selector && el.selector) {
             if (!el.selector.toLowerCase().includes(args.selector.toLowerCase())) {
               return false;
             }
           }
           // Disabled state filter
           if (args.disabled === true && !el.disabled) {
             return false;
           }
           // Required state filter
           if (args.required === true && !el.required) {
             return false;
           }
          // Viewport filter
          if (vp && el.x !== undefined && el.y !== undefined) {
            if (!filterByViewport([el], vp).length) return false;
          }
          return true;
        };

         // Apply focusScope filtering
         let allButtons = raw.buttons || [];
         let allLinks = raw.links || [];
         let allInputs = raw.inputs || [];
         let allImages = raw.images || [];

         if (args.focusScope) {
           const bSplit = filterByFocusScope(allButtons);
           const lSplit = filterByFocusScope(allLinks);
           const iSplit = filterByFocusScope(allInputs);
           const imgSplit = filterByFocusScope(allImages);
           allButtons = bSplit.inScope;
           allLinks = lSplit.inScope;
           allInputs = iSplit.inScope;
           allImages = imgSplit.inScope;
         }

         const result = {
           ...raw,
           ...(backend.isMiniLM ? { matchBackend: 'minilm' } : {}),
           buttons: allButtons.filter(filterElement),
           links:   allLinks.filter(filterElement),
           inputs:  allInputs.filter(filterElement),
           images:  allImages.filter(filterElement),
           ...(args.focusScope ? { scopeApplied: true, scopeSelector: args.focusScope } : {}),
         };

         // Add suggestions if no results and includeSuggestions is true
         if (args.includeSuggestions !== false && result.buttons.length === 0 && result.links.length === 0 &&
             result.inputs.length === 0 && result.images.length === 0 && args.search) {
           const allElements = [...(raw.buttons || []), ...(raw.links || []), ...(raw.inputs || []), ...(raw.images || [])];
           result._suggestions = await generateSuggestions(args.search, allElements);
         }

         if (systemMessage) result._systemMessage = systemMessage;
         return withFreshness(args.tabId, 'ui-catalog', result, cache);
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
      const raw = await cache.readSessionFile(args.tabId, 'raw/accessibility/tree.json');
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
      const raw = await cache.readSessionFile(args.tabId, 'raw/storage/data.json');
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
      const raw = await cache.readSessionFile(args.tabId, 'raw/console/logs.json');
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
      const raw = await cache.readSessionFile(args.tabId, 'raw/perf/metrics.json');
      if (!raw) return { error: 'Performance metrics not available. Trigger refresh_data.' };
      return withFreshness(args.tabId, 'perf-analyzer', raw, cache);
    },
  });

  // 12. get_css_analysis
  tools.push({
    definition: {
      name: 'get_css_analysis',
      description: 'Get CSS custom properties (variables), stylesheet statistics, and computed styles for key elements. Includes css_origin_map when intelligence layer is active. Useful for understanding theming, design tokens, or style issues.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:     { type: 'number', description: 'Tab ID from get_sessions' },
          selector:  { type: 'string', description: 'Filter elements by CSS selector substring (e.g. ".btn-primary", "#header")' },
          property:  { type: 'string', description: 'Filter by CSS property name (e.g. "color", "background", "font-size")' },
          value:     { type: 'string', description: 'Filter by CSS property value (e.g. "red", "16px")' },
          inViewport: { type: 'boolean', description: 'Only return elements currently in the viewport' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = await cache.readSessionFile(args.tabId, 'raw/css/analysis.json');
      if (!raw) return { error: 'CSS analysis not available.' };

      // Get viewport for inViewport filtering
      let vp = null;
      if (args.inViewport) {
        const liveVp = await cache.readSessionFile(args.tabId, 'raw/visual/viewport.json');
        vp = liveVp || raw.viewport || null;
      }

      let result = { ...raw };

      // Filter by selector, property, value, or viewport
      if (args.selector || args.property || args.value || args.inViewport) {
        const selFilter = args.selector ? args.selector.toLowerCase() : null;
        const propFilter = args.property ? args.property.toLowerCase() : null;
        const valFilter = args.value ? args.value.toLowerCase() : null;

        // Filter elements array if present
        if (raw.elements && Array.isArray(raw.elements)) {
          result.elements = raw.elements.filter(el => {
            if (selFilter && el.selector) {
              if (!el.selector.toLowerCase().includes(selFilter)) return false;
            }
            if (propFilter && el.computedStyles) {
              if (!Object.keys(el.computedStyles).some(p => p.toLowerCase().includes(propFilter))) return false;
            }
            if (valFilter && el.computedStyles) {
              if (!Object.values(el.computedStyles).some(v => String(v).toLowerCase().includes(valFilter))) return false;
            }
            if (vp && el.x !== undefined && el.y !== undefined) {
              if (!filterByViewport([el], vp).length) return false;
            }
            return true;
          });
        }
      }

      const final = await withFreshness(args.tabId, 'css-analyzer', result, cache);
      // Attach css_origin_map from intelligence layer if available
      const originMap = await cache.readSessionFile(args.tabId, 'raw/intelligence/css-origin-map.json');
      if (originMap) {
        final.css_origin_map = originMap;
      }
      return final;
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
          tabId:     { type: 'number', description: 'Tab ID from get_sessions' },
          selector:  { type: 'string', description: 'Filter elements by CSS selector substring (e.g. ".btn-primary", "#header")' },
          tag:       { type: 'string', description: 'Filter by HTML tag name (e.g. "div", "span", "button")' },
          text:      { type: 'string', description: 'Filter by text content (case-insensitive)' },
          role:      { type: 'string', description: 'Filter by ARIA role (e.g. "button", "link", "textbox")' },
          maxDepth:  { type: 'number', description: 'Max tree depth to return (default: 20)' },
          inViewport: { type: 'boolean', description: 'Only return elements currently in the viewport' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const raw = await cache.readSessionFile(args.tabId, 'raw/dom/snapshot.json');
      if (!raw) return { error: 'DOM snapshot not available.' };

      // Get viewport for inViewport filtering
      let vp = null;
      if (args.inViewport) {
        const liveVp = await cache.readSessionFile(args.tabId, 'raw/visual/viewport.json');
        vp = liveVp || raw.viewport || null;
      }

      let result = { ...raw };

      // Filter DOM tree if present
      if (raw.tree && (args.selector || args.tag || args.text || args.role || args.inViewport)) {
        const selFilter = args.selector ? args.selector.toLowerCase() : null;
        const tagFilter = args.tag ? args.tag.toLowerCase() : null;
        const textFilter = args.text ? args.text.toLowerCase() : null;
        const roleFilter = args.role ? args.role.toLowerCase() : null;

        const filterNode = (node) => {
          if (!node) return null;
          const inViewportMatch = !args.inViewport || !node.x || !node.y ||
            filterByViewport([{ x: node.x, y: node.y, width: node.width, height: node.height }], vp).length > 0;
          const match = inViewportMatch && (
            (!selFilter || (node.selector && node.selector.toLowerCase().includes(selFilter))) &&
            (!tagFilter || (node.tag && node.tag.toLowerCase() === tagFilter)) &&
            (!textFilter || (node.text && node.text.toLowerCase().includes(textFilter))) &&
            (!roleFilter || (node.role && node.role.toLowerCase() === roleFilter))
          );
          const filteredChildren = (node.children || []).map(filterNode).filter(Boolean);
          if (match || filteredChildren.length) {
            return { ...node, children: filteredChildren };
          }
          return null;
        };

        result.tree = filterNode(raw.tree);
      }

      // Apply maxDepth truncation
      const maxDepth = args.maxDepth || 20;
      const truncate = (node, depth) => {
        if (!node || depth > maxDepth) return null;
        return {
          ...node,
          children: (node.children || []).map(c => truncate(c, depth + 1)).filter(Boolean),
        };
      };

      if (result.tree) {
        result.tree = truncate(result.tree, 0);
      }

      return withFreshness(args.tabId, 'dom-generic', result, cache);
    },
  });

  // 14. find_target — "where do I act for X?" one-shot resolver
  tools.push({
    definition: {
      name: 'find_target',
      description: 'Find the best interactive element(s) for a query. Combines get_ui_catalog (buttons/links/inputs, with accessible-name labels) and get_text_coords, fuzzy-ranks them (MiniLM when available), and returns ranked candidates with click coordinates (center), a selector hint, kind, score, and — for inputs — the inferred enterKey. Each candidate also carries a clickable hint (true/false/null) with obstructedBy when covered. Use this when you know WHAT to interact with ("送信", "search box", "next") but not the exact element. The returned center can be passed straight to click(x,y). Set verify=true to live-check the top candidate(s) clickability at call time (adds a round-trip; attaches a live{} report).',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:      { type: 'number', description: 'Tab ID from get_sessions' },
          query:      { type: 'string', description: 'What to act on — visible text, accessible label, or intent (e.g. "送信", "search", "next page").' },
          kind:       { type: 'string', enum: ['any', 'button', 'link', 'input', 'text'], description: 'Restrict to a kind of target (default: any).' },
          limit:      { type: 'number', description: 'Max candidates to return (default: 5).' },
          inViewport: { type: 'boolean', description: 'Only consider elements currently within the viewport.' },
          minScore:   { type: 'number', description: 'Minimum fuzzy score 0.0-1.0 (default: 0.3).' },
          verify:     { type: 'boolean', description: 'Re-check the top candidate(s) live (via analyze_click) for up-to-date clickability/obstruction at call time, instead of the collection-time hint. Adds one round-trip per verified candidate; attaches a live{} report and may correct clickable.' },
          verifyTop:  { type: 'number', description: 'How many top candidates to verify when verify=true (default: 1).' },
        },
        required: ['tabId', 'query'],
      },
    },
    handler: async (args, cb) => {
      const cache = cb.cache;
      const kind = args.kind || 'any';
      const limit = args.limit || 5;
      const minScore = args.minScore != null ? args.minScore : 0.3;

      const ui = await cache.readSessionFile(args.tabId, 'raw/ui/elements.json');
      const tc = (kind === 'text' || kind === 'any')
        ? await cache.readSessionFile(args.tabId, 'raw/visual/text-coords.json') : null;
      if (!ui && !tc) return { error: 'No UI/text data yet. Trigger refresh_data first.' };

      const center = (r) => r ? { x: Math.round(r.x + (r.w || 0) / 2), y: Math.round(r.y + (r.h || 0) / 2) } : null;
      const selFrom = (el) => el.id ? `#${el.id}`
        : (el.name ? `[name="${el.name}"]`
        : (el.classes ? '.' + String(el.classes).trim().split(/\s+/).slice(0, 2).join('.') : null));

      const cands = [];
      const pushEl = (kindName, el) => {
        const text = (el.label || el.text || el.placeholder || el.name || '').trim();
        if (!text) return;
        cands.push({
          kind: kindName, text, center: center(el.rect), selector: selFrom(el),
          ...(el.enterKey ? { enterKey: el.enterKey } : {}),
          ...(el.clickable !== undefined ? { clickable: el.clickable } : {}),
          ...(el.obstructedBy ? { obstructedBy: el.obstructedBy } : {}),
          ...(el.href ? { href: el.href } : {}),
        });
      };
      if (ui) {
        if (kind === 'any' || kind === 'button') (ui.buttons || []).forEach(b => pushEl('button', b));
        if (kind === 'any' || kind === 'link')   (ui.links   || []).forEach(l => pushEl('link', l));
        if (kind === 'any' || kind === 'input')  (ui.inputs  || []).forEach(i => pushEl('input', i));
      }
      if (tc && (kind === 'text' || kind === 'any')) {
        (tc.words || []).forEach(w => {
          const text = (w.text || '').trim();
          if (!text) return;
          cands.push({
            kind: 'text', text, selector: null,
            center: { x: Math.round((w.left ?? w.x ?? 0) + (w.width || 0) / 2), y: Math.round((w.top ?? w.y ?? 0) + (w.height || 0) / 2) },
          });
        });
      }

      let pool = cands;
      if (args.inViewport) {
        const vp = ui?.viewport || tc?.viewport || null;
        if (vp) pool = pool.filter(c => c.center &&
          c.center.x >= vp.scrollX && c.center.x <= vp.scrollX + vp.width &&
          c.center.y >= vp.scrollY && c.center.y <= vp.scrollY + vp.height);
      }

      const backend = await resolveBackend(cb._config);
      setBackend(backend);
      let scored;
      if (backend.batchFuzzyScore) {
        const scores = await backend.batchFuzzyScore(args.query, pool.map(c => c.text));
        scored = pool.map((c, i) => ({ ...c, score: scores[i] }));
      } else {
        scored = pool.map(c => ({ ...c, score: fuzzyScore(args.query, c.text) }));
      }

      // Demote obstructed (clickable:false) and offscreen (null) candidates so a
      // reachable target outranks a covered one of similar score — without overriding a
      // clearly better text match. The reported score stays the true fuzzy score.
      const reach = (c) => c.clickable === false ? 0.2 : (c.clickable === null ? 0.05 : 0);
      const candidates = scored
        .filter(c => c.score >= minScore)
        .sort((a, b) => (b.score - reach(b)) - (a.score - reach(a)))
        .slice(0, limit)
        .map(c => ({
          ...c,
          score: Math.round(c.score * 100) / 100,
          recommend: c.kind === 'input'
            ? 'type_text(selector, text, submit:"auto") — or click(center) then type'
            : 'click(center.x, center.y) — or click(text)',
        }));

      // Optional live verification: re-run clickability (analyze_click) on the top
      // candidate(s) so the agent gets call-time obstruction, not the collection-time
      // hint. Prefer selector/text over coords (elementFromPoint at coords would hit the
      // overlay, not the target). Bounded to verifyTop to limit round-trips.
      if (args.verify && cb._callAction && candidates.length) {
        const n = Math.min(candidates.length, Math.max(1, args.verifyTop || 1));
        for (let i = 0; i < n; i++) {
          const c = candidates[i];
          const action = { type: 'analyze_click' };
          if (c.selector) action.selector = c.selector;
          else if (c.text) action.text = c.text;
          else if (c.center) { action.x = c.center.x; action.y = c.center.y; }
          else continue;
          try {
            const res = await cb._callAction(args.tabId, action, 8000);
            const rep = res && res.result && res.result.clickability;
            if (rep) {
              c.live = {
                exists: rep.exists,
                inViewport: rep.inViewport,
                obstructed: rep.obstructed ?? null,
                recommendedStrategy: rep.recommendedStrategy ?? null,
              };
              if (rep.exists === false || rep.obstructed === true) c.clickable = false;
              else if (rep.obstructed === false) c.clickable = true;
            }
          } catch (_) { /* leave the collection-time hint as-is */ }
        }
      }

      return {
        query: args.query,
        ...(backend.isMiniLM ? { matchBackend: 'minilm' } : {}),
        total: pool.length,
        candidates,
        ...(candidates.length === 0 ? { note: 'No candidate above minScore. Lower minScore, widen kind, or call refresh_data.' } : {}),
      };
    },
  });

  registry.registerTools(tools);
};
