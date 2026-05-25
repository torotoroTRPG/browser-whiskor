/**
 * tests/unit/canvas-viewport.test.js
 * Section 2.1 — Viewport Consistency
 *
 * Tests the S.liveVp state object management:
 *   initial load, live VP updates, dimension sync, in-view calculation.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDOM } from '../helpers/dom-mock.js';

// ── Inline ViewportState implementation ───────────────────────────────────────
// Replace with: import { ViewportState } from '../../dashboard/viewport.js';

class ViewportState {
  constructor() {
    this.liveVp = null;
    this._zoom  = null;
    this._panX  = 0;
    this._panY  = 0;
    this._renderQueued = false;
    this._renderCount  = 0;
  }

  /** Called on first TEXT_COORDS receive — initialise from snapshot viewport. */
  initFromSnapshot(snapshotVp) {
    this.liveVp = {
      scrollX: snapshotVp.scrollX,
      scrollY: snapshotVp.scrollY,
      width:   snapshotVp.width,
      height:  snapshotVp.height,
    };
    this._invalidateAreaCache();
    this._queueRender();
  }

  /** Called on VIEWPORT_UPDATE from SW. */
  onLiveUpdate(vpMsg) {
    if (!this.liveVp) {
      this.liveVp = { scrollX: 0, scrollY: 0, width: 0, height: 0 };
    }
    // Update scroll without touching zoom/pan
    this.liveVp.scrollX = vpMsg.scrollX;
    this.liveVp.scrollY = vpMsg.scrollY;
    // Only update dimensions when explicitly provided
    if (vpMsg.width  !== undefined) this.liveVp.width  = vpMsg.width;
    if (vpMsg.height !== undefined) this.liveVp.height = vpMsg.height;
    this._invalidateAreaCache();
    this._queueRender();
  }

  /** Called when a new snapshot is loaded (new TEXT_COORDS). */
  onNewSnapshot(snapshotVp) {
    // Preserve live scroll, update only page dimensions
    if (!this.liveVp) { this.initFromSnapshot(snapshotVp); return; }
    this.liveVp.width  = snapshotVp.width;
    this.liveVp.height = snapshotVp.height;
    // scrollX/Y intentionally NOT overwritten
  }

  /** Whether a word (by bounding box) is in the live viewport. */
  isInView(word) {
    if (!this.liveVp) return false;
    const { scrollX, scrollY, width, height } = this.liveVp;
    return (
      word.right  >= scrollX &&
      word.left   <= scrollX + width &&
      word.bottom >= scrollY &&
      word.top    <= scrollY + height
    );
  }

  /** Auto-fit: center canvas on live viewport (returns pan offsets). */
  autoFitPan(canvasWidth, canvasHeight) {
    if (!this.liveVp) return { panX: 0, panY: 0 };
    const cx = this.liveVp.scrollX + this.liveVp.width  / 2;
    const cy = this.liveVp.scrollY + this.liveVp.height / 2;
    return {
      panX: canvasWidth  / 2 - cx,
      panY: canvasHeight / 2 - cy,
    };
  }

  // ── Internals (stubs for testing) ──────────────────────────────────────────
  _invalidateAreaCache()  { this._areaCacheDirty = true; }
  _queueRender()          { this._renderQueued = true; this._renderCount++; }
  get areaCacheDirty()    { return this._areaCacheDirty; }
  get renderCount()       { return this._renderCount; }
}

