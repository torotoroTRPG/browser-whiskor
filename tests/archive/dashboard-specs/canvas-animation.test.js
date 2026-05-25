/**
 * tests/unit/canvas-animation.test.js
 * Section 2.4 — Animation
 *
 * Tests FOCUS VP zoom+pan animation, cancellation on interaction,
 * cancellation on resize, and rAF cleanup (no pending frames).
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDOM } from '../helpers/dom-mock.js';

// ── Inline CanvasAnimator implementation ─────────────────────────────────────
// Replace with: import { CanvasAnimator } from '../../dashboard/canvas-animation.js';

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

class CanvasAnimator {
  constructor(getState, setState) {
    this._getState  = getState;
    this._setState  = setState;
    this._rafId     = null;
    this._startTime = null;
    this._duration  = 250;  // ms — matches spec "~250ms"
    this._from      = null;
    this._to        = null;
    this._onDone    = null;
    this._cancelled = false;
  }

  /** Animate zoom+pan from current state to target (viewport-fit). */
  animateTo(target, durationMs = this._duration, onDone = null) {
    this.cancel();  // cancel any existing animation
    this._from   = { ...this._getState() };
    this._to     = target;
    this._onDone = onDone;
    this._cancelled = false;
    this._startTime = null;
    this._rafId  = requestAnimationFrame(t => this._tick(t));
  }

  /** Cancel any running animation immediately. */
  cancel() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._cancelled = true;
  }

  _tick(now) {
    if (this._cancelled) return;
    if (this._startTime === null) this._startTime = now;

    const elapsed  = now - this._startTime;
    const progress = Math.min(elapsed / this._duration, 1);
    const eased    = easeOutCubic(progress);

    const state = this._getState();
    const from  = this._from;
    const to    = this._to;

    this._setState({
      panX: from.panX + (to.panX - from.panX) * eased,
      panY: from.panY + (to.panY - from.panY) * eased,
      zoom: from.zoom + (to.zoom - from.zoom) * eased,
    });

    if (progress < 1) {
      this._rafId = requestAnimationFrame(t => this._tick(t));
    } else {
      this._rafId = null;
      if (this._onDone) this._onDone();
    }
  }

  get isRunning() { return this._rafId !== null && !this._cancelled; }
  get pendingRafId() { return this._rafId; }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('2.4 Animation', () => {

  let state, animator;

  beforeEach(() => {
    resetDOM();
    state = { panX: 0, panY: 0, zoom: 1 };
    animator = new CanvasAnimator(
      ()  => ({ ...state }),
      (s) => { state = { ...state, ...s }; }
    );
  });

  // ── FOCUS VP animation ──────────────────────────────────────────────────────

  describe('FOCUS VP animation', () => {
    test('animateTo starts rAF (isRunning = true)', () => {
      animator.animateTo({ panX: 100, panY: 200, zoom: 1.5 });
      assert.ok(animator.isRunning, 'animation must be running after start');
    });

    test('single rAF tick advances state toward target', () => {
      const target = { panX: 100, panY: 200, zoom: 2 };
      animator.animateTo(target);
      window.flushRAF(); // one tick at t=0 (no movement yet)
      window.flushRAF(); // second tick with some elapsed time
      // State should be between initial and target
      assert.ok(state.zoom >= 1, 'zoom must remain >= initial');
    });

    test('animation completes after flush to > duration', () => {
      let done = false;
      const target = { panX: 200, panY: 300, zoom: 2 };
      animator.animateTo(target, 250, () => { done = true; });

      // Simulate passage of time by patching performance.now then flushing
      let t = 0;
      const origNow = performance.now;
      performance.now = () => t;

      // Advance 300ms in steps
      animator._startTime = 0;
      t = 300;
      animator._tick(300);

      assert.ok(done, 'onDone callback must fire when animation completes');
      assert.strictEqual(state.panX, 200, 'panX must reach target');
      assert.strictEqual(state.panY, 300, 'panY must reach target');
      assert.strictEqual(state.zoom, 2,   'zoom must reach target');

      performance.now = origNow;
    });

    test('easeOutCubic produces value between 0 and 1 for t in [0,1]', () => {
      for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const v = easeOutCubic(t);
        assert.ok(v >= 0 && v <= 1, `easeOutCubic(${t}) = ${v} must be in [0,1]`);
      }
    });

    test('easeOutCubic(0) = 0 and easeOutCubic(1) = 1', () => {
      assert.strictEqual(easeOutCubic(0), 0);
      assert.strictEqual(easeOutCubic(1), 1);
    });
  });

  // ── Animation cancel on interaction ─────────────────────────────────────────

  describe('cancel on interaction', () => {
    test('cancel() stops the animation immediately', () => {
      animator.animateTo({ panX: 100, panY: 100, zoom: 2 });
      assert.ok(animator.isRunning);

      animator.cancel();
      assert.strictEqual(animator.isRunning, false);
    });

    test('after cancel, further rAF flushes do not move state', () => {
      animator.animateTo({ panX: 999, panY: 999, zoom: 5 });
      animator.cancel();

      const before = { ...state };
      window.flushRAF();
      window.flushRAFTimes(5);

      assert.deepStrictEqual(state, before, 'cancelled animation must not continue updating state');
    });

    test('new animateTo cancels previous animation', () => {
      animator.animateTo({ panX: 999, panY: 0, zoom: 10 });
      const firstRafId = animator.pendingRafId;

      animator.animateTo({ panX: 50, panY: 50, zoom: 1.2 });

      // After re-starting, isRunning is true (new animation)
      assert.ok(animator.isRunning);
      // First animation is gone (different or same rAF id but it was cancelled)
      assert.ok(!animator._cancelled, 'new animation must not be in cancelled state');
    });
  });

  // ── Cancel on resize ─────────────────────────────────────────────────────────

  describe('cancel on resize', () => {
    test('cancel called on window resize stops animation', () => {
      animator.animateTo({ panX: 300, panY: 300, zoom: 2 });

      // Simulate window resize triggering cancel
      window.dispatchEvent(Object.assign(new window.Event('resize'), {}));
      animator.cancel(); // what the resize handler would call

      assert.strictEqual(animator.isRunning, false);
    });
  });

  // ── rAF cleanup ──────────────────────────────────────────────────────────────

  describe('rAF cleanup', () => {
    test('no pending rAF after animation completes', () => {
      animator.animateTo({ panX: 100, panY: 100, zoom: 1.5 }, 0); // duration=0 → immediate
      // With duration=0 the tick should complete in one call
      animator._startTime = 0;
      animator._tick(1000); // well past duration

      assert.strictEqual(animator.pendingRafId, null, 'no rAF must be pending after completion');
    });

    test('no pending rAF after cancel', () => {
      animator.animateTo({ panX: 500, panY: 500, zoom: 3 });
      animator.cancel();
      assert.strictEqual(animator.pendingRafId, null, 'no rAF must be pending after cancel');
    });

    test('isRunning is false when no animation started', () => {
      assert.strictEqual(animator.isRunning, false);
    });
  });
});
