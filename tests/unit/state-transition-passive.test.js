/**
 * tests/unit/state-transition-passive.test.js
 *
 * S0 — passive node recording (docs/ideas/REVERSE_EDGE_NAVIGATION.md).
 *
 * Exercises the REAL server pieces of the passive state-graph writer:
 *   - core.js STATE_TRANSITION → addNode (composite keyspace) + addEdge with
 *     evidence-based action attribution (click interaction / navigate / observed)
 *   - core.js REACT_TRANSITION no longer writes graph edges (react-keyspace
 *     orphans were the nodeCount:0 bug)
 *   - state-store addEdge `replayable` flag; state-navigator findPath skips
 *     observation-only edges
 *   - state-store sweepEmptyGraphs drops node-less edge skeletons
 * Plus wiring pins: the injected producer (state-reporter.js) actually emits
 * STATE_TRANSITION with the consumed payload shape, exposes the shared hash
 * engine, explorer.js delegates to it, and both manifests load state-reporter
 * before explorer.
 */

import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { WhiskorCore } = require('../../server/core');
const store = require('../../server/state-store');
const navigator = require('../../server/state-navigator');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function fakeWs() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, on() {} };
}

/** stateMachine mock recording writes, with a store lookup for from-node urls. */
function mockStateMachine(knownNodes = {}) {
  const calls = { nodes: [], edges: [] };
  return {
    calls,
    addNode(sv, data) { calls.nodes.push({ sv, data }); return { hash: data.hash }; },
    addEdge(sv, data) { calls.edges.push({ sv, data }); return data; },
    getUnvisitedActions() { return []; },
    getAllGraphs() { return []; },
    store: { getNodeByHash: (sv, hash) => knownNodes[hash] || null },
  };
}

// ── core.js STATE_TRANSITION handler ─────────────────────────────────────────

