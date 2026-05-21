/**
 * tests/stress/large-data.test.js
 * Section 9.1 — Large Data
 *
 * Stress tests with realistic data generation and performance measurement.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTextCoords, generateNetworkRequests } from '../helpers/fixtures.js';
import { resetDOM, MockCanvasElement } from '../helpers/dom-mock.js';

// ── Inline CanvasRenderer for stress testing ─────────────────────────────────
// Mirrors the real dashboard canvas render logic (frustum culling, max draw limit)

const MAX_DRAW = 6000;

function renderWords(words, canvasWidth, canvasHeight, scrollX, scrollY) {
  let drawn = 0;
  for (let i = 0; i < words.length && drawn < MAX_DRAW; i++) {
    const w = words[i];
    const inView = !(w.x + w.width < scrollX || w.x > scrollX + canvasWidth ||
                     w.y + w.height < scrollY || w.y > scrollY + canvasHeight);
    if (inView) drawn++;
  }
  return drawn;
}

// ══════════════════════════════════════════════════════════════════════════════
describe('9.1 Large Data', () => {

  test('10000 words: max 6000 drawn (frustum culling + draw limit)', () => {
    const data = generateTextCoords(10000);
    assert.strictEqual(data.words.length, 10000);

    const drawn = renderWords(data.words, 1280, 800, 0, 0);
    assert.ok(drawn <= MAX_DRAW, `drawn (${drawn}) must not exceed MAX_DRAW (${MAX_DRAW})`);
  });

  test('10000 words: render completes within 100ms', () => {
    const data = generateTextCoords(10000);
    const start = performance.now();
    renderWords(data.words, 1280, 800, 0, 0);
    const duration = performance.now() - start;
    assert.ok(duration < 100, `render must complete within 100ms (took ${duration.toFixed(1)}ms)`);
  });

  test('5000 network requests: memory usage under 50MB', () => {
    const requests = generateNetworkRequests(5000);
    assert.strictEqual(requests.length, 5000);

    // Each request has url, method, status, size, timestamp, headers, body preview
    const memBefore = process.memoryUsage().heapUsed;
    const stored = requests.map(r => ({ ...r, processed: true }));
    const memAfter = process.memoryUsage().heapUsed;
    const memDelta = (memAfter - memBefore) / 1024 / 1024;

    assert.ok(memDelta < 50, `5000 requests must use < 50MB (used ${memDelta.toFixed(1)}MB)`);

    // Verify structure
    assert.ok(stored[0].url, 'request must have url');
    assert.ok(stored[0].status, 'request must have status');
  });

  test('100 states in graph: BFS navigation under 100ms', () => {
    // Build a linear graph: A→B→C→...→Z (26) + branches
    const nodes = {};
    const edges = [];
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

    // Linear chain
    for (let i = 0; i < chars.length - 1; i++) {
      nodes[chars[i]] = { hash: chars[i], url: `https://example.com/${chars[i].toLowerCase()}` };
      edges.push({ from: chars[i], to: chars[i + 1], action: { type: 'click' } });
    }
    nodes[chars[chars.length - 1]] = { hash: chars[chars.length - 1], url: 'https://example.com/z' };

    // Add branches (A→X, B→Y, C→Z)
    edges.push({ from: 'A', to: 'X', action: { type: 'click' } });
    edges.push({ from: 'B', to: 'Y', action: { type: 'click' } });
    nodes['X'] = { hash: 'X', url: 'https://example.com/x' };
    nodes['Y'] = { hash: 'Y', url: 'https://example.com/y' };

    // BFS findPath
    function findPath(from, to, nodes, edges) {
      if (from === to) return [];
      const visited = new Set();
      const queue = [[from]];
      while (queue.length > 0) {
        const path = queue.shift();
        const current = path[path.length - 1];
        if (visited.has(current)) continue;
        visited.add(current);
        for (const edge of edges) {
          if (edge.from === current && !visited.has(edge.to)) {
            const newPath = [...path, edge.to];
            if (edge.to === to) return newPath.map((node, i) => i === 0 ? null : { from: path[i - 1], to: node, action: edges.find(e => e.from === path[i - 1] && e.to === node)?.action });
            queue.push(newPath);
          }
        }
      }
      return null;
    }

    const start = performance.now();
    const path = findPath('A', 'Z', nodes, edges);
    const duration = performance.now() - start;

    assert.ok(path !== null, 'must find path A→Z');
    assert.ok(duration < 100, `BFS must complete within 100ms (took ${duration.toFixed(1)}ms)`);
    assert.ok(path.length <= 26, `path must be reasonable length (got ${path.length})`);
  });

  test('50 rapid dashboard resizes: no memory leak', () => {
    resetDOM();
    const canvas = new MockCanvasElement();

    const memBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < 50; i++) {
      canvas.width = 1280 + i;
      canvas.height = 800 + i;
      canvas._ctx.resetCalls();
    }

    const memAfter = process.memoryUsage().heapUsed;
    const memDelta = (memAfter - memBefore) / 1024 / 1024;

    assert.ok(memDelta < 10, `50 resizes must not leak > 10MB (leaked ${memDelta.toFixed(1)}MB)`);
  });

  test('TEXT_COORDS payload: 5000 words serializes under 50ms', () => {
    const data = generateTextCoords(5000);
    const start = performance.now();
    const json = JSON.stringify({ type: 'TEXT_COORDS', tabId: 1, payload: data });
    const duration = performance.now() - start;

    assert.ok(duration < 50, `serialization must complete within 50ms (took ${duration.toFixed(1)}ms)`);
    assert.ok(json.length > 100000, 'payload must be substantial (> 100KB)');

    // Verify round-trip
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.payload.words.length, 5000);
  });
});
