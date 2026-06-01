/**
 * server/mcp/tools/read-state.js
 * State graph READ tools: state map, list/search/detail, pin, patterns, delta.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

module.exports = function registerStateTools(registry) {
  const tools = [];

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

  // 19. lookup_pattern
  tools.push({
    definition: {
      name: 'lookup_pattern',
      description: 'Look up details of a known UI pattern by its reference ID (e.g. "pat-abc12345"). Use this when you see a "ref" in delta updates but need to recall its definition, behavior, or context. Returns the full pattern definition including movement vector, element types, and previous occurrences.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Pattern reference ID (e.g. "pat-abc12345", "modal-error-v1")' },
        },
        required: ['id'],
      },
    },
    handler: async (args, cb) => {
      const patternRegistry = require('../../pattern-registry');
      const detail = patternRegistry.getPatternDetail(args.id);
      if (!detail) return { error: `Pattern "${args.id}" not found. It may have been cleared or never registered.` };
      return detail;
    },
  });

  // 20. list_patterns
  tools.push({
    definition: {
      name: 'list_patterns',
      description: 'List all known UI patterns for a tab. Shows pattern refs, types, labels, and how many times each has been seen. Use this to understand what recurring UI behaviors have been observed.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID from get_sessions' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const patternRegistry = require('../../pattern-registry');
      const patterns = patternRegistry.getPatternsForTab(args.tabId);
      return { tabId: args.tabId, totalPatterns: patterns.length, patterns };
    },
  });

  // 21. get_delta
  tools.push({
    definition: {
      name: 'get_delta',
      description: 'Get the latest aggregated UI changes (smart delta) for a tab. Includes scroll movements, element groups moving together, content updates, and new/appeared elements. Known patterns are returned as "ref" IDs — use lookup_pattern to get full definitions. Use this to understand what changed on the page since the last data collection.',
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
      const delta = await cache.getSmartDelta(args.tabId);
      if (!delta) return { note: 'No delta data available. Interact with the page and try again.' };
      return delta;
    },
  });
  registry.registerTools(tools);
};