describe('STATE_TRANSITION passive graph writer', () => {
  let core, sm, ws;

  function init(knownNodes) {
    sm = mockStateMachine(knownNodes);
    core = new WhiskorCore({ stateMachine: sm });
    core._cleanupTimer && clearInterval(core._cleanupTimer);
    ws = fakeWs();
    core.handleSWConnect(ws, {});
  }

  beforeEach(() => init());

  test('initial report (from:null) records the node, no edge', async () => {
    await core.routeMessage({
      type: 'STATE_TRANSITION', tabId: 1, siteVersion: 'sv1',
      tabUrl: 'https://app.example/home',
      payload: { from: null, to: 'aaa1111', domHash: 'aaa1111', url: 'https://app.example/home', title: 'Home' },
    }, ws);

    assert.strictEqual(sm.calls.nodes.length, 1);
    assert.strictEqual(sm.calls.nodes[0].sv, 'sv1');
    assert.strictEqual(sm.calls.nodes[0].data.hash, 'aaa1111');
    assert.strictEqual(sm.calls.nodes[0].data.url, 'https://app.example/home');
    assert.strictEqual(sm.calls.nodes[0].data.title, 'Home');
    assert.strictEqual(sm.calls.nodes[0].data.origin, 'https://app.example');
    assert.strictEqual(sm.calls.edges.length, 0);
  });

  test('a recent click interaction becomes a replayable click edge', async () => {
    await core.routeMessage({
      type: 'STATE_TRANSITION', tabId: 1, siteVersion: 'sv1',
      tabUrl: 'https://app.example/home',
      payload: {
        from: 'aaa1111', to: 'bbb2222', url: 'https://app.example/home', title: 'Home',
        interaction: { type: 'click', text: '設定', id: '', ts: Date.now() },
      },
    }, ws);

    assert.strictEqual(sm.calls.edges.length, 1);
    const e = sm.calls.edges[0].data;
    assert.strictEqual(e.action, 'click');
    assert.strictEqual(e.trigger, '設定');
    assert.strictEqual(e.replayable, true);
    assert.deepStrictEqual(e.replayAction, { type: 'click', text: '設定' });
    assert.strictEqual(e.origin, 'https://app.example');
  });

  test('a URL change without interaction becomes a replayable navigate edge', async () => {
    init({ aaa1111: { hash: 'aaa1111', url: 'https://app.example/home' } });
    await core.routeMessage({
      type: 'STATE_TRANSITION', tabId: 1, siteVersion: 'sv1',
      tabUrl: 'https://app.example/settings',
      payload: { from: 'aaa1111', to: 'ccc3333', url: 'https://app.example/settings', title: 'Settings' },
    }, ws);

    const e = sm.calls.edges[0].data;
    assert.strictEqual(e.action, 'navigate');
    assert.strictEqual(e.replayable, true);
    assert.deepStrictEqual(e.replayAction, { type: 'navigate', url: 'https://app.example/settings' });
  });

  test('no interaction + same URL → observation-only edge (replayable:false)', async () => {
    init({ aaa1111: { hash: 'aaa1111', url: 'https://app.example/home' } });
    await core.routeMessage({
      type: 'STATE_TRANSITION', tabId: 1, siteVersion: 'sv1',
      tabUrl: 'https://app.example/home',
      payload: { from: 'aaa1111', to: 'ddd4444', url: 'https://app.example/home', title: 'Home' },
    }, ws);

    const e = sm.calls.edges[0].data;
    assert.strictEqual(e.action, 'observed');
    assert.strictEqual(e.replayable, false);
    assert.strictEqual(e.replayAction, null);
  });

  test('payload url from a foreign origin is clamped to the bridge tabUrl', async () => {
    await core.routeMessage({
      type: 'STATE_TRANSITION', tabId: 1, siteVersion: 'sv1',
      tabUrl: 'https://app.example/home',
      payload: { from: null, to: 'eee5555', url: 'https://evil.example/phish', title: 'x' },
    }, ws);

    assert.strictEqual(sm.calls.nodes[0].data.url, 'https://app.example/home');
  });

  test('malformed reports write nothing (missing siteVersion / bad to-hash)', async () => {
    await core.routeMessage({
      type: 'STATE_TRANSITION', tabId: 1,
      tabUrl: 'https://app.example/home',
      payload: { from: null, to: 'aaa1111' },
    }, ws);
    await core.routeMessage({
      type: 'STATE_TRANSITION', tabId: 1, siteVersion: 'sv1',
      tabUrl: 'https://app.example/home',
      payload: { from: null, to: 'x'.repeat(200) },
    }, ws);
    await core.routeMessage({
      type: 'STATE_TRANSITION', tabId: 1, siteVersion: 'sv1',
      tabUrl: 'https://app.example/home',
      payload: { from: null, to: 42 },
    }, ws);

    assert.strictEqual(sm.calls.nodes.length, 0);
    assert.strictEqual(sm.calls.edges.length, 0);
  });

  test('self-transition (from === to) records the node but no edge', async () => {
    await core.routeMessage({
      type: 'STATE_TRANSITION', tabId: 1, siteVersion: 'sv1',
      tabUrl: 'https://app.example/home',
      payload: { from: 'fff6666', to: 'fff6666', url: 'https://app.example/home' },
    }, ws);
    assert.strictEqual(sm.calls.nodes.length, 1);
    assert.strictEqual(sm.calls.edges.length, 0);
  });

  test('REACT_TRANSITION no longer writes graph edges', async () => {
    await core.routeMessage({
      type: 'REACT_TRANSITION', tabId: 1, siteVersion: 'sv1',
      tabUrl: 'https://app.example/home',
      payload: { from: 'r-aaa', to: 'r-bbb', trigger: 'click' },
    }, ws);

    assert.strictEqual(sm.calls.edges.length, 0, 'react-keyspace edges are permanent orphans — must not be written');
    assert.strictEqual(sm.calls.nodes.length, 0);
  });
});

// ── state-store replayable flag + findPath ───────────────────────────────────

const SV = '__unit_passive_transition__';
const GRAPH_DIR = process.env.WHISKOR_GRAPH_DIR || path.join(ROOT, 'cache', 'graphs');

after(() => {
  for (const f of [`${SV}.json.gz`, `${SV}_swept.json.gz`, `${SV}_kept.json.gz`]) {
    try { fs.rmSync(path.join(GRAPH_DIR, f), { force: true }); } catch (_) {}
  }
});

describe('replayable flag in the real store + navigator', () => {
  test('addEdge defaults replayable to true; explicit false is stored', () => {
    const e1 = store.addEdge(SV, { from: 'n1', to: 'n2', action: 'click', trigger: 'Next' });
    assert.strictEqual(e1.replayable, true);
    const e2 = store.addEdge(SV, { from: 'n1', to: 'n3', action: 'observed', trigger: null, replayable: false });
    assert.strictEqual(e2.replayable, false);
  });

  test('findPath ignores observation-only edges, uses replayable ones', () => {
    const graph = {
      nodes: { a: {}, b: {} },
      edges: {
        a: {
          'observed:?': { from: 'a', to: 'b', action: 'observed', confidence: 0.9, replayable: false },
        },
      },
    };
    assert.strictEqual(navigator.findPath(graph, 'a', 'b'), null, 'only edge is non-replayable → no path');

    graph.edges.a['click:Next'] = { from: 'a', to: 'b', action: 'click', trigger: 'Next', confidence: 0.9 };
    const p = navigator.findPath(graph, 'a', 'b');
    assert.ok(p && p.length === 1 && p[0].action === 'click', 'legacy edge without the flag stays usable');
  });
});

