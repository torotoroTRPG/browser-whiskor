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
  return _tools.filter(tool => isToolEnabled(tool.name));
}

function getToolNames() {
  return _tools.map(t => t.name);
}

// ── Tool Execution ────────────────────────────────────────────────────────────
async function callTool(name, args) {
  const handler = _handlers[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }

  if (!isToolEnabled(name)) {
    return { error: `Tool "${name}" is disabled by MCP tools configuration.` };
  }

  try {
    return await handler(args, _callbacks);
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
};
