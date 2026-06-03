/**
 * tests/unit/state-navigator.test.js
 * Section 7.2 — State Navigator
 *
 * Exercises the REAL server/state-navigator.js (the previous version was an
 * unwired stub pointing at a non-existent ../../src/state-navigator.js):
 *   - findPath(): pure BFS shortest-path over a graph literal.
 *   - getNavigationPath(): integration over a real (throwaway) state-store graph.
 *   - requestHash()/handleHashReport(): the request<->report correlation.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const nav = require('../../server/state-navigator');
const store = require('../../server/state-store');

const SV = '__unit_state_nav__';
const GRAPH_FILE = path.join(
  fileURLToPath(new URL('../../cache/graphs/', import.meta.url)),
  `${SV}.json.gz`,
);
after(() => { try { fs.rmSync(GRAPH_FILE, { force: true }); } catch (_) {} });

describe('7.2 findPath — BFS', () => {
  const graph = {
    edges: {
      A: { 'click:one': { to: 'B', confidence: 0.9, action: 'click', trigger: 'one' } },
      B: { 'click:two': { to: 'C', confidence: 0.9, action: 'click', trigger: 'two' } },
    },
  };

  it('returns an empty path when already at the target', () => {
    assert.deepStrictEqual(nav.findPath(graph, 'A', 'A'), []);
  });

  it('finds a one-hop path', () => {
    const p = nav.findPath(graph, 'A', 'B');
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].to, 'B');
  });

  it('finds a two-hop path across intermediate nodes', () => {
    const p = nav.findPath(graph, 'A', 'C');
    assert.strictEqual(p.length, 2);
    assert.strictEqual(p[1].to, 'C');
  });

  it('returns null when the target is unreachable', () => {
    assert.strictEqual(nav.findPath(graph, 'A', 'Z'), null);
  });

  it('prefers the shorter route when both exist', () => {
    const g = {
      edges: {
        A: {
          'click:long': { to: 'B', confidence: 0.9, action: 'click', trigger: 'long' },
          'click:short': { to: 'C', confidence: 0.9, action: 'click', trigger: 'short' },
        },
        B: { 'click:b2c': { to: 'C', confidence: 0.9, action: 'click', trigger: 'b2c' } },
      },
    };
    assert.strictEqual(nav.findPath(g, 'A', 'C').length, 1, 'direct A->C should win over A->B->C');
  });

  it('ignores edges below the confidence floor', () => {
    const g = { edges: { A: { 'click:weak': { to: 'B', confidence: 0.1, action: 'click', trigger: 'weak' } } } };
    assert.strictEqual(nav.findPath(g, 'A', 'B'), null, 'a 0.1-confidence edge is below the 0.3 floor');
  });
});

describe('7.2 getNavigationPath — over a real graph', () => {
  it('reports a reachable multi-step path with aggregated confidence', () => {
    store.addEdge(SV, { from: 'n1', to: 'n2', action: 'click', trigger: 'Next' });
    store.addEdge(SV, { from: 'n2', to: 'n3', action: 'click', trigger: 'Finish' });

    const res = nav.getNavigationPath('n1', 'n3', SV);
    assert.strictEqual(res.reachable, true);
    assert.strictEqual(res.steps, 2);
    assert.strictEqual(res.path[0].fromHash, 'n1');
    assert.strictEqual(res.path[res.path.length - 1].toHash, 'n3');
    assert.ok(res.confidence > 0 && res.confidence <= 1);
  });

  it('reports unreachable when no path exists', () => {
    const res = nav.getNavigationPath('n1', 'no-such-state', SV);
    assert.strictEqual(res.reachable, false);
    assert.ok(res.error);
  });
});

describe('7.2 requestHash / handleHashReport', () => {
  it('resolves with the payload reported for the matching requestId', async () => {
    let sent = null;
    const broadcast = (msg) => { sent = msg; };

    const p = nav.requestHash(7, broadcast, 1000);
    assert.strictEqual(sent.type, 'REQUEST_STATE_HASH');
    assert.strictEqual(sent.tabId, 7);

    nav.handleHashReport({ requestId: sent.requestId, payload: { compositeHash: 'abc123' } });
    const payload = await p;
    assert.strictEqual(payload.compositeHash, 'abc123');
  });

  it('rejects on timeout when no report arrives', async () => {
    await assert.rejects(
      nav.requestHash(8, () => {}, 60),
      /timeout/i,
    );
  });
});
