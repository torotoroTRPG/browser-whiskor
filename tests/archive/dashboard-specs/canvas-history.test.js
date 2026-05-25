/**
 * tests/unit/canvas-history.test.js
 * Section 2.5 — Undo/Redo
 *
 * Tests action history: push, undo, redo, limits, and
 * "new action after undo clears future" behavior.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDOM } from '../helpers/dom-mock.js';

// ── Inline ActionHistory implementation ──────────────────────────────────────
// Replace with: import { ActionHistory } from '../../dashboard/canvas-history.js';

const MAX_HISTORY = 50;

class ActionHistory {
  constructor(opts = {}) {
    this._history    = [];
    this._future     = [];
    this._maxSize    = opts.maxSize ?? MAX_HISTORY;
    this._onExecute  = opts.onExecute ?? (() => {});
  }

  /** Push an action onto history (clears future). */
  push(action) {
    this._history.push(action);
    this._future = [];  // new action invalidates redo stack
    if (this._history.length > this._maxSize) {
      this._history.shift(); // evict oldest
    }
  }

  /** Undo last action — removes from history, adds to future. Returns action or null. */
  undo() {
    if (this._history.length === 0) return null;
    const action = this._history.pop();
    this._future.push(action);
    return action;
  }

  /** Redo last undone action — re-executes it and moves back to history. */
  redo() {
    if (this._future.length === 0) return null;
    const action = this._future.pop();
    this._history.push(action);
    this._onExecute(action);
    return action;
  }

  get historyLength() { return this._history.length; }
  get futureLength()  { return this._future.length; }
  get canUndo()       { return this._history.length > 0; }
  get canRedo()       { return this._future.length > 0; }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('2.5 Undo/Redo', () => {

  let history;
  let executed;

  beforeEach(() => {
    resetDOM();
    executed = [];
    history  = new ActionHistory({ onExecute: a => executed.push(a) });
  });

  const click = (n = 0) => ({ type: 'click', x: n * 10, y: n * 10 });

  // ── Push ─────────────────────────────────────────────────────────────────────

  describe('push', () => {
    test('push adds action to history', () => {
      history.push(click(1));
      assert.strictEqual(history.historyLength, 1);
    });

    test('push clears future (redo stack)', () => {
      history.push(click(1));
      history.undo();
      assert.strictEqual(history.futureLength, 1, 'future has one item after undo');

      history.push(click(2)); // new action must clear future
      assert.strictEqual(history.futureLength, 0, 'future must be empty after new push');
    });

    test('push beyond max (50) evicts oldest entry', () => {
      for (let i = 0; i < 55; i++) history.push(click(i));
      assert.strictEqual(history.historyLength, MAX_HISTORY, `history must be capped at ${MAX_HISTORY}`);
      // The first 5 entries should be gone; last entry should be click(54)
      const last = history._history[history._history.length - 1];
      assert.strictEqual(last.x, 54 * 10, 'most recent entry must be preserved');
    });

    test('history length matches push count (under limit)', () => {
      for (let i = 0; i < 10; i++) history.push(click(i));
      assert.strictEqual(history.historyLength, 10);
    });
  });

  // ── Undo ─────────────────────────────────────────────────────────────────────

  describe('undo', () => {
    test('undo removes last action from history', () => {
      history.push(click(1));
      history.push(click(2));
      history.undo();
      assert.strictEqual(history.historyLength, 1);
    });

    test('undo moves action to future', () => {
      history.push(click(1));
      const undone = history.undo();
      assert.strictEqual(history.futureLength, 1);
      assert.deepStrictEqual(undone, click(1));
    });

    test('undo on empty history returns null (no crash)', () => {
      const result = history.undo();
      assert.strictEqual(result, null, 'undo on empty history must return null');
      assert.strictEqual(history.historyLength, 0);
    });

    test('canUndo is false when history is empty', () => {
      assert.strictEqual(history.canUndo, false);
    });

    test('canUndo is true after push', () => {
      history.push(click());
      assert.strictEqual(history.canUndo, true);
    });

    test('Ctrl+Z behavior: undo returns most recently pushed action', () => {
      history.push(click(1));
      history.push(click(2));
      history.push(click(3));
      const undone = history.undo();
      assert.deepStrictEqual(undone, click(3), 'must undo last (LIFO)');
    });
  });

  // ── Redo ─────────────────────────────────────────────────────────────────────

  describe('redo', () => {
    test('redo re-executes last undone action', () => {
      history.push(click(1));
      history.undo();
      history.redo();
      assert.deepStrictEqual(executed[0], click(1), 'onExecute must be called with the re-done action');
    });

    test('redo moves action from future back to history', () => {
      history.push(click(1));
      history.undo();
      assert.strictEqual(history.futureLength, 1);
      history.redo();
      assert.strictEqual(history.futureLength, 0, 'future must be empty after redo');
      assert.strictEqual(history.historyLength, 1, 'history must contain the re-done action');
    });

    test('redo on empty future returns null (no crash)', () => {
      const result = history.redo();
      assert.strictEqual(result, null);
    });

    test('canRedo is false when future is empty', () => {
      assert.strictEqual(history.canRedo, false);
    });

    test('canRedo is true after undo', () => {
      history.push(click());
      history.undo();
      assert.strictEqual(history.canRedo, true);
    });

    test('Ctrl+Shift+Z: redo restores most recently undone action', () => {
      history.push(click(1));
      history.push(click(2));
      history.undo(); // undo click(2)
      history.undo(); // undo click(1)

      history.redo(); // redo click(1)
      history.redo(); // redo click(2)

      assert.strictEqual(executed.length, 2);
      assert.deepStrictEqual(executed[0], click(1));
      assert.deepStrictEqual(executed[1], click(2));
    });
  });

  // ── New action after undo ─────────────────────────────────────────────────────

  describe('new action after undo', () => {
    test('pushing after undo clears redo stack (standard undo behavior)', () => {
      history.push(click(1));
      history.push(click(2));
      history.undo();
      assert.strictEqual(history.canRedo, true);

      history.push(click(3)); // branch from undo position
      assert.strictEqual(history.canRedo, false, 'redo must be unavailable after new action');
      assert.strictEqual(history.futureLength, 0);
    });

    test('after branch, history ends with the new action', () => {
      history.push(click(1));
      history.undo();
      history.push(click(2)); // new branch
      const undone = history.undo();
      assert.deepStrictEqual(undone, click(2), 'new action is the most recent');
    });
  });
});
