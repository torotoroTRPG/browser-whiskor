/**
 * tests/unit/delta-engine.test.js
 *
 * Smart Delta Aggregator tests.
 * Section 11.1 — Delta Engine & Pattern Registry
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const deltaEngine = require('../../server/delta-engine');
const patternRegistry = require('../../server/pattern-registry');

describe('11.1 Delta Engine', () => {
  before(() => {
    deltaEngine.resetAll();
  });

  after(() => {
    deltaEngine.resetAll();
  });

  describe('Motion Clustering', () => {
    it('groups elements with same vector', () => {
      const deltas = [
        { id: 'a', dx: 10, dy: 0 },
        { id: 'b', dx: 10, dy: 0 },
        { id: 'c', dx: 10, dy: 0 },
        { id: 'd', dx: 0, dy: 20 },
        { id: 'e', dx: 0, dy: 20 },
      ];

      const clusters = deltaEngine.clusterByVector(deltas);
      assert.equal(clusters.length, 2);

      const cluster1 = clusters.find(c => c.vector.x === 10);
      const cluster2 = clusters.find(c => c.vector.y === 20);

      assert.equal(cluster1.count, 3);
      assert.equal(cluster2.count, 2);
    });

    it('tolerates small vector differences', () => {
      const deltas = [
        { id: 'a', dx: 10, dy: 0 },
        { id: 'b', dx: 11, dy: 1 },
        { id: 'c', dx: 10, dy: 2 },
      ];

      const clusters = deltaEngine.clusterByVector(deltas);
      assert.equal(clusters.length, 1);
      assert.equal(clusters[0].count, 3);
    });

    it('separates elements with different vectors', () => {
      const deltas = [
        { id: 'a', dx: 100, dy: 0 },
        { id: 'b', dx: 0, dy: 100 },
        { id: 'c', dx: 50, dy: 50 },
      ];

      const clusters = deltaEngine.clusterByVector(deltas);
      assert.equal(clusters.length, 3);
    });
  });

  describe('Scroll Detection', () => {
    it('detects scroll when 70%+ elements move same vector', () => {
      const deltas = [];
      for (let i = 0; i < 10; i++) {
        deltas.push({ id: `el-${i}`, dx: 0, dy: -500 });
      }
      deltas.push({ id: 'popup', dx: 10, dy: 10 });
      deltas.push({ id: 'tooltip', dx: -5, dy: 0 });

      const clusters = deltaEngine.clusterByVector(deltas);
      const scroll = deltaEngine.detectScroll(clusters, deltas.length);

      assert.ok(scroll, 'Should detect scroll');
      assert.equal(scroll.vector.y, -500);
      assert.equal(scroll.affectedCount, 10);
    });

    it('does not detect scroll with mixed movements', () => {
      const deltas = [
        { id: 'a', dx: 10, dy: 0 },
        { id: 'b', dx: 0, dy: 10 },
        { id: 'c', dx: -10, dy: 0 },
        { id: 'd', dx: 0, dy: -10 },
      ];

      const clusters = deltaEngine.clusterByVector(deltas);
      const scroll = deltaEngine.detectScroll(clusters, deltas.length);

      assert.equal(scroll, null);
    });
  });

  describe('Decorative Change Filtering', () => {
    it('ignores opacity-only changes', () => {
      const d = { id: 'fade', dx: 0, dy: 0, dw: 0, dh: 0 };
      assert.equal(deltaEngine.isDecorativeChange(d), true);
    });

    it('keeps position changes', () => {
      const d = { id: 'slide', dx: 50, dy: 0 };
      assert.equal(deltaEngine.isDecorativeChange(d), false);
    });

    it('keeps text changes', () => {
      const d = { id: 'text', dx: 0, dy: 0, textChanged: true };
      assert.equal(deltaEngine.isDecorativeChange(d), false);
    });

    it('keeps state changes', () => {
      const d = { id: 'btn', dx: 0, dy: 0, stateChanged: true };
      assert.equal(deltaEngine.isDecorativeChange(d), false);
    });
  });

  describe('Frame Buffering', () => {
    it('buffers frames until MAX_BUFFER_SIZE', () => {
      deltaEngine.resetAll();

      for (let i = 0; i < deltaEngine.MAX_BUFFER_SIZE - 1; i++) {
        const result = deltaEngine.addFrame('tab1', {
          timestamp: Date.now() + i * 100,
          deltas: [{ id: `el-${i}`, dx: 0, dy: -10 }],
        });
        assert.equal(result, null, `Frame ${i + 1} should not flush`);
      }
    });

    it('flushes when buffer is full', () => {
      deltaEngine.resetAll();

      for (let i = 0; i < deltaEngine.MAX_BUFFER_SIZE - 1; i++) {
        deltaEngine.addFrame('tab2', {
          timestamp: Date.now() + i * 100,
          deltas: [{ id: `el-${i}`, dx: 0, dy: -10 }],
        });
      }

      const result = deltaEngine.addFrame('tab2', {
        timestamp: Date.now() + deltaEngine.MAX_BUFFER_SIZE * 100,
        deltas: [{ id: 'last', dx: 0, dy: -10 }],
      });

      assert.ok(result, 'Should return aggregated delta');
      assert.ok(result.elapsed_ms >= 0);
      assert.ok(result.frame_count === deltaEngine.MAX_BUFFER_SIZE);
    });
  });

  describe('Smart Delta Output', () => {
    it('produces structured delta with scroll info', () => {
      deltaEngine.resetAll();

      let delta = null;
      for (let i = 0; i < deltaEngine.MAX_BUFFER_SIZE; i++) {
        const deltas = [];
        for (let j = 0; j < 10; j++) {
          deltas.push({ id: `item-${j}`, dx: 0, dy: -50 });
        }
        const result = deltaEngine.addFrame('tab3', {
          timestamp: Date.now() + i * 200,
          viewport: {
            from: { scrollX: 0, scrollY: i * 50 },
            to: { scrollX: 0, scrollY: (i + 1) * 50 },
          },
          deltas,
        });
        if (result) delta = result;
      }

      assert.ok(delta, 'Should have flushed delta');
      assert.ok(delta.scroll, 'Should detect scroll');
      assert.equal(delta.scroll.vector.y, -50);
    });

    it('separates content updates from motion', () => {
      deltaEngine.resetAll();

      deltaEngine.addFrame('tab4', {
        timestamp: Date.now(),
        deltas: [
          { id: 'moving', dx: 100, dy: 0 },
          { id: 'static-text', dx: 0, dy: 0, textChanged: true, newText: 'Updated!' },
        ],
      });

      const delta = deltaEngine.flushBuffer('tab4');

      assert.ok(delta);
      assert.ok(delta.content_updates, 'Should have content updates');
      assert.equal(delta.content_updates[0].id, 'static-text');
    });

    it('tracks new and known patterns', () => {
      deltaEngine.resetAll();
      patternRegistry.clearAll();

      // First occurrence: new pattern (appearance of modal)
      deltaEngine.addFrame('tab5', {
        timestamp: Date.now(),
        deltas: [{ id: 'modal', dx: 0, dy: 0, appeared: true, text: 'Error!', elementType: 'modal' }],
      });
      const delta1 = deltaEngine.flushBuffer('tab5');

      assert.ok(delta1._patterns.new, 'Should have new patterns');
      assert.equal(delta1._patterns.new.length, 1);

      // Second occurrence: same structural pattern (same text + type)
      deltaEngine.addFrame('tab5', {
        timestamp: Date.now() + 1000,
        deltas: [{ id: 'modal-dup', dx: 0, dy: 0, appeared: true, text: 'Error!', elementType: 'modal' }],
      });
      const delta2 = deltaEngine.flushBuffer('tab5');

      assert.ok(delta2._patterns.known, 'Should have known patterns');
    });
  });

  describe('Cleanup', () => {
    it('clears buffer on cleanup', () => {
      deltaEngine.resetAll();
      deltaEngine.addFrame('tab-cleanup', {
        timestamp: Date.now(),
        deltas: [],
      });

      deltaEngine.cleanup('tab-cleanup');
      const state = deltaEngine.getBufferState('tab-cleanup');
      assert.equal(state.frames, 0);
    });
  });
});

describe('11.2 Pattern Registry', () => {
  before(() => {
    patternRegistry.clearAll();
  });

  after(() => {
    patternRegistry.clearAll();
  });

  it('registers new pattern with full definition', () => {
    patternRegistry.clearAll();

    const result = patternRegistry.registerPattern('tab1', {
      vector: { x: 0, y: -500 },
      elements: [{ id: 'a' }, { id: 'b' }],
    });

    assert.ok(result.isNew);
    assert.ok(result.ref.startsWith('pat-'));
    assert.ok(result.def);
    assert.equal(result.def.type, 'motion');
  });

  it('returns ref only for existing pattern', () => {
    patternRegistry.clearAll();

    const def = {
      vector: { x: 10, y: 0 },
      elements: [{ id: 'slide-1' }],
    };

    const first = patternRegistry.registerPattern('tab1', def);
    assert.ok(first.isNew);

    const second = patternRegistry.registerPattern('tab1', def);
    assert.equal(second.isNew, false);
    assert.equal(second.ref, first.ref);
    assert.equal(second.def, undefined);
  });

  it('stores and retrieves pattern detail', () => {
    patternRegistry.clearAll();

    const result = patternRegistry.registerPattern('tab1', {
      vector: { x: 0, y: 100 },
      elements: [{ id: 'test-el' }],
    });

    const detail = patternRegistry.getPatternDetail(result.ref);
    assert.ok(detail);
    assert.equal(detail.ref, result.ref);
    assert.equal(detail.vector.y, 100);
  });

  it('returns null for unknown pattern', () => {
    const detail = patternRegistry.getPatternDetail('pat-nonexistent');
    assert.equal(detail, null);
  });

  it('lists patterns for a tab', () => {
    patternRegistry.clearAll();

    patternRegistry.registerPattern('tab-list', {
      vector: { x: 0, y: 10 },
      elements: [{ id: 'a' }],
    });
    patternRegistry.registerPattern('tab-list', {
      appeared: { subtype: 'modal', text: 'Hello' },
    });

    const patterns = patternRegistry.getPatternsForTab('tab-list');
    assert.equal(patterns.length, 2);
  });

  it('classifies scroll patterns correctly', () => {
    const classification = patternRegistry.classifyPattern({
      vector: { x: 0, y: -500 },
      elements: Array(10).fill(null).map((_, i) => ({ id: `el-${i}`, dx: 0, dy: -500 })),
    });

    assert.equal(classification.type, 'motion');
    assert.equal(classification.subtype, 'scroll');
  });

  it('classifies appearance patterns correctly', () => {
    const classification = patternRegistry.classifyPattern({
      appeared: { subtype: 'toast', text: 'Saved!' },
    });

    assert.equal(classification.type, 'appearance');
    assert.equal(classification.subtype, 'toast');
  });
});
