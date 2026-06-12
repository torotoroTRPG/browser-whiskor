/**
 * tests/unit/states-routes.test.js
 *
 * Exercises the REAL core.js HTTP routing for state-graph nodes against the
 * REAL state-store. Guards the siteVersion drift bug: sessions default to
 * siteVersion 'default' (cache-writer) while graphs are keyed by what the
 * state reporter names them (e.g. 'v1') — the session-scoped /states route
 * used to answer [] while /api/graphs showed a populated graph.
 *
 * Uses a dedicated throwaway siteVersion so it never touches real graph data
 * (the store lazy-loads + persists cache/graphs/<sv>.json.gz), and removes the
 * persisted gzip afterwards — same isolation pattern as state-store.test.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { WhiskorCore } = require('../../server/core');
const stateMachine = require('../../server/state-machine');

const SV      = '__unit_states_routes__';
const TAB     = 4242;
const TAB_OWN = 4243; // session siteVersion === SV directly (no drift)
const GRAPH_FILE = path.join(
  fileURLToPath(new URL('../../cache/graphs/', import.meta.url)),
  `${SV}.json.gz`,
);

function get(core, pathname) {
  return core.handleHttpRequest({ method: 'GET', url: { pathname }, body: null });
}

function getQ(core, urlStr) {
  return core.handleHttpRequest({ method: 'GET', url: new URL(urlStr, 'http://x'), body: null });
}

let core;
before(() => {
  // Graph keyed by SV — the session below says 'default'. That mismatch is the
  // real-world shape this suite exists for.
  stateMachine.store.addNode(SV, { hash: 'n1', url: 'https://app.test/home',  title: 'Home' });
  stateMachine.store.addNode(SV, { hash: 'n2', url: 'https://app.test/about', title: 'About' });

  core = new WhiskorCore({
    stateMachine,
    cache: {
      handleMessage() { return Promise.resolve(); },
      getSessionList() { return []; },
      getSessionData(tabId) {
        if (tabId === TAB) return { tabId, siteVersion: 'default' };
        if (tabId === TAB_OWN) return { tabId, siteVersion: SV };
        return null;
      },
      getSessionDir() { return null; },
      readSessionFile() { return null; },
      storeSmartDelta() {},
    },
  });
  clearInterval(core._cleanupTimer);
});

after(() => {
  try { fs.rmSync(GRAPH_FILE, { force: true }); } catch (_) {}
});

describe('GET /api/graphs/:siteVersion/states', () => {
  it('lists the nodes of one graph directly (no session involved)', () => {
    const res = get(core, `/api/graphs/${SV}/states`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(n => n.hash).sort(), ['n1', 'n2']);
  });

  it('404s for an unknown siteVersion', () => {
    const res = get(core, '/api/graphs/__no_such_graph__/states');
    assert.strictEqual(res.status, 404);
  });

  it('returns a single node by hash', () => {
    const res = get(core, `/api/graphs/${SV}/states/n2`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.url, 'https://app.test/about');
  });
});

describe('GET /api/sessions/:tabId/states — siteVersion drift fallback', () => {
  it('falls back to all graphs when the session siteVersion has no graph', () => {
    // session says 'default', graph is keyed SV — must NOT answer []
    const res = get(core, `/api/sessions/${TAB}/states`);
    assert.strictEqual(res.status, 200);
    const hashes = res.body.map(n => n.hash);
    assert.ok(hashes.includes('n1') && hashes.includes('n2'),
      'session route must not return [] while /api/graphs shows nodes');
  });

  it('state detail also finds the node across graphs', () => {
    const res = get(core, `/api/sessions/${TAB}/states/n1`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hash, 'n1');
  });

  it('still 404s for a hash that exists nowhere', () => {
    const res = get(core, `/api/sessions/${TAB}/states/__ghost__`);
    assert.strictEqual(res.status, 404);
  });

  it('still 404s for an unknown session', () => {
    const res = get(core, '/api/sessions/999999/states');
    assert.strictEqual(res.status, 404);
  });
});

describe('GET /api/sessions/:tabId/map — ASCII state-graph visualization', () => {
  it('renders the graph directly when the session siteVersion has nodes (no drift)', () => {
    const res = get(core, `/api/sessions/${TAB_OWN}/map`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.siteVersion, SV);
    assert.match(res.body.graph, /State Graph Topology/);
    assert.match(res.body.graph, /Home/);
  });

  it('?maxNodes truncates the rendered tree', () => {
    const res = getQ(core, `/api/sessions/${TAB_OWN}/map?maxNodes=1`);
    assert.strictEqual(res.status, 200);
    assert.match(res.body.graph, /truncated at 1 nodes/);
  });

  it('falls back to a populated graph when the session siteVersion has none (drift)', () => {
    // session says 'default' (no nodes of its own) — must not answer
    // "No state graph found" while another graph (e.g. SV) has nodes.
    const res = get(core, `/api/sessions/${TAB}/map`);
    assert.strictEqual(res.status, 200);
    assert.notStrictEqual(res.body.siteVersion, 'default');
    assert.match(res.body.graph, /State Graph Topology/);
  });

  it('404s for an unknown session', () => {
    const res = get(core, '/api/sessions/999999/map');
    assert.strictEqual(res.status, 404);
  });
});
