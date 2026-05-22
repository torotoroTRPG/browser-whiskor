/**
 * server/mcp/tools/read-data.js
 * Data inspection READ tools: network, UI catalog, accessibility, storage, console, perf, CSS, DOM.
 */
'use strict';

const { withFreshness } = require('./read-helpers');

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

  registry.registerTools(tools);
};