// ══════════════════════════════════════════════════════════════════════════════
describe('2.1 Viewport Consistency', () => {

  let vp;

  beforeEach(() => {
    resetDOM();
    vp = new ViewportState();
  });

  // ── Initial load ────────────────────────────────────────────────────────────

  test('initFromSnapshot: liveVp set from snapshot viewport', () => {
    const snapshot = { scrollX: 100, scrollY: 200, width: 1280, height: 800 };
    vp.initFromSnapshot(snapshot);

    assert.ok(vp.liveVp !== null, 'liveVp must be initialised');
    assert.strictEqual(vp.liveVp.scrollX, 100);
    assert.strictEqual(vp.liveVp.scrollY, 200);
    assert.strictEqual(vp.liveVp.width,   1280);
    assert.strictEqual(vp.liveVp.height,  800);
  });

  test('initFromSnapshot: area cache invalidated', () => {
    vp.initFromSnapshot({ scrollX: 0, scrollY: 0, width: 1280, height: 800 });
    assert.ok(vp.areaCacheDirty, 'area cache must be marked dirty');
  });

  test('initFromSnapshot: render queued', () => {
    vp.initFromSnapshot({ scrollX: 0, scrollY: 0, width: 1280, height: 800 });
    assert.ok(vp.renderCount > 0, 'render must be queued');
  });

  // ── Live VP update ──────────────────────────────────────────────────────────

  test('onLiveUpdate: liveVp.scrollX/Y updated, zoom/pan not affected', () => {
    vp.initFromSnapshot({ scrollX: 0, scrollY: 0, width: 1280, height: 800 });
    const beforeZoom = vp._zoom;
    const beforePanX = vp._panX;
    const beforePanY = vp._panY;

    vp.onLiveUpdate({ scrollX: 500, scrollY: 250 });

    assert.strictEqual(vp.liveVp.scrollX, 500, 'scrollX must update');
    assert.strictEqual(vp.liveVp.scrollY, 250, 'scrollY must update');
    assert.strictEqual(vp._zoom,  beforeZoom,  'zoom must not change');
    assert.strictEqual(vp._panX,  beforePanX,  'panX must not change');
    assert.strictEqual(vp._panY,  beforePanY,  'panY must not change');
  });

  test('onLiveUpdate: re-queues render', () => {
    vp.initFromSnapshot({ scrollX: 0, scrollY: 0, width: 1280, height: 800 });
    const before = vp.renderCount;
    vp.onLiveUpdate({ scrollX: 100, scrollY: 50 });
    assert.ok(vp.renderCount > before, 'render must be re-queued on live update');
  });

  // ── Dimension update ────────────────────────────────────────────────────────

  test('onNewSnapshot: width/height updated, scrollX/Y preserved', () => {
    vp.initFromSnapshot({ scrollX: 300, scrollY: 150, width: 1280, height: 800 });

    vp.onNewSnapshot({ scrollX: 0, scrollY: 0, width: 1920, height: 1080 });

    assert.strictEqual(vp.liveVp.width,   1920, 'width must update from new snapshot');
    assert.strictEqual(vp.liveVp.height,  1080, 'height must update from new snapshot');
    assert.strictEqual(vp.liveVp.scrollX, 300,  'scrollX must not be overwritten');
    assert.strictEqual(vp.liveVp.scrollY, 150,  'scrollY must not be overwritten');
  });

  // ── In-view calculation ─────────────────────────────────────────────────────

  test('isInView: word fully inside viewport → true', () => {
    vp.initFromSnapshot({ scrollX: 0, scrollY: 0, width: 1280, height: 800 });

    const word = { left: 100, top: 100, right: 200, bottom: 130 };
    assert.strictEqual(vp.isInView(word), true);
  });

  test('isInView: word completely outside viewport → false', () => {
    vp.initFromSnapshot({ scrollX: 0, scrollY: 0, width: 1280, height: 800 });

    const word = { left: 2000, top: 2000, right: 2100, bottom: 2020 };
    assert.strictEqual(vp.isInView(word), false);
  });

  test('isInView: word partially overlapping viewport edge → true', () => {
    vp.initFromSnapshot({ scrollX: 0, scrollY: 0, width: 1280, height: 800 });

    // Word straddles right edge
    const word = { left: 1200, top: 100, right: 1350, bottom: 130 };
    assert.strictEqual(vp.isInView(word), true, 'partial overlap must count as in-view');
  });

  test('isInView: uses liveVp.scrollX/Y not zero origin', () => {
    vp.initFromSnapshot({ scrollX: 1000, scrollY: 500, width: 1280, height: 800 });

    // Word only visible when scrollX=1000 (viewport spans 1000–2280)
    const word = { left: 1500, top: 550, right: 1600, bottom: 580 };
    assert.strictEqual(vp.isInView(word), true, 'must use live scroll offset');

    // Same word with scroll reset to 0 (viewport spans 0–1280) → out of view
    vp.onLiveUpdate({ scrollX: 0, scrollY: 0 });
    assert.strictEqual(vp.isInView(word), false, 'must recalculate after scroll change');
  });

  test('isInView: word at exact viewport boundary is in-view', () => {
    vp.initFromSnapshot({ scrollX: 0, scrollY: 0, width: 1280, height: 800 });

    // Word exactly at bottom-right corner
    const word = { left: 1279, top: 799, right: 1280, bottom: 800 };
    assert.strictEqual(vp.isInView(word), true, 'boundary word must be in-view');
  });

  test('isInView: returns false when liveVp not initialised', () => {
    const word = { left: 0, top: 0, right: 100, bottom: 20 };
    assert.strictEqual(vp.isInView(word), false, 'must not crash on null liveVp');
  });

  // ── Auto-fit centering ───────────────────────────────────────────────────────

  test('autoFitPan: centers canvas on live viewport midpoint', () => {
    // Viewport at scrollX=400, width=800 → midX=800; canvas 1600px → panX=0
    vp.initFromSnapshot({ scrollX: 400, scrollY: 0, width: 800, height: 600 });

    const { panX, panY } = vp.autoFitPan(1600, 1200);

    // cx = 400 + 800/2 = 800; panX = 1600/2 - 800 = 0
    assert.strictEqual(panX, 0,   'canvas must be centered horizontally');
    assert.strictEqual(panY, 300, 'canvas must be centered vertically');
  });

  test('autoFitPan: returns {0,0} when liveVp not set', () => {
    const { panX, panY } = vp.autoFitPan(1280, 800);
    assert.strictEqual(panX, 0);
    assert.strictEqual(panY, 0);
  });
});
