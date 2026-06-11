/**
 * tests/unit/transport-list-changed.test.js
 *
 * MCP transport: tools/list_changed notification. Dynamic profiles change the
 * visible toolset as a side effect of tools/call (auto-load on first use, idle
 * unload, explicit load_profile). Clients that cache tools/list once need a
 * notifications/tools/list_changed to re-fetch — without it, dynamically loaded
 * tools are invisible to them forever.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry    = require('../../server/mcp/registry');
const transport   = require('../../server/mcp/transport');
const toolManager = require('../../server/tool-manager');

const SID = 'transport-test';
const config = { security: { allowExecuteJs: false }, agentControl: {} };

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

describe('MCP transport — tools/list_changed', () => {
  before(() => {
    toolManager.resetAll();
    // Real registry + real tool manager; only the tool handlers are stubs.
    registry.registerTool(
      { name: 'get_sessions', description: 'core tool', inputSchema: { type: 'object', properties: {} } },
      async () => ({ ok: true })
    );
    registry.registerTool(
      { name: 'get_console_logs', description: 'debug tool', inputSchema: { type: 'object', properties: {} } },
      async () => ({ ok: true, entries: [] })
    );
    toolManager.initSession(SID);
    registry.setToolManager(toolManager, SID, config);
  });

  after(() => {
    toolManager.resetAll();
  });

  it('declares the listChanged capability on initialize', async () => {
    const out = await transport.handleLine(rpc(1, 'initialize'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 1);
    assert.equal(out[0].result.capabilities.tools.listChanged, true);
  });

  it('ignores blank and non-JSON lines', async () => {
    assert.deepEqual(await transport.handleLine(''), []);
    assert.deepEqual(await transport.handleLine('[cache] stray log line'), []);
  });

  it('emits list_changed after a call that auto-loads a profile, response first', async () => {
    // get_console_logs lives in the (unloaded) debug profile → auto-load on call.
    const out = await transport.handleLine(rpc(2, 'tools/call', { name: 'get_console_logs', arguments: {} }));
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 2);
    assert.ok(Array.isArray(out[0].result.content));
    assert.equal(out[1].method, 'notifications/tools/list_changed');
    assert.equal(out[1].id, undefined); // notification, not a response
  });

  it('stays silent when visibility does not change', async () => {
    // debug profile is loaded now — a repeat call must not re-notify.
    const out = await transport.handleLine(rpc(3, 'tools/call', { name: 'get_console_logs', arguments: {} }));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 3);
  });

  it('tools/list reflects the newly loaded profile', async () => {
    const out = await transport.handleLine(rpc(4, 'tools/list'));
    const names = out[0].result.tools.map(t => t.name);
    assert.ok(names.includes('get_console_logs'));
  });
});
