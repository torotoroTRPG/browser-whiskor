/**
 * server/mcp/tools/control.js
 * CONTROLカテゴリのMCPツール定義とハンドラ。
 */
'use strict';

module.exports = function registerControlTools(registry) {
  const tools = [];

  // 34. set_config
  tools.push({
    definition: {
      name: 'set_config',
      description: 'Update the browser-whiskor activation config pushed to all connected tabs. Can enable/disable individual plugins or change the overall activation mode. Note: requires allowAgentConfig=true in config.json. Non-recommended changes (e.g. disabling security features) are logged and may be auto-reverted on next server restart.',
      inputSchema: {
        type: 'object',
        properties: {
          mode:    { type: 'string', enum: ['always_on', 'manual', 'api', 'selective', 'off'], description: 'Activation mode' },
          plugins: { type: 'object', description: 'Map of pluginId → boolean. E.g. {"react-fiber": true, "css-analyzer": false}' },
          options: { type: 'object', description: 'Plugin-specific options, e.g. {"textCoords": {"level": "word"}, "network": {"captureBody": true}}' },
        },
      },
    },
    handler: async (args, cb) => {
      if (!cb._pushConfig) return { error: 'Config service not available.' };
      const result = cb._pushConfig({ mode: args.mode, plugins: args.plugins, options: args.options }, 'mcp-agent');
      return {
        ok: true,
        warnings: result?.warnings || [],
        _note: result?.warnings?.length
          ? 'Some changes are non-recommended and may be auto-reverted on next server restart. Use get_config_changes to review.'
          : undefined,
      };
    },
  });

  // 35. get_config_changes
  tools.push({
    definition: {
      name: 'get_config_changes',
      description: 'Get a log of config changes made during this session. Shows what was changed, when, and any warnings about non-recommended changes. Use this to review your own config modifications.',
      inputSchema: {
        type: 'object',
        properties: {
          activeOnly: { type: 'boolean', description: 'Only show non-reverted changes (default: true)' },
        },
      },
    },
    handler: async (args, cb) => {
      if (!cb._configLog) return { error: 'Config change log not available.' };
      const changes = args.activeOnly !== false
        ? cb._configLog.getActiveChanges()
        : cb._configLog._getAll?.() || [];
      return {
        changes,
        totalChanges: changes.length,
        startupWarnings: cb._startupWarnings,
      };
    },
  });

  // 36. trigger_collect
  tools.push({
    definition: {
      name: 'trigger_collect',
      description: 'Manually trigger data collection for specific plugins on a tab (or all tabs if tabId omitted). Use after page changes to get fresh data.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:   { type: 'number', description: 'Tab ID to collect from (omit for all tabs)' },
          plugins: { type: 'array', items: { type: 'string' }, description: 'Plugin IDs to run (omit for all)' },
        },
      },
    },
    handler: async (args, cb) => {
      if (!cb._triggerCollect) return { error: 'No browser connected.' };
      cb._triggerCollect(args.tabId || null, args.plugins || null);
      return { ok: true, tabId: args.tabId || 'all', plugins: args.plugins || 'all' };
    },
  });

  // 37. trigger_explorer
  tools.push({
    definition: {
      name: 'trigger_explorer',
      description: 'Start or stop the autonomous page explorer on a tab. The explorer discovers the app\'s state graph by systematically clicking interactive elements and recording state transitions.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID' },
          active:   { type: 'boolean', description: 'true = start, false = stop' },
          strategy: { type: 'string', enum: ['breadth_first', 'depth_first', 'random'], description: 'Exploration strategy (default: breadth_first)' },
        },
        required: ['tabId', 'active'],
      },
    },
    handler: async (args, cb) => {
      if (!cb._triggerExplorer) return { error: 'Explorer service not available.' };
      cb._triggerExplorer(args.tabId, args.active, args.strategy);
      return { ok: true, tabId: args.tabId, active: args.active, strategy: args.strategy || 'breadth_first' };
    },
  });

  // 38. navigate_to_state
  tools.push({
    definition: {
      name: 'navigate_to_state',
      description: 'Navigate from the current UI state to a target state by replaying recorded actions. Uses BFS to find the shortest path on the state graph, then executes each action step-by-step with hash verification. If no path exists, falls back to direct URL navigation.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:           { type: 'number', description: 'Tab ID to navigate' },
          hash:            { type: 'string', description: 'Target state hash (compositeHash)' },
          siteVersion:     { type: 'string', description: 'Site version (omit to auto-detect)' },
          timeoutMs:       { type: 'number', description: 'Total timeout in ms (default: 30000)' },
          maxSteps:        { type: 'number', description: 'Max actions to replay (default: 10)' },
          verifyEachStep:  { type: 'boolean', description: 'Verify hash after each step (default: true)' },
          allowUrlFallback: { type: 'boolean', description: 'Fall back to URL navigation if no path (default: true)' },
        },
        required: ['tabId', 'hash'],
      },
    },
    handler: async (args, cb) => {
      if (!cb._callAction) return { ok: false, error: 'No browser connected.' };
      const navigator = require('../state-navigator');
      try {
        return await navigator.navigate(args.tabId, args.hash, {
          siteVersion: args.siteVersion,
          timeoutMs: args.timeoutMs,
          maxSteps: args.maxSteps,
          verifyEachStep: args.verifyEachStep !== false,
          allowUrlFallback: args.allowUrlFallback !== false,
          stepTimeoutMs: 5000,
        }, cb._callAction, cb._navigateBroadcast || (() => {}));
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  });

  // 39. get_navigation_path
  tools.push({
    definition: {
      name: 'get_navigation_path',
      description: 'Dry-run version of navigate_to_state. Returns the planned path and confidence without executing any actions. Use this to check if a state is reachable before committing to navigation.',
      inputSchema: {
        type: 'object',
        properties: {
          fromHash:    { type: 'string', description: 'Starting state hash (omit for current state)' },
          toHash:      { type: 'string', description: 'Target state hash' },
          tabId:       { type: 'number', description: 'Tab ID (needed if fromHash omitted)' },
          siteVersion: { type: 'string', description: 'Site version (omit to auto-detect)' },
        },
        required: ['toHash'],
      },
    },
    handler: async (args, cb) => {
      const navigator = require('../state-navigator');
      let fromHash = args.fromHash;
      if (!fromHash && args.tabId && cb._callAction) {
        return { error: 'fromHash is required for dry-run. Use navigate_to_state to navigate from current state.' };
      }
      if (!fromHash) return { error: 'fromHash is required' };
      return navigator.getNavigationPath(fromHash, args.toHash, args.siteVersion);
    },
  });

  registry.registerTools(tools);
};
