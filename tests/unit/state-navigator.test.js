/**
 * tests/unit/state-navigator.test.js
 * Section 7.2 — State Navigator
 *
 * Tests BFS path finding over state graphs and the navigation execution layer.
 * Pure logic — no server, no DOM required.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline StateNavigator implementation ──────────────────────────────────────
// Replace with: import { StateNavigator } from '../../src/state-navigator.js';
//
// This mirrors the contract the real module must fulfil.

class StateNavigator {
  /**
   * @param {Map<string, { edges: Array<{ to: string, action: object }> }>} graph
   */
  constructor(graph) {
    this._graph = graph;
  }

  /**
   * BFS shortest path from `from` to `to`.
   * @returns {Array<{ from: string, to: string, action: object }> | null}
   */
  findPath(from, to) {
    if (from === to) return [];
    if (!this._graph.has(from)) return null;

    const visited = new Set([from]);
    const queue   = [{ hash: from, path: [] }];

    while (queue.length > 0) {
      const { hash, path } = queue.shift();
      const node = this._graph.get(hash);
      if (!node) continue;

      for (const edge of (node.edges ?? [])) {
        if (visited.has(edge.to)) continue;
        const newPath = [...path, { from: hash, to: edge.to, action: edge.action }];
        if (edge.to === to) return newPath;
        visited.add(edge.to);
        queue.push({ hash: edge.to, path: newPath });
      }
    }
    return null;
  }

  /**
   * Execute navigation: replay actions and verify hashes.
   * @param {string} from
   * @param {string} to
   * @param {{ executeAction: Function, verifyHash: Function }} executor
   * @returns {Promise<{ ok: boolean, error?: string, stepsCompleted: number }>}
   */
  async navigate(from, to, { executeAction, verifyHash }) {
    const path = this.findPath(from, to);
    if (!path) return { ok: false, error: 'No path found', stepsCompleted: 0 };
    if (path.length === 0) return { ok: true, stepsCompleted: 0 };

    let stepsCompleted = 0;
    for (const step of path) {
      try {
        await executeAction(step.action);
        stepsCompleted++;
        const ok = await verifyHash(step.to);
        if (!ok) return { ok: false, error: `Hash mismatch at ${step.to}`, stepsCompleted };
      } catch (err) {
        return { ok: false, error: err.message, stepsCompleted };
      }
    }
    return { ok: true, stepsCompleted };
  }

  /** Dry-run: return path without executing. */
  getNavigationPath(from, to) {
    return this.findPath(from, to);
  }
}

// ── Graph fixtures ─────────────────────────────────────────────────────────────

function linearGraph() {
  // A → B → C → D
  return new Map([
    ['A', { edges: [{ to: 'B', action: { type: 'click', selector: '#next' } }] }],
    ['B', { edges: [{ to: 'C', action: { type: 'click', selector: '#next' } }] }],
    ['C', { edges: [{ to: 'D', action: { type: 'click', selector: '#finish' } }] }],
    ['D', { edges: [] }],
  ]);
}

function branchedGraph() {
  // A → B → D (short)
  // A → C → D (long)
  return new Map([
    ['A', { edges: [
      { to: 'B', action: { type: 'click', selector: '#btn-b' } },
      { to: 'C', action: { type: 'click', selector: '#btn-c' } },
    ]}],
    ['B', { edges: [{ to: 'D', action: { type: 'click', selector: '#done' } }] }],
    ['C', { edges: [{ to: 'D', action: { type: 'click', selector: '#done-slow' } }] }],
    ['D', { edges: [] }],
  ]);
}

function cyclicGraph() {
  // A ↔ B, B → C
  return new Map([
    ['A', { edges: [{ to: 'B', action: { type: 'click' } }] }],
    ['B', { edges: [
      { to: 'A', action: { type: 'click' } },
      { to: 'C', action: { type: 'click' } },
    ]}],
    ['C', { edges: [] }],
  ]);
}

