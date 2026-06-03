/**
 * tests/unit/state-store.test.js
 * Section 7.1 — State Store
 *
 * Exercises the REAL server/state-store.js (previously this suite tested an
 * inline toy `class StateStore`). Uses a dedicated throwaway siteVersion so it
 * never touches real graph data, and cleans up the persisted gzip afterwards.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const store = require('../../server/state-store');

const SV = '__unit_state_store__';
const GRAPH_FILE = path.join(
  fileURLToPath(new URL('../../cache/graphs/', import.meta.url)),
  `${SV}.json.gz`,
);

after(() => {
  try { fs.rmSync(GRAPH_FILE, { force: true }); } catch (_) {}
});

describe('7.1 State Store — nodes', () => {
  it('stores a node and reads it back by hash', () => {
    const node = store.addNode(SV, { hash: 'h1', url: 'https://shop.test/cart', title: 'Cart' });
    assert.strictEqual(node.hash, 'h1');
    assert.match(node.url, /cart/);
    assert.strictEqual(node.visitCount, 1);

    const got = store.getNodeByHash(SV, 'h1');
    assert.strictEqual(got.hash, 'h1');
    assert.strictEqual(got.pathname, '/cart');
  });

  it('counts revisits instead of duplicating the node', () => {
    store.addNode(SV, { hash: 'h-revisit', url: 'https://shop.test/x', title: 'X' });
    store.addNode(SV, { hash: 'h-revisit', url: 'https://shop.test/x', title: 'X' });
    assert.strictEqual(store.getNodeByHash(SV, 'h-revisit').visitCount, 2);
  });
});

describe('7.1 State Store — edges', () => {
  it('raises edge confidence as the same transition is re-observed', () => {
    store.addEdge(SV, { from: 'h1', to: 'h2', action: 'click', trigger: 'Checkout' });
    const first = store.getGraph(SV).edges['h1']['click:Checkout'].confidence;

    store.addEdge(SV, { from: 'h1', to: 'h2', action: 'click', trigger: 'Checkout' });
    const second = store.getGraph(SV).edges['h1']['click:Checkout'].confidence;

    assert.ok(second > first, `confidence should grow with repeats (${first} -> ${second})`);
  });
});

describe('7.1 State Store — exploration helpers', () => {
  it('getUnvisitedActions omits actions already taken from a node', () => {
    // 'Checkout' was already clicked from h1 above; 'Help' has not been.
    const uiCatalog = { buttons: [{ text: 'Checkout' }, { text: 'Help' }] };
    const actions = store.getUnvisitedActions(SV, 'h1', uiCatalog);
    const texts = actions.map(a => a.text);
    assert.ok(texts.includes('Help'));
    assert.ok(!texts.includes('Checkout'), 'a visited trigger must not be suggested again');
  });
});

describe('7.1 State Store — query ordering', () => {
  it('lists pinned nodes ahead of the rest', () => {
    store.addNode(SV, { hash: 'h2', url: 'https://shop.test/pay', title: 'Pay' });
    const res = store.pinNode(SV, 'h2', 'Payment', ['checkpoint']);
    assert.strictEqual(res.ok, true);

    const flat = store.getAllNodesFlat({ siteVersion: SV });
    assert.ok(flat.length >= 2);
    assert.strictEqual(flat[0].hash, 'h2', 'the pinned node must sort first');
    assert.strictEqual(flat[0].pinned, true);
  });
});
