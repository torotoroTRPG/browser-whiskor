#!/usr/bin/env node
'use strict';
/**
 * manual/mcp-client.js — Non-interactive MCP CLI client
 *
 * 【推奨度】準推奨 — MCP 対応アプリ (Claude Code 等) が使えない場合の代替手段。
 *           通常は Claude Code の mcp__whiskor__* ツールを直接使うこと。
 *
 * 【用途】
 *   - MCP 非対応の環境からコマンドラインで whiskor ツールを呼び出す
 *   - CI / スクリプトからの自動呼び出し
 *   - 非対話型での疎通確認
 *
 * 【使い方】
 *   node manual/mcp-client.js call <tool名> [JSON引数]
 *   node manual/mcp-client.js list
 *   node manual/mcp-client.js ping
 *   node manual/mcp-client.js profiles
 *
 * 【例】
 *   node manual/mcp-client.js ping
 *   node manual/mcp-client.js list
 *   node manual/mcp-client.js call get_sessions
 *   node manual/mcp-client.js call get_text_coords '{"tabId":1234,"search":"ログイン"}'
 *   node manual/mcp-client.js profiles
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_CMD = ['server/index.js', '--mcp'];
const TIMEOUT_MS = 15000;

// ── JSON-RPC helper ────────────────────────────────────────────────────────────
function rpc(method, id, params) {
  const msg = { jsonrpc: '2.0', id, method };
  if (params) msg.params = params;
  return JSON.stringify(msg);
}

// ── Spawn MCP server and send requests, collect responses ─────────────────────
function sendRequests(requests) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', SERVER_CMD, {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = [];
    let buf = '';

    proc.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const line of parts) {
        const t = line.trim();
        if (t) lines.push(t);
      }
    });

    const timer = setTimeout(() => {
      proc.kill();
      resolve(lines);
    }, TIMEOUT_MS);

    proc.on('close', () => {
      clearTimeout(timer);
      if (buf.trim()) lines.push(buf.trim());
      resolve(lines);
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    // Send after brief startup delay
    setTimeout(() => {
      for (const req of requests) {
        proc.stdin.write(req + '\n');
      }
      proc.stdin.end();
    }, 250);
  });
}

// ── Standard handshake sequence ───────────────────────────────────────────────
function initRequests(extra = []) {
  return [
    rpc('initialize', 1, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'mcp-client.js', version: '1.0.0' },
    }),
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    ...extra,
  ];
}

// ── Pick responses matching a specific id ─────────────────────────────────────
function findResponse(lines, id) {
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === id) return msg;
    } catch { /* skip non-JSON lines */ }
  }
  return null;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdPing() {
  console.log('\n  MCP Connection Ping');
  console.log('  ───────────────────');
  const lines = await sendRequests(initRequests());
  const resp = findResponse(lines, 1);
  if (resp && resp.result && resp.result.protocolVersion) {
    const si = resp.result.serverInfo || {};
    console.log(`  ✓ Protocol : ${resp.result.protocolVersion}`);
    console.log(`  ✓ Server   : ${si.name} v${si.version}`);
    console.log('  ✓ PASS\n');
    process.exit(0);
  } else {
    console.error('  ✗ FAIL — No valid initialize response');
    console.error('  Raw output:');
    lines.forEach(l => console.error('    ' + l));
    process.exit(1);
  }
}

async function cmdList() {
  console.log('\n  MCP tools/list');
  console.log('  ──────────────');
  const lines = await sendRequests(initRequests([rpc('tools/list', 2, {})]));
  const resp = findResponse(lines, 2);
  if (resp && resp.result && resp.result.tools) {
    const tools = resp.result.tools;
    console.log(`  ${tools.length} tools available:\n`);
    for (const t of tools) {
      console.log(`  • ${t.name.padEnd(32)} ${(t.description || '').slice(0, 60)}`);
    }
    console.log();
  } else {
    console.error('  No tools response. Raw:');
    lines.forEach(l => console.error('    ' + l));
    process.exit(1);
  }
}

async function cmdProfiles() {
  console.log('\n  MCP profile_status');
  console.log('  ──────────────────');
  const callReq = rpc('tools/call', 3, { name: 'profile_status', arguments: {} });
  const lines = await sendRequests(initRequests([callReq]));
  const resp = findResponse(lines, 3);
  if (resp && resp.result) {
    const content = resp.result.content || [];
    for (const c of content) {
      if (c.type === 'text') {
        try {
          console.log(JSON.stringify(JSON.parse(c.text), null, 2));
        } catch {
          console.log(c.text);
        }
      }
    }
    console.log();
  } else {
    console.error('  No response. Raw:');
    lines.forEach(l => console.error('    ' + l));
    process.exit(1);
  }
}

async function cmdCall(toolName, argsJson) {
  let toolArgs = {};
  if (argsJson) {
    try {
      toolArgs = JSON.parse(argsJson);
    } catch {
      console.error(`  ✗ Invalid JSON: ${argsJson}`);
      process.exit(1);
    }
  }

  const reqId = 3;
  const callReq = rpc('tools/call', reqId, { name: toolName, arguments: toolArgs });
  const lines = await sendRequests(initRequests([callReq]));
  const resp = findResponse(lines, reqId);

  if (!resp) {
    console.error(`  ✗ No response for tool: ${toolName}`);
    lines.forEach(l => console.error('    ' + l));
    process.exit(1);
  }

  if (resp.error) {
    console.error('  ✗ Error:', JSON.stringify(resp.error, null, 2));
    process.exit(1);
  }

  const content = (resp.result || {}).content || [];
  if (content.length > 0) {
    for (const c of content) {
      if (c.type === 'text') {
        try {
          process.stdout.write(JSON.stringify(JSON.parse(c.text), null, 2) + '\n');
        } catch {
          process.stdout.write(c.text + '\n');
        }
      } else {
        process.stdout.write(JSON.stringify(c, null, 2) + '\n');
      }
    }
  } else {
    process.stdout.write(JSON.stringify(resp.result, null, 2) + '\n');
  }
}

function printHelp() {
  console.log(`
  manual/mcp-client.js — Non-interactive MCP CLI client

  【推奨度】準推奨 (MCP 対応アプリがない場合の代替手段)

  Usage:
    node manual/mcp-client.js ping
    node manual/mcp-client.js list
    node manual/mcp-client.js profiles
    node manual/mcp-client.js call <tool名> [JSON引数]

  Examples:
    node manual/mcp-client.js ping
    node manual/mcp-client.js list
    node manual/mcp-client.js call get_sessions
    node manual/mcp-client.js call get_text_coords '{"tabId":1234}'
    node manual/mcp-client.js call capture_screenshot '{"tabId":1234}'
  `);
}

// ── Entry point ───────────────────────────────────────────────────────────────
(async () => {
  const [,, cmd, ...rest] = process.argv;

  switch (cmd) {
    case 'ping':     await cmdPing(); break;
    case 'list':     await cmdList(); break;
    case 'profiles': await cmdProfiles(); break;
    case 'call': {
      const toolName = rest[0];
      const argsJson = rest[1] || null;
      if (!toolName) {
        console.error('  Usage: node manual/mcp-client.js call <tool名> [JSON引数]');
        process.exit(1);
      }
      await cmdCall(toolName, argsJson);
      break;
    }
    default:
      printHelp();
      if (cmd) process.exit(1);
  }
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