describe('sweepEmptyGraphs', () => {
  test('drops node-less edge skeletons, keeps graphs with nodes', () => {
    // Node-less skeleton: only an edge write ever hit this graph.
    store.addEdge(`${SV}_swept`, { from: 'r-x', to: 'r-y', action: 'react-update' });
    // Healthy graph: has a node.
    store.addNode(`${SV}_kept`, { hash: 'n1', url: 'https://app.example/a' });

    assert.ok(fs.existsSync(path.join(GRAPH_DIR, `${SV}_swept.json.gz`)), 'precondition: skeleton persisted');

    store.sweepEmptyGraphs();

    assert.ok(!fs.existsSync(path.join(GRAPH_DIR, `${SV}_swept.json.gz`)), 'skeleton must be swept');
    assert.ok(fs.existsSync(path.join(GRAPH_DIR, `${SV}_kept.json.gz`)), 'graph with nodes must survive');
    assert.ok(store.getNodeByHash(`${SV}_kept`, 'n1'), 'surviving graph still readable');
  });
});

// ── Wiring pins (static) ─────────────────────────────────────────────────────

describe('S0 wiring pins', () => {
  const REPORTERS = ['extension/injected/state-reporter.js', 'firefox-mv2/injected/state-reporter.js', 'shared/injected/state-reporter.js'];
  const EXPLORERS = ['extension/injected/explorer.js', 'firefox-mv2/injected/explorer.js', 'shared/injected/explorer.js'];
  const MANIFESTS = ['extension/manifest.json', 'firefox-mv2/manifest.json'];

  test('state-reporter emits STATE_TRANSITION with the consumed field names', () => {
    for (const rel of REPORTERS) {
      const src = read(rel);
      assert.match(src, /type: 'STATE_TRANSITION'/, `${rel}: producer missing`);
      for (const field of ['from:', 'to:', 'url:', 'title:', 'interaction:', 'siteVersion:']) {
        assert.ok(src.includes(field), `${rel}: STATE_TRANSITION payload lost field ${field}`);
      }
      assert.match(src, /__SI_HASH_ENGINE__/, `${rel}: always-on hash engine missing`);
      assert.match(src, /__SI_CURRENT_HASH__/, `${rel}: must maintain the global executor/observe reads`);
    }
  });

  test('explorer delegates hashing to the shared engine (no forked fnv32)', () => {
    for (const rel of EXPLORERS) {
      const src = read(rel);
      assert.match(src, /__SI_HASH_ENGINE__/, `${rel}: must delegate to the shared engine`);
      assert.ok(!/function fnv32/.test(src), `${rel}: local fnv32 copy re-forked the node identity`);
    }
  });

  test('manifests inject state-reporter before explorer (engine exists at first use)', () => {
    for (const rel of MANIFESTS) {
      const src = read(rel);
      const reporter = src.indexOf('injected/state-reporter.js');
      const explorer = src.indexOf('injected/explorer.js');
      assert.ok(reporter >= 0 && explorer >= 0, `${rel}: scripts missing`);
      assert.ok(reporter < explorer, `${rel}: state-reporter must load before explorer`);
    }
  });

  test('core.js consumes STATE_TRANSITION and REACT_TRANSITION writes no edges', () => {
    const src = read('server/core.js');
    assert.match(src, /case 'STATE_TRANSITION':/);
    const reactCase = src.slice(src.indexOf("case 'REACT_TRANSITION':"), src.indexOf("case 'STATE_TRANSITION':"));
    assert.ok(!reactCase.includes('addEdge'), 'REACT_TRANSITION must not write graph edges');
    assert.ok(reactCase.includes('correlator'), 'REACT_TRANSITION must keep feeding the correlator');
  });

  test('index.js sweeps node-less graphs at startup', () => {
    assert.match(read('server/index.js'), /sweepEmptyGraphs\(\)/);
  });
});
