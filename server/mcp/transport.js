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

// ── MCP stdio transport ───────────────────────────────────────────────────────
// `identity` (optional) = { instanceId, name } from config.json identity section,
// surfaced in serverInfo so an agent talking to several whiskor servers can tell
// which instance answered. Falls back to the plain product name when unset.
function startMcpServer(identity = null) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request;
    try { request = JSON.parse(trimmed); }
    catch { return; }

    const { id, method, params } = request;

    try {
      let result;

      if (method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          capabilities:    { tools: {} },
          serverInfo:      {
            name:    'browser-whiskor',
            version: PKG_VERSION,
            ...(identity && (identity.instanceId || identity.name)
              ? { instanceId: identity.instanceId || undefined, instanceName: identity.name || undefined }
              : {}),
          },
        };
      } else if (method === 'notifications/initialized') {
        return;
      } else if (method === 'tools/list') {
        result = { tools: registry.getFilteredTools() };
      } else if (method === 'tools/call') {
        const toolResult = await registry.callTool(params.name, params.arguments || {});
        result = { content: toContentBlocks(toolResult) };
      } else {
        result = {};
      }

      const response = JSON.stringify({ jsonrpc: '2.0', id, result });
      process.stdout.write(response + '\n');
    } catch (err) {
      const errResponse = JSON.stringify({
        jsonrpc: '2.0', id,
        error: { code: -32603, message: err.message },
      });
      process.stdout.write(errResponse + '\n');
    }
  });

  process.stderr.write(`[whiskor:mcp] MCP server ready — ${registry.getToolNames().length} tools registered\n`);
}

module.exports = { startMcpServer };
