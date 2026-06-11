/**
 * server/mcp/transport.js
 * MCPトランスポート層 — stdio経由のJSON-RPC 2.0通信。
 *
 * 階層:
 *   transport.js (stdio/JSON-RPC) → registry.js (フィルタリング) → tools/*.js (ハンドラ)
 */
'use strict';

const readline = require('readline');
const registry = require('./registry');

// package.json is the single source of truth for the version (no hardcoding).
let PKG_VERSION = '0.0.0';
try { PKG_VERSION = require('../../package.json').version || PKG_VERSION; } catch { /* fall back */ }

/**
 * ツールハンドラの返り値を MCP content blocks に変換する。
 *
 * 通常は結果を text(JSON) 1ブロックに包む。ただしハンドラが
 *   _mcpImage: { data: <base64>, mimeType: 'image/jpeg' }
 * を付けている場合は、それを本物の image ブロックとして先頭に並べ、
 * 残りのメタ情報(filePath/width/elements 等)は text ブロックに残す。
 * これによりモデルは画像を「視覚入力」として実際に見られる一方、
 * base64 を text(JSON) に埋め込んでトークンを浪費する事故を防ぐ。
 */
function toContentBlocks(toolResult) {
  if (toolResult && toolResult._mcpImage && toolResult._mcpImage.data) {
    const { data, mimeType } = toolResult._mcpImage;
    // base64 を text 側へ二重計上しないよう _mcpImage と dataUrl は除外する
    const { _mcpImage, dataUrl, ...rest } = toolResult;
    return [
      { type: 'image', data, mimeType: mimeType || 'image/png' },
      { type: 'text',  text: JSON.stringify(rest, null, 2) },
    ];
  }
  return [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }];
}

// Build the MCP serverInfo block. `identity` lets an agent tell whiskor instances
// apart; `redaction` (when active) tells the agent its perception is privacy-
// filtered, so it expects [WHISKOR_REDACTED ...] tokens and reaches for
// type_secret instead of typing a secret it should not see. Counts only — never
// the secret values.
function buildServerInfo(identity, redaction) {
  const info = { name: 'browser-whiskor', version: PKG_VERSION };
  if (identity && identity.instanceId) info.instanceId = identity.instanceId;
  if (identity && identity.name)       info.instanceName = identity.name;
  if (redaction && redaction.active) {
    info.redaction = {
      active: true,
      knownValues: redaction.knownValues || 0,
      patterns:    redaction.patterns || 0,
      refs:        redaction.refs || 0,
      note: 'Your perception is privacy-filtered server-side: real secrets appear as [WHISKOR_REDACTED type=.. ...] tokens, not their values. To enter a secret you must not see, call type_secret with its ref name.',
    };
  }
  return info;
}

// Resolve the redaction status shown in serverInfo. Standalone mode wires the
// live guard object (`_secretGuard`, read synchronously); the proxy process has
// no in-process guard — the secrets live in the worker — so it wires
// `_redactionStatus`, an async provider that asks the worker's /health (counts
// only). Without this, serverInfo silently omitted the redaction notice under
// the proxy (T11b). Any provider failure degrades to "no notice", never an
// initialize error — the notice is informational.
async function resolveRedaction(cbs = {}) {
  if (typeof cbs._redactionStatus === 'function') {
    try {
      const r = await cbs._redactionStatus();
      return (r && r.active)
        ? { active: true, knownValues: r.knownValues || 0, patterns: r.patterns || 0, refs: r.refs || 0 }
        : null;
    } catch {
      return null;
    }
  }
  const sg = cbs._secretGuard;
  return (sg && sg.active)
    ? { active: true, knownValues: sg.count || 0, patterns: sg.patternCount || 0, refs: sg.refCount || 0 }
    : null;
}

// Fingerprint of the currently visible toolset, used to detect when a tools/call
// changed tool visibility as a side effect (profile auto-load, idle unload,
// explicit load_profile/unload_profile).
function visibleToolsKey() {
  try { return registry.getFilteredTools().map(t => t.name).sort().join(','); }
  catch { return ''; }
}

// ── Request handling (transport-agnostic, testable) ──────────────────────────
// Takes one raw stdio line and returns the JSON-RPC messages to write to stdout,
// response first, then any notifications. Returns [] for blank/unparseable lines
// and for client notifications that need no reply.
async function handleLine(line, identity = null) {
  const trimmed = String(line).trim();
  if (!trimmed) return [];

  let request;
  try { request = JSON.parse(trimmed); }
  catch { return []; }

  const { id, method, params } = request;
  const out = [];

  try {
    let result;

    if (method === 'initialize') {
      const redaction = await resolveRedaction(registry.getCallbacks());
      result = {
        protocolVersion: '2024-11-05',
        capabilities:    { tools: { listChanged: true } },
        serverInfo:      buildServerInfo(identity, redaction),
      };
    } else if (method === 'notifications/initialized') {
      return [];
    } else if (method === 'tools/list') {
      result = { tools: registry.getFilteredTools() };
    } else if (method === 'tools/call') {
      // Dynamic profiles can change the visible toolset as a side effect of this
      // very call. Clients that cache tools/list (i.e. don't re-fetch on every
      // turn) would otherwise never see dynamically loaded tools — notify them.
      const before = visibleToolsKey();
      const toolResult = await registry.callTool(params.name, params.arguments || {});
      result = { content: toContentBlocks(toolResult) };
      if (visibleToolsKey() !== before) {
        out.push({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
    } else {
      result = {};
    }

    out.unshift({ jsonrpc: '2.0', id, result });
    return out;
  } catch (err) {
    return [{ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } }];
  }
}

// ── MCP stdio transport ───────────────────────────────────────────────────────
// `identity` (optional) = { instanceId, name } from config.json identity section,
// surfaced in serverInfo so an agent talking to several whiskor servers can tell
// which instance answered. Falls back to the plain product name when unset.
function startMcpServer(identity = null) {
  // From here on, stdout is the JSON-RPC channel. Any stray console.log — e.g.
  // the "[cache] ..." lines from cache-writer when this process runs standalone
  // (no separate worker on :7892) — would reach the client as a corrupt message
  // ("Ignoring non-JSON line on stdout"). Reroute bare console.log/info to
  // stderr; console.warn/error already go there.
  console.log  = (...a) => console.error(...a);
  console.info = (...a) => console.error(...a);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const messages = await handleLine(line, identity);
    for (const m of messages) process.stdout.write(JSON.stringify(m) + '\n');
  });

  process.stderr.write(`[whiskor:mcp] MCP server ready — ${registry.getToolNames().length} tools registered\n`);
}

module.exports = { startMcpServer, handleLine, buildServerInfo, resolveRedaction };
