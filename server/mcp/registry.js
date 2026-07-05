/**
 * server/mcp/registry.js
 * MCPツールレジストリ — ツール定義の登録、フィルタリング、モード管理。
 *
 * 階層:
 *   transport.js (stdio/JSON-RPC) → registry.js (フィルタリング) → tools/*.js (ハンドラ)
 */
'use strict';

const { loadMcpToolsConfig } = require('../config-loader');

// ── State ─────────────────────────────────────────────────────────────────────
let _tools = [];
let _handlers = {};
let _config = loadMcpToolsConfig();
let _callbacks = {};
let _toolManager = null;
let _sessionId = null;
let _serverConfig = {};

// ── Tool Manager Integration ──────────────────────────────────────────────────
function setToolManager(manager, sessionId, config) {
  _toolManager = manager;
  _sessionId = sessionId;
  _serverConfig = config;
}

function getAllTools() {
  return _tools.map(t => ({ definition: t, handler: _handlers[t.name] }));
}

// ── Tool Registration ─────────────────────────────────────────────────────────
function registerTool(definition, handler) {
  _tools.push(definition);
  _handlers[definition.name] = handler;
}

function registerTools(toolArray) {
  for (const { definition, handler } of toolArray) {
    registerTool(definition, handler);
  }
}

// ── Callbacks from index.js ───────────────────────────────────────────────────
function setCallbacks(callbacks) {
  _callbacks = { ..._callbacks, ...callbacks };
}

function getCallbacks() {
  return { ..._callbacks };
}

// ── Config Management ─────────────────────────────────────────────────────────
function setMcpToolsConfig(config) {
  _config = config;
}

function getMcpToolsConfig() {
  return _config;
}

function isToolEnabled(toolName) {
  const toolCfg = _config.tools?.[toolName];
  if (!toolCfg) return true;

  if (toolCfg.enabled === false) return false;

  const category = toolCfg.category;
  if (category && _config.categories?.[category]?.enabled === false) {
    return false;
  }

  return true;
}

function getFilteredTools() {
  let tools = _tools.filter(tool => isToolEnabled(tool.name));

  // Apply tool manager filtering if available
  if (_toolManager && _sessionId) {
    tools = _toolManager.getVisibleTools(_sessionId, tools.map(t => ({ definition: t })), _serverConfig)
      .map(t => t.definition);
  }

  return tools;
}

function getToolNames() {
  return _tools.map(t => t.name);
}

// ── Premise-change feed piggyback ─────────────────────────────────────────────
// MCP is pull-only: the only channel that reliably reaches the agent is the next
// tool response. Attach EXTERNAL page changes (recorded by the worker's change
// feed, outside every action window) as `_sinceYourLastLook` to any tool result
// whose args carry a tabId. Central here so every current and future tool
// participates; zero footprint when the tab's feed is empty. Reading drains the
// feed — "since your last look" is literal. Precedent: `_systemMessage`.
async function _attachChangeFeed(result, args) {
  const drain = _callbacks && _callbacks._drainChanges;
  if (typeof drain !== 'function') return result;
  const tabId = args && (typeof args.tabId === 'number' ? args.tabId : parseInt(args.tabId, 10));
  if (!Number.isFinite(tabId)) return result;
  try {
    const changes = await drain(tabId);
    if (Array.isArray(changes) && changes.length &&
        result && typeof result === 'object' && !Array.isArray(result)) {
      return { ...result, _sinceYourLastLook: changes };
    }
  } catch (_) { /* the feed is ambient context — never fail a tool call over it */ }
  return result;
}

// ── Tool Execution ────────────────────────────────────────────────────────────
async function callTool(name, args) {
  const handler = _handlers[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}. Use search_tools to discover available tools.` };
  }

  if (!isToolEnabled(name)) {
    return { error: `Tool "${name}" is disabled by configuration.` };
  }

  // Check tool manager visibility. If the tool exists but its profile simply
  // isn't loaded, auto-load the owning profile and continue, instead of bouncing
  // the call back as if the tool were unavailable (which agents misread as "not
  // implemented"). Permission-gated profiles (allowExecuteJs / allowAgentConfig)
  // are NOT auto-loaded — those return a precise reason so the agent asks the user.
  let autoEnabledProfile = null;
  if (_toolManager && _sessionId) {
    const ensured = _toolManager.ensureToolVisible(_sessionId, name, getAllTools(), _serverConfig);
    if (!ensured.visible) {
      if (ensured.reason === 'requires_config') {
        return {
          error: `Tool "${name}" is gated by configuration: it needs "${ensured.requiresConfig}" enabled (profile "${ensured.profile}").`,
          hint: `This is an intentional permission gate, not a missing tool. Ask the user to enable ${ensured.requiresConfig} in config.json${ensured.requiresConfig === 'allowAgentConfig' ? '' : ' (or via set_config when allowAgentConfig is on)'}.`,
        };
      }
      return {
        error: `Tool "${name}" is not provided by any profile.`,
        hint: `Use search_tools("${name}") to find the right tool.`,
      };
    }
    autoEnabledProfile = ensured.autoLoaded || null;

    // Process turn for auto-load/unload/warnings
    const turnResult = _toolManager.processTurn(_sessionId, { name, args }, getAllTools(), _serverConfig);
    const responseExtras = {};
    if (turnResult.warnings?.length) {
      responseExtras._warnings = turnResult.warnings;
    }
    if (turnResult.autoLoaded?.length) {
      responseExtras._autoLoaded = turnResult.autoLoaded;
    }
    if (autoEnabledProfile) {
      responseExtras._autoLoaded = [...new Set([...(responseExtras._autoLoaded || []), autoEnabledProfile])];
    }
    if (turnResult.unloaded?.length) {
      responseExtras._autoUnloaded = turnResult.unloaded;
    }

    try {
      const result = await handler(args, { ..._callbacks, _toolManager, _sessionId, _allTools: getAllTools(), _config: _serverConfig });
      return await _attachChangeFeed({ ...result, ...responseExtras }, args);
    } catch (e) {
      return { ok: false, error: e.message, ...responseExtras };
    }
  }

  try {
    return await _attachChangeFeed(await handler(args, _callbacks), args);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Preset Application ────────────────────────────────────────────────────────
function applyPreset(presetName) {
  const preset = _config.presets?.[presetName];
  if (!preset) {
    return { ok: false, error: `Unknown preset: ${presetName}. Available: ${Object.keys(_config.presets || {}).join(', ')}` };
  }

  if (preset.categories) {
    for (const [cat, enabled] of Object.entries(preset.categories)) {
      if (_config.categories[cat]) {
        _config.categories[cat].enabled = enabled;
      }
    }
  }

  if (preset.tools) {
    for (const [tool, enabled] of Object.entries(preset.tools)) {
      if (_config.tools[tool]) {
        _config.tools[tool].enabled = enabled;
      }
    }
  }

  return {
    ok: true,
    preset: presetName,
    description: preset.description,
    enabledCount: getFilteredTools().length,
    totalCount: _tools.length,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  registerTool,
  registerTools,
  setCallbacks,
  getCallbacks,
  setMcpToolsConfig,
  getMcpToolsConfig,
  isToolEnabled,
  getFilteredTools,
  getToolNames,
  callTool,
  applyPreset,
  setToolManager,
  getAllTools,
};
