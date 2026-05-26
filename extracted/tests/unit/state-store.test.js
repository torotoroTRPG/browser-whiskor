/**
 * tests/unit/state-store.test.js
 * Section 7.1 — State Store
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

class StateStore {
  constructor(maxSize = 100) {
    this.nodes = new Map();
    this.edges = [];
    this.maxSize = maxSize;
  }

  addNode(hash, data) {
    if (this.nodes.size >= this.maxSize) {
      const firstKey = this.nodes.keys().next().value;
      this.nodes.delete(firstKey);
    }
    this.nodes.set(hash, data);
  }

  addEdge(from, to, action) {
    this.edges.push({ from, to, action });
  }
}

describe('7.1 State Store', () => {

  test('Add node: stores state by hash', () => {
    const store = new StateStore();
    store.addNode('abc', { label: 'Home' });
    assert.ok(store.nodes.has('abc'));
    assert.strictEqual(store.nodes.get('abc').label, 'Home');
  });

  test('Add edge: records transition', () => {
    const store = new StateStore();
    store.addEdge('h1', 'h2', 'click');
    assert.strictEqual(store.edges.length, 1);
    assert.strictEqual(store.edges[0].from, 'h1');
  });

  test('LRU eviction: drops oldest when full', () => {
    const store = new StateStore(2);
    store.addNode('1', {});
    store.addNode('2', {});
    store.addNode('3', {});

    assert.strictEqual(store.nodes.size, 2);
    assert.ok(!store.nodes.has('1'), 'oldest node must be evicted');
    assert.ok(store.nodes.has('2'));
    assert.ok(store.nodes.has('3'));
  });
});
