/**
 * tests/unit/mcp-prompts.test.js
 *
 * MCP prompts primitive. Exercises the REAL prompts module (listPrompts/getPrompt)
 * and the transport wiring (initialize capability + prompts/list + prompts/get),
 * including the required-argument guard that surfaces as a JSON-RPC -32602.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const prompts   = require('../../server/mcp/prompts');
const transport = require('../../server/mcp/transport');

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

describe('MCP prompts — module', () => {
  it('lists prompts with name/description/arguments', () => {
    const list = prompts.listPrompts();
    assert.ok(list.length >= 3);
    for (const p of list) {
      assert.ok(typeof p.name === 'string' && p.name.length > 0);
      assert.ok(typeof p.description === 'string' && p.description.length > 0);
      assert.ok(Array.isArray(p.arguments));
    }
    assert.ok(list.some(p => p.name === 'investigate_tab'));
  });

  it('builds a prompt body referencing real whiskor tools', () => {
    const got = prompts.getPrompt('investigate_tab', {});
    assert.equal(got.messages[0].role, 'user');
    assert.equal(got.messages[0].content.type, 'text');
    assert.match(got.messages[0].content.text, /get_sessions/);
  });

  it('substitutes provided arguments into the body', () => {
    const got = prompts.getPrompt('find_and_act', { target: 'Sign in', action: 'click' });
    assert.match(got.messages[0].content.text, /Sign in/);
    assert.match(got.messages[0].content.text, /find_target/);
  });

  it('throws -32602 for an unknown prompt', () => {
    try { prompts.getPrompt('nope', {}); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, -32602); }
  });

  it('throws -32602 when a required argument is missing', () => {
    try { prompts.getPrompt('find_and_act', {}); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, -32602); }
  });
});

describe('MCP prompts — transport', () => {
  it('declares the prompts capability on initialize', async () => {
    const out = await transport.handleLine(rpc(1, 'initialize'));
    assert.ok(out[0].result.capabilities.prompts);
  });

  it('answers prompts/list', async () => {
    const out = await transport.handleLine(rpc(2, 'prompts/list'));
    assert.ok(Array.isArray(out[0].result.prompts));
    assert.ok(out[0].result.prompts.length >= 3);
  });

  it('answers prompts/get with messages', async () => {
    const out = await transport.handleLine(rpc(3, 'prompts/get', { name: 'debug_errors', arguments: {} }));
    assert.ok(Array.isArray(out[0].result.messages));
    assert.match(out[0].result.messages[0].content.text, /get_console_logs/);
  });

  it('surfaces a -32602 error for a missing required argument', async () => {
    const out = await transport.handleLine(rpc(4, 'prompts/get', { name: 'find_and_act', arguments: {} }));
    assert.equal(out[0].error.code, -32602);
  });
});
