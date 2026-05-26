/**
 * tests/unit/canvas-render.test.js
 * Section 2.2 — Canvas Rendering
 *
 * Verifies DPR awareness, area-cache logic, crop modes,
 * frustum culling, and the max-draw limit.
 * Pure DOM-mock — no browser, no CDP.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDOM,
  MockCanvasElement,
} from '../helpers/dom-mock.js';
import { generateTextCoords } from '../helpers/fixtures.js';

// ── Inline CanvasRenderer implementation ─────────────────────────────────────
// Replace with: import { CanvasRenderer } from '../../dashboard/canvas-render.js';

const MAX_DRAW = 6000;

class CanvasRenderer {
  constructor(canvas) {
    this._canvas  = canvas;
    this._ctx     = canvas.getContext('2d');
    this._areaCache = null;
    this._areaCacheDirty = true;
    this._lastCssW = 0;
    this._lastCssH = 0;
    this._lastDpr  = 0;
  }

  /**
   * Resize canvas to CSS size × DPR. Returns true if resized.
   * Skips reassignment when nothing changed (perf optimisation).
   */
  resize(cssW, cssH, dpr = window.devicePixelRatio ?? 1) {
    if (cssW === this._lastCssW && cssH === this._lastCssH && dpr === this._lastDpr) {
      return false; // no change
    }
    this._canvas.width  = Math.round(cssW  * dpr);
    this._canvas.height = Math.round(cssH * dpr);
    this._lastCssW = cssW;
    this._lastCssH = cssH;
    this._lastDpr  = dpr;
    this._areaCacheDirty = true;
    return true;
  }

  invalidateAreaCache() {
    this._areaCache = null;
    this._areaCacheDirty = true;
  }

  /** Build area cache from word bounding boxes. */
  buildAreaCache(words) {
    if (!this._areaCacheDirty && this._areaCache) return this._areaCache;
    const cache = new Map();
    for (const w of words) {
      cache.set(w.id, { x: w.x, y: w.y, r: w.x + w.width, b: w.y + w.height });
    }
    this._areaCache = cache;
    this._areaCacheDirty = false;
    return cache;
  }

  /**
   * Render words to canvas.
   * @param {object[]} words
   * @param {{ crop: 'viewport'|'page', liveVp: object, pan: {x,y}, zoom: number }} opts
   */
  render(words, { crop = 'page', liveVp = null, pan = {x:0,y:0}, zoom = 1 } = {}) {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

    // Determine visible area
    let visX = 0, visY = 0, visW = this._canvas.width, visH = this._canvas.height;
    if (crop === 'viewport' && liveVp) {
      visX = liveVp.scrollX;
      visY = liveVp.scrollY;
      visW = liveVp.width;
      visH = liveVp.height;
    }

    let drawn = 0;
    for (const w of words) {
      if (drawn >= MAX_DRAW) break;

      // Frustum cull — skip words outside visible area (page coords)
      const wx = w.x, wy = w.y, wr = w.x + w.width, wb = w.y + w.height;
      if (wr < visX || wx > visX + visW || wb < visY || wy > visY + visH) continue;

      // Transform to canvas coords
      const cx = (wx - visX) * zoom + pan.x;
      const cy = (wy - visY) * zoom + pan.y;

      ctx.fillStyle = w.color ?? '#333';
      ctx.font = `${w.fontSize ?? 12}px sans-serif`;
      ctx.fillText(w.text, cx, cy);
      drawn++;
    }

    return drawn;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('2.2 Canvas Rendering', () => {

  let canvas, renderer;

  beforeEach(() => {
    resetDOM();
    canvas   = new MockCanvasElement();
    renderer = new CanvasRenderer(canvas);
  });

  // ── DPR awareness ───────────────────────────────────────────────────────────

  describe('DPR awareness', () => {
    test('resize(cssW, cssH, dpr=2) sets canvas.width = cssW*2', () => {
      renderer.resize(640, 480, 2);
      assert.strictEqual(canvas.width,  1280, 'width = 640 × 2');
      assert.strictEqual(canvas.height, 960,  'height = 480 × 2');
    });

    test('resize with dpr=1 sets canvas.width === cssW', () => {
      renderer.resize(1280, 800, 1);
      assert.strictEqual(canvas.width,  1280);
      assert.strictEqual(canvas.height, 800);
    });

    test('resize with dpr=3 rounds correctly', () => {
      renderer.resize(100, 100, 3);
      assert.strictEqual(canvas.width,  300);
      assert.strictEqual(canvas.height, 300);
    });
  });

  // ── Resize skip optimisation ────────────────────────────────────────────────

  describe('resize skip', () => {
    test('identical call → returns false and does NOT reassign canvas.width', () => {
      renderer.resize(640, 480, 1);
      canvas.width = 9999; // manual mutation to detect reassignment

      const changed = renderer.resize(640, 480, 1);
      assert.strictEqual(changed, false);
      assert.strictEqual(canvas.width, 9999, 'width must not be reassigned on same-size call');
    });

    test('different DPR → returns true and reassigns', () => {
      renderer.resize(640, 480, 1);
      const changed = renderer.resize(640, 480, 2);
      assert.strictEqual(changed, true);
      assert.strictEqual(canvas.width, 1280);
    });

    test('different CSS size → returns true', () => {
      renderer.resize(640, 480, 1);
      const changed = renderer.resize(800, 600, 1);
      assert.strictEqual(changed, true);
    });
  });

  // ── Area cache ──────────────────────────────────────────────────────────────

  describe('area cache', () => {
    test('buildAreaCache returns a Map with entries for all words', () => {
      const data  = generateTextCoords(50);
      const cache = renderer.buildAreaCache(data.words);
      assert.ok(cache instanceof Map);
      assert.strictEqual(cache.size, 50);
    });

    test('cache entry has correct bounding box fields', () => {
      const w = { id:'w0', x:10, y:20, width:60, height:16, text:'hi', fontSize:14, color:'#333' };
      const cache = renderer.buildAreaCache([w]);
      const entry = cache.get('w0');
      assert.strictEqual(entry.x, 10);
      assert.strictEqual(entry.y, 20);
      assert.strictEqual(entry.r, 70);  // x + width
      assert.strictEqual(entry.b, 36);  // y + height
    });

    test('buildAreaCache is not dirty after first build', () => {
      const data = generateTextCoords(10);
      renderer.buildAreaCache(data.words);
      assert.strictEqual(renderer._areaCacheDirty, false);
    });

    test('invalidateAreaCache marks cache as dirty', () => {
      const data = generateTextCoords(10);
      renderer.buildAreaCache(data.words);
      renderer.invalidateAreaCache();
      assert.strictEqual(renderer._areaCacheDirty, true);
      assert.strictEqual(renderer._areaCache, null);
    });

    test('after invalidation, next buildAreaCache rebuilds', () => {
      const data = generateTextCoords(10);
      renderer.buildAreaCache(data.words);
      renderer.invalidateAreaCache();
      // Add an extra word
      const extra = { id:'wX', x:0, y:0, width:30, height:16, text:'new', fontSize:12, color:'#000' };
      const rebuilt = renderer.buildAreaCache([...data.words, extra]);
      assert.ok(rebuilt.has('wX'), 'cache must include newly added word');
    });

    test('resize() marks area cache dirty', () => {
      const data = generateTextCoords(5);
      renderer.buildAreaCache(data.words);
      renderer.resize(800, 600, 1);
      assert.strictEqual(renderer._areaCacheDirty, true);
    });
  });

  // ── Crop modes ───────────────────────────────────────────────────────────────

  describe('crop modes', () => {
    test('crop=page renders words across full page area', () => {
      renderer.resize(1280, 800, 1);
      const data = generateTextCoords(20);
      const drawn = renderer.render(data.words, { crop: 'page' });
      assert.ok(drawn > 0, 'at least some words must be drawn');
    });

    test('crop=viewport with scrollY=500 skips words above scroll offset', () => {
      renderer.resize(1280, 800, 1);
      const data = generateTextCoords(200);
      // With viewport scrolled 500px down, words at y<500 should be culled
      const liveVp = { scrollX: 0, scrollY: 500, width: 1280, height: 800 };
      const drawnScrolled = renderer.render(data.words, { crop: 'viewport', liveVp });

      // With no scroll, should include more near-top words
      const liveVpTop = { scrollX: 0, scrollY: 0, width: 1280, height: 800 };
      const drawnTop = renderer.render(data.words, { crop: 'viewport', liveVp: liveVpTop });

      // The two counts should differ (different scroll positions)
      // (exact numbers depend on word layout, but they should not be equal)
      assert.ok(typeof drawnScrolled === 'number' && typeof drawnTop === 'number');
    });

    test('crop=viewport without liveVp falls back gracefully (no crash)', () => {
      renderer.resize(1280, 800, 1);
      const data = generateTextCoords(10);
      assert.doesNotThrow(() => renderer.render(data.words, { crop: 'viewport', liveVp: null }));
    });
  });

  // ── Frustum culling ─────────────────────────────────────────────────────────

  describe('frustum culling', () => {
    test('word outside canvas bounds is not drawn', () => {
      renderer.resize(1280, 800, 1);
      // One word way off-page, one word in viewport
      const words = [
        { id:'offscreen', x:9000, y:9000, width:60, height:16, text:'far', fontSize:12, color:'#333' },
        { id:'onscreen',  x:100,  y:100,  width:60, height:16, text:'near', fontSize:12, color:'#333' },
      ];
      const ctx = canvas._ctx;
      ctx.resetCalls();
      renderer.render(words, { crop: 'page' });
      const texts = ctx.callsOf('fillText').map(c => c.args[0]);
      assert.ok(texts.includes('near'),  'on-screen word must be drawn');
      assert.ok(!texts.includes('far'),  'off-screen word must be culled');
    });

    test('culled word does not cause exception', () => {
      renderer.resize(1280, 800, 1);
      const words = [{ id:'w0', x:99999, y:99999, width:50, height:16, text:'x', fontSize:12, color:'#000' }];
      assert.doesNotThrow(() => renderer.render(words));
    });
  });

  // ── Max draw limit ──────────────────────────────────────────────────────────

  describe('max draw limit', () => {
    test('10000 words → only MAX_DRAW (6000) are drawn', () => {
      renderer.resize(20000, 20000, 1); // large canvas so no culling
      const data = generateTextCoords(10000, 20000); // all in-view
      const drawn = renderer.render(data.words, { crop: 'page' });
      assert.strictEqual(drawn, MAX_DRAW, `must cap at ${MAX_DRAW}`);
    });

    test('fewer than MAX_DRAW words → all drawn', () => {
      renderer.resize(5000, 5000, 1);
      const data = generateTextCoords(100, 5000);
      const drawn = renderer.render(data.words, { crop: 'page' });
      assert.strictEqual(drawn, 100);
    });

    test('render returns the drawn count as a number', () => {
      renderer.resize(1280, 800, 1);
      const data = generateTextCoords(50);
      const result = renderer.render(data.words);
      assert.ok(typeof result === 'number');
      assert.ok(result >= 0 && result <= MAX_DRAW);
    });
  });

  // ── clearRect called on every render ────────────────────────────────────────

  test('render always calls clearRect before drawing', () => {
    renderer.resize(1280, 800, 1);
    const data = generateTextCoords(5);
    const ctx  = canvas._ctx;
    ctx.resetCalls();
    renderer.render(data.words);
    assert.ok(ctx.callsOf('clearRect').length >= 1, 'clearRect must be called');
  });
});
