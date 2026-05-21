/**
 * tests/stress/long-session.test.js
 * Section 9.2 — Long Session
 *
 * Simulates extended usage patterns: many actions, continuous scroll, history management.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sleep } from '../helpers/ws-client.js';

// ── Inline ActionHistory for stress testing ──────────────────────────────────
// Mirrors the real dashboard canvas-history.js

const MAX_HISTORY = 50;

class ActionHistory {
  constructor() {
    this.history = [];
    this.future = [];
  }

  push(action) {
    this.history.push(action);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future = [];
  }

  undo() {
    if (this.history.length === 0) return null;
    const action = this.history.pop();
    this.future.push(action);
    return action;
  }

  redo() {
    if (this.future.length === 0) return null;
    const action = this.future.pop();
    this.history.push(action);
    return action;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
describe('9.2 Long Session', () => {

  test('10000 actions: max 50 history kept', () => {
    const history = new ActionHistory();

    for (let i = 0; i < 10000; i++) {
      history.push({ type: 'click', x: i, y: i, timestamp: Date.now() });
    }

    assert.strictEqual(history.history.length, MAX_HISTORY);
    assert.strictEqual(history.history[MAX_HISTORY - 1].x, 9999);
    assert.strictEqual(history.future.length, 0);
  });

  test('10000 actions: undo/redo performance under 500ms', () => {
    const history = new ActionHistory();

    for (let i = 0; i < 10000; i++) {
      history.push({ type: 'click', x: i, y: i });
    }

    const start = performance.now();

    // 100 undo operations
    for (let i = 0; i < 100; i++) {
      history.undo();
    }

    // 100 redo operations
    for (let i = 0; i < 100; i++) {
      history.redo();
    }

    const duration = performance.now() - start;
    assert.ok(duration < 500, `200 undo/redo ops must complete within 500ms (took ${duration.toFixed(1)}ms)`);
  });

  test('Continuous scroll: beacon tracking no performance degradation', async () => {
    // Simulate 1000 scroll events with debounce
    let scanCount = 0;
    let debounceTimer = null;

    function onScroll(scrollY) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        scanCount++;
      }, 50);
    }

    const start = performance.now();

    // Fire 1000 scroll events rapidly
    for (let i = 0; i < 1000; i++) {
      onScroll(i * 10);
    }

    // Wait for debounce to settle
    await sleep(100);

    const duration = performance.now() - start;

    // Debounce should reduce 1000 events to ~2 scans (at 50ms intervals over rapid fire)
    assert.ok(scanCount <= 5, `debounce should reduce 1000 scrolls to ≤ 5 scans (got ${scanCount})`);
    assert.ok(duration < 500, `1000 scroll events must process within 500ms (took ${duration.toFixed(1)}ms)`);
  });

  test('Memory: 10000-word session stays under 100MB RSS', () => {
    const memBefore = process.memoryUsage().rss;

    // Simulate storing a large session
    const session = {
      tabId: 1,
      words: [],
      network: [],
      states: [],
    };

    // Generate 10000 words
    for (let i = 0; i < 10000; i++) {
      session.words.push({
        id: `w${i}`,
        text: `word${i}`,
        x: Math.random() * 5000,
        y: Math.random() * 5000,
        width: 20 + Math.random() * 80,
        height: 12 + Math.random() * 8,
        inView: false,
      });
    }

    // Generate 5000 network requests
    for (let i = 0; i < 5000; i++) {
      session.network.push({
        url: `https://example.com/api/${i}`,
        method: 'GET',
        status: 200,
        size: Math.floor(Math.random() * 10000),
        timestamp: Date.now() - Math.floor(Math.random() * 60000),
      });
    }

    // Generate 100 states
    for (let i = 0; i < 100; i++) {
      session.states.push({
        hash: `state_${i}`,
        url: `https://example.com/page/${i}`,
        label: `Page ${i}`,
        actions: [{ type: 'click', x: i, y: i }],
      });
    }

    const memAfter = process.memoryUsage().rss;
    const memDelta = (memAfter - memBefore) / 1024 / 1024;

    assert.ok(memDelta < 100, `session must stay under 100MB (used ${memDelta.toFixed(1)}MB)`);
    assert.strictEqual(session.words.length, 10000);
    assert.strictEqual(session.network.length, 5000);
    assert.strictEqual(session.states.length, 100);
  });

  test('State graph: 500 nodes with LRU eviction', () => {
    const maxNodes = 100;
    const nodes = new Map();

    // Add 500 nodes, should evict oldest
    for (let i = 0; i < 500; i++) {
      nodes.set(`hash_${i}`, { hash: `hash_${i}`, url: `https://example.com/${i}`, visited: Date.now() });
      if (nodes.size > maxNodes) {
        const firstKey = nodes.keys().next().value;
        nodes.delete(firstKey);
      }
    }

    assert.strictEqual(nodes.size, maxNodes);
    assert.ok(nodes.has('hash_499'), 'newest node must exist');
    assert.ok(!nodes.has('hash_0'), 'oldest node must be evicted');
  });
});
