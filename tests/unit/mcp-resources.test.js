/**
 * tests/unit/mcp-resources.test.js
 *
 * MCP resources primitive. Exercises the REAL resources module against both
 * cache shapes — sync (standalone, in-process cache) and async (proxy, HTTP
 * forward returning Promises) — plus the transport wiring (initialize capability,
 * resources/list, resources/templates/list, resources/read) and the -32602 for
 * an unknown uri. cache is injected via registry.setCallbacks, as index.js does.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const resources = require('../../server/mcp/resources');
const registry  = require('../../server/mcp/registry');
const transport = require('../../server/mcp/transport');

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

const SAMPLE = [
  { tabId: 101, title: 'Cart', url: 'https://shop.test/cart' },
  { tabId: 202, url: 'https://shop.test/checkout' },
];

// Standalone-mode cache: synchronous returns.
const syncCache = {
  getSessionList: () => SAMPLE,
  getSessionData: (tabId) => (SAMPLE.find(s => String(s.tabId) === String(tabId)) ? { tabId, framework: 'react', states: 3 } : null),
};

// Proxy-mode cache: Promise returns (HTTP forward).
const asyncCache = {
  getSessionList: async () => SAMPLE,
  getSessionData: async (tabId) => (SAMPLE.find(s => String(s.tabId) === String(tabId)) ? { tabId, framework: 'react', states: 3 } : null),
};

describe('MCP resources — module (sync cache)', () => {
  it('lists the static sessions resource plus one per active session', async () => {
    const list = await resources.listResources({ cache: syncCache });
    const uris = list.map(r => r.uri);
    assert.ok(uris.includes('whiskor://sessions'));
    assert.ok(uris.includes('whiskor://session/101'));
    assert.ok(uris.includes('whiskor://session/202'));
  });

  it('degrades to the static resource only when no cache is wired', async () => {
    const list = await resources.listResources({});
    assert.deepEqual(list.map(r => r.uri), ['whiskor://sessions']);
  });

  it('declares a session resource template', () => {
    const tpls = resources.listResourceTemplates();
    assert.ok(tpls.some(t => t.uriTemplate === 'whiskor://session/{tabId}'));
  });

  it('reads the sessions list resource', async () => {
    const res = await resources.readResource('whiskor://sessions', { cache: syncCache });
    assert.equal(res.contents[0].uri, 'whiskor://sessions');
    assert.equal(res.contents[0].mimeType, 'application/json');
    assert.deepEqual(JSON.parse(res.contents[0].text), SAMPLE);
  });

  it('reads a single session resource', async () => {
    const res = await resources.readResource('whiskor://session/101', { cache: syncCache });
    assert.equal(JSON.parse(res.contents[0].text).framework, 'react');
  });

  it('throws -32602 for a missing session', async () => {
    await assert.rejects(
      () => resources.readResource('whiskor://session/999', { cache: syncCache }),
      (e) => e.code === -32602,
    );
  });

  it('throws -32602 for an unknown uri', async () => {
    await assert.rejects(
      () => resources.readResource('whiskor://nope', { cache: syncCache }),
      (e) => e.code === -32602,
    );
  });
});

describe('MCP resources — module (async/proxy cache)', () => {
  it('lists sessions resolved from a Promise-returning cache', async () => {
    const list = await resources.listResources({ cache: asyncCache });
    assert.ok(list.map(r => r.uri).includes('whiskor://session/202'));
  });

  it('reads a single session from a Promise-returning cache', async () => {
    const res = await resources.readResource('whiskor://session/202', { cache: asyncCache });
    assert.equal(JSON.parse(res.contents[0].text).states, 3);
  });
});

describe('MCP resources — transport', () => {
  before(() => {
    registry.setCallbacks({ cache: syncCache });
  });

  it('declares the resources capability on initialize', async () => {
    const out = await transport.handleLine(rpc(1, 'initialize'));
    assert.ok(out[0].result.capabilities.resources);
  });

  it('answers resources/list', async () => {
    const out = await transport.handleLine(rpc(2, 'resources/list'));
    assert.ok(out[0].result.resources.map(r => r.uri).includes('whiskor://sessions'));
  });

  it('answers resources/templates/list', async () => {
    const out = await transport.handleLine(rpc(3, 'resources/templates/list'));
    assert.ok(out[0].result.resourceTemplates.length >= 1);
  });

  it('answers resources/read', async () => {
    const out = await transport.handleLine(rpc(4, 'resources/read', { uri: 'whiskor://session/101' }));
    assert.equal(JSON.parse(out[0].result.contents[0].text).framework, 'react');
  });

  it('surfaces -32602 for an unknown resource uri', async () => {
    const out = await transport.handleLine(rpc(5, 'resources/read', { uri: 'whiskor://bogus' }));
    assert.equal(out[0].error.code, -32602);
  });
});
