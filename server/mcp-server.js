/**
 * server/mcp-server.js  –  browser-whiskor v3
 *
 * MCP (Model Context Protocol) server — 新アーキテクチャ。
 *
 * 階層:
 *   mcp-server.js (エントリポイント)
 *     → mcp/registry.js (ツール登録・フィルタリング)
 *       → mcp/tools/read.js
 *       → mcp/tools/write.js
 *       → mcp/tools/capture.js
 *       → mcp/tools/control.js
 *     → mcp/transport.js (stdio/JSON-RPC)
 *
 * 既存の全39ツールを保持。機能変更なし。
 */
'use strict';

const registry  = require('./mcp/registry');
const transport = require('./mcp/transport');

// ツールカテゴリを登録
require('./mcp/tools/read')(registry);
require('./mcp/tools/write')(registry);
require('./mcp/tools/capture')(registry);
require('./mcp/tools/control')(registry);

// ── Callbacks from index.js ───────────────────────────────────────────────────
function setCallbacks(pushConfig, triggerCollect, triggerExplorer) {
  registry.setCallbacks({ _pushConfig: pushConfig, _triggerCollect: triggerCollect, _triggerExplorer: triggerExplorer });
}

function setActionCallbacks(callAction, captureScreenshot) {
  registry.setCallbacks({ _callAction: callAction, _captureScreenshot: captureScreenshot });
}

function setNavigateBroadcast(fn) {
  registry.setCallbacks({ _navigateBroadcast: fn });
}

function setConfigLog(log) {
  registry.setCallbacks({ _configLog: log });
}

function setStartupWarnings(warnings) {
  registry.setCallbacks({ _startupWarnings: warnings });
}

function setSecurity(sec) {
  registry.setCallbacks({ _security: sec });
}

// ── Config management ─────────────────────────────────────────────────────────
function setMcpToolsConfig(config) {
  registry.setMcpToolsConfig(config);
}

function getMcpToolsConfig() {
  return registry.getMcpToolsConfig();
}

function applyPreset(presetName) {
  return registry.applyPreset(presetName);
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startMcpServer() {
  transport.startMcpServer();
}

module.exports = {
  startMcpServer,
  setCallbacks,
  setActionCallbacks,
  setSecurity,
  setNavigateBroadcast,
  setConfigLog,
  setStartupWarnings,
  setMcpToolsConfig,
  getMcpToolsConfig,
  applyPreset,
  getToolNames: () => registry.getToolNames(),
  getFilteredTools: () => registry.getFilteredTools(),
};