// ══════════════════════════════════════════════════════════════════════════════
describe('7.2 State Navigator', () => {

  // ── BFS findPath ────────────────────────────────────────────────────────────

  describe('findPath (BFS)', () => {
    test('linear graph A→D returns 3-step path', () => {
      const nav  = new StateNavigator(linearGraph());
      const path = nav.findPath('A', 'D');

      assert.ok(path !== null, 'path must be found');
      assert.strictEqual(path.length, 3, 'A→B→C→D = 3 steps');
      assert.strictEqual(path[0].from, 'A');
      assert.strictEqual(path[0].to,   'B');
      assert.strictEqual(path[2].to,   'D');
    });

    test('same start and destination → empty path (not null)', () => {
      const nav  = new StateNavigator(linearGraph());
      const path = nav.findPath('B', 'B');
      assert.deepStrictEqual(path, []);
    });

    test('no path available → returns null', () => {
      const nav  = new StateNavigator(linearGraph());
      const path = nav.findPath('D', 'A'); // D has no edges
      assert.strictEqual(path, null);
    });

    test('branched graph picks shortest path (A→B→D over A→C→D)', () => {
      const nav  = new StateNavigator(branchedGraph());
      const path = nav.findPath('A', 'D');

      assert.ok(path !== null);
      assert.strictEqual(path.length, 2, 'shortest path A→B→D has 2 steps');
      assert.strictEqual(path[0].to, 'B', 'BFS picks the shorter route via B');
    });

    test('cyclic graph does not loop infinitely', () => {
      const nav  = new StateNavigator(cyclicGraph());
      // Should complete without hanging
      const path = nav.findPath('A', 'C');
      assert.ok(path !== null);
      assert.strictEqual(path[0].to, 'B');
      assert.strictEqual(path[1].to, 'C');
    });

    test('start node not in graph → returns null', () => {
      const nav  = new StateNavigator(linearGraph());
      const path = nav.findPath('Z', 'A');
      assert.strictEqual(path, null);
    });

    test('destination node not reachable → returns null', () => {
      const nav  = new StateNavigator(linearGraph());
      const path = nav.findPath('A', 'ORPHAN');
      assert.strictEqual(path, null);
    });

    test('each step has { from, to, action } shape', () => {
      const nav  = new StateNavigator(linearGraph());
      const path = nav.findPath('A', 'C');
      for (const step of path) {
        assert.ok('from'   in step, 'step must have from');
        assert.ok('to'     in step, 'step must have to');
        assert.ok('action' in step, 'step must have action');
      }
    });
  });

  // ── navigate ────────────────────────────────────────────────────────────────

  describe('navigate (execution)', () => {
    test('valid path → executes actions in order and returns ok:true', async () => {
      const nav = new StateNavigator(linearGraph());

      const executed = [];
      const executeAction = async action => { executed.push(action); };
      const verifyHash    = async hash   => true;

      const result = await nav.navigate('A', 'C', { executeAction, verifyHash });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.stepsCompleted, 2);
      assert.strictEqual(executed.length, 2);
      assert.strictEqual(executed[0].selector, '#next');
    });

    test('hash mismatch after step → returns ok:false with error', async () => {
      const nav = new StateNavigator(linearGraph());

      const result = await nav.navigate('A', 'D', {
        executeAction: async () => {},
        verifyHash:    async hash => hash !== 'B', // B fails verification
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('mismatch') || result.error.includes('Hash'),
        'error must mention hash mismatch');
      assert.strictEqual(result.stepsCompleted, 1, 'stopped after first mismatch');
    });

    test('no path → returns ok:false with "No path found"', async () => {
      const nav = new StateNavigator(linearGraph());

      const result = await nav.navigate('D', 'A', {
        executeAction: async () => {},
        verifyHash:    async ()  => true,
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('No path'));
    });

    test('same from/to → ok:true, 0 steps, no action executed', async () => {
      const nav = new StateNavigator(linearGraph());
      let actionCalled = false;

      const result = await nav.navigate('B', 'B', {
        executeAction: async () => { actionCalled = true; },
        verifyHash:    async ()  => true,
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.stepsCompleted, 0);
      assert.strictEqual(actionCalled, false);
    });

    test('action throws → returns ok:false with error, partial stepsCompleted', async () => {
      const nav = new StateNavigator(linearGraph());

      let calls = 0;
      const result = await nav.navigate('A', 'D', {
        executeAction: async () => {
          calls++;
          if (calls === 2) throw new Error('Action timeout');
        },
        verifyHash: async () => true,
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('Action timeout'));
      assert.strictEqual(result.stepsCompleted, 1, 'first step completed before failure');
    });
  });

  // ── getNavigationPath (dry run) ──────────────────────────────────────────────

  describe('getNavigationPath (dry run)', () => {
    test('returns path without executing anything', () => {
      const nav = new StateNavigator(linearGraph());
      let executed = false;

      const path = nav.getNavigationPath('A', 'D');

      assert.ok(path !== null);
      assert.strictEqual(path.length, 3);
      assert.strictEqual(executed, false, 'dry run must not execute actions');
    });

    test('returns null for unreachable destination', () => {
      const nav  = new StateNavigator(linearGraph());
      const path = nav.getNavigationPath('D', 'A');
      assert.strictEqual(path, null);
    });
  });
});
