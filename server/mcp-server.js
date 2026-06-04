/**
 * server/mcp-server.js  –  browser-whiskor MCP server
 * (version は package.json が唯一の真実 — ここには書かない)
 *
 * MCP (Model Context Protocol) server — 新アーキテクチャ。
 *
 * 階層:
 *   mcp-server.js (エントリポイント)
 *     → mcp/registry.js (ツール登録・フィルタリング)
 *     → mcp/tools/read.js (read-basic / read-data / read-state / read-helpers)
 *     → mcp/tools/write.js
 *     → mcp/tools/capture.js / capture-element.js
 *     → mcp/tools/control.js
 *     → mcp/tools/intelligence.js
 *     → mcp/tools/replay.js
 *     → mcp/transport.js (stdio/JSON-RPC)
 *
 * ツールはカテゴリ別（read / write / capture / tabs / control / intelligence / replay）。
 * 正確なツール数・プロファイル内訳は CLAUDE.md と server/configs/tool-profiles.json を正とする。
 */
'use strict';

const registry  = require('./mcp/registry');
const transport = require('./mcp/transport');
const toolManager = require('./tool-manager');

// ツールカテゴリを登録
require('./mcp/tools/read')(registry);
require('./mcp/tools/write')(registry);
require('./mcp/tools/tabs')(registry);
require('./mcp/tools/capture')(registry);
require('./mcp/tools/control')(registry);
require('./mcp/tools/intelligence')(registry);

// replay_session ツール — array-push pattern (see replay.js)
const _replayTools = [];
require('./mcp/tools/replay')(_replayTools);
for (const t of _replayTools) registry.registerTool(t.definition, t.handler);

// ── Callbacks from index.js ───────────────────────────────────────────────────
let _config = {};
let _sessionId = 'default';
let _identity = null;

function setCallbacks(pushConfig, triggerCollect, triggerExplorer) {
  registry.setCallbacks({ _pushConfig: pushConfig, _triggerCollect: triggerCollect, _triggerExplorer: triggerExplorer });
}

function setActionCallbacks(callAction, captureScreenshot, captureElement, capturePackedSom) {
  registry.setCallbacks({ _callAction: callAction, _captureScreenshot: captureScreenshot, _captureElement: captureElement, _capturePackedSom: capturePackedSom });
}

function setSomStats(store) {
  registry.setCallbacks({ _somStats: store });
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

function setIntelligenceCallbacks(correlator, sourceStore, cache) {
  registry.setCallbacks({
    _correlator:  correlator  || null,
    _sourceStore: sourceStore || null,
    cache:        cache       || null,
  });
}

function setReplayCallbacks(requestHash, sessionReplay) {
  registry.setCallbacks({
    _requestHash:  requestHash  || null,
    _sessionReplay: sessionReplay || null,
  });
}

function setConfig(config) {
  _config = config;
}

function setSessionId(id) {
  _sessionId = id;
}

function setIdentity(identity) {
  _identity = identity || null;
}

// ── Tool Manager Integration ──────────────────────────────────────────────────
function initToolManager() {
  toolManager.initSession(_sessionId);
  registry.setToolManager(toolManager, _sessionId, _config);
}

function processToolCall(toolName, args) {
  const allTools = registry.getAllTools();
  return toolManager.processTurn(_sessionId, { name: toolName, args }, allTools, _config);
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
  transport.startMcpServer(_identity);
}

module.exports = {
  startMcpServer,
  setCallbacks,
  setActionCallbacks,
  setSomStats,
  setSecurity,
  setIntelligenceCallbacks,
  setNavigateBroadcast,
  setConfigLog,
  setStartupWarnings,
  setMcpToolsConfig,
  getMcpToolsConfig,
  applyPreset,
  setConfig,
  setSessionId,
  setIdentity,
  initToolManager,
  processToolCall,
  toolManager,
  setReplayCallbacks,
};
