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

// ── MCP stdio transport ───────────────────────────────────────────────────────
function startMcpServer() {
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
          serverInfo:      { name: 'browser-whiskor', version: '3.0.0' },
        };
      } else if (method === 'notifications/initialized') {
        return;
      } else if (method === 'tools/list') {
        result = { tools: registry.getFilteredTools() };
      } else if (method === 'tools/call') {
        const toolResult = await registry.callTool(params.name, params.arguments || {});
        result = {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
        };
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
