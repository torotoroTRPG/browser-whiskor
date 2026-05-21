/**
 * tests/unit/canvas-interact.test.js
 * Section 2.3 — Canvas Interaction (INTERACT mode)
 *
 * Verifies click/drag/scroll/zoom/pan dispatching and
 * correct page-coordinate transforms accounting for zoom and pan.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDOM,
  MockCanvasElement,
  MockMouseEvent,
  MockWheelEvent,
} from '../helpers/dom-mock.js';

// ── Inline CanvasInteraction implementation ───────────────────────────────────
// Replace with: import { CanvasInteraction } from '../../dashboard/canvas-interact.js';

class CanvasInteraction {
  constructor(canvas, opts = {}) {
    this._canvas     = canvas;
    this._interactMode = false;
    this._zoom       = opts.zoom ?? 1;
    this._panX       = opts.panX ?? 0;
    this._panY       = opts.panY ?? 0;
    this._liveVp     = opts.liveVp ?? { scrollX: 0, scrollY: 0 };
    this._dragStart  = null;
    this._isDragging = false;
    this._actions    = [];   // captured actions (for assertions)
    this._panned     = false;
    this._zoomed     = false;
    this._onAction   = opts.onAction ?? (a => this._actions.push(a));
  }

  setInteractMode(on) { this._interactMode = on; }

  // ── Coordinate transform ────────────────────────────────────────────────────

  /** Convert canvas-relative client coords to page coords. */
  _toPageCoords(clientX, clientY) {
    const rect = this._canvas.getBoundingClientRect();
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;
    // Reverse pan then reverse zoom
    const pageX = (canvasX - this._panX) / this._zoom + this._liveVp.scrollX;
    const pageY = (canvasY - this._panY) / this._zoom + this._liveVp.scrollY;
    return { x: Math.round(pageX), y: Math.round(pageY) };
  }

  handleMouseDown(e) {
    this._dragStart  = { x: e.clientX, y: e.clientY };
    this._isDragging = false;
  }

  handleMouseMove(e) {
    if (!this._dragStart) return;
    const dx = e.clientX - this._dragStart.x;
    const dy = e.clientY - this._dragStart.y;
    if (!this._isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      this._isDragging = true;
    }
    if (this._isDragging && !this._interactMode) {
      this._panX += dx;
      this._panY += dy;
      this._dragStart = { x: e.clientX, y: e.clientY };
      this._panned = true;
    }
  }

  handleMouseUp(e) {
    if (!this._dragStart) return;
    if (this._interactMode) {
      const coords = this._toPageCoords(e.clientX, e.clientY);
      if (this._isDragging) {
        const from = this._toPageCoords(this._dragStart.x, this._dragStart.y);
        this._onAction({ type: 'drag', fromX: from.x, fromY: from.y, toX: coords.x, toY: coords.y });
      } else {
        this._onAction({ type: 'click', ...coords });
      }
    }
    this._dragStart  = null;
    this._isDragging = false;
  }

  handleContextMenu(e) {
    e.preventDefault();
    if (this._interactMode) {
      const coords = this._toPageCoords(e.clientX, e.clientY);
      this._onAction({ type: 'right_click', ...coords });
    }
  }

  handleWheel(e) {
    e.preventDefault();
    if (this._interactMode) {
      const coords = this._toPageCoords(e.clientX, e.clientY);
      this._onAction({ type: 'mouse_scroll', ...coords, deltaX: e.deltaX, deltaY: e.deltaY });
    } else {
      // Zoom canvas towards cursor
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      this._zoom *= factor;
      this._zoomed = true;
    }
  }

  // ── Test helpers ────────────────────────────────────────────────────────────

  get lastAction()  { return this._actions[this._actions.length - 1]; }
  get allActions()  { return [...this._actions]; }
  get panX()        { return this._panX; }
  get panY()        { return this._panY; }
  get zoom()        { return this._zoom; }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('2.3 Canvas Interaction (INTERACT mode)', () => {

  let canvas, interact;

  beforeEach(() => {
    resetDOM();
    canvas   = new MockCanvasElement();
    // BoundingClientRect stub: top=0, left=0, so clientX == canvasX
    canvas.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 800, right: 1280, width: 1280, height: 800, x: 0, y: 0 });
    interact = new CanvasInteraction(canvas, { liveVp: { scrollX: 0, scrollY: 0 } });
    interact.setInteractMode(true);
  });

  // ── Click ───────────────────────────────────────────────────────────────────

  describe('click (INTERACT on)', () => {
    test('click sends action with correct page coordinates', () => {
      interact.handleMouseDown(new MockMouseEvent('mousedown', { clientX: 200, clientY: 300 }));
      interact.handleMouseUp(  new MockMouseEvent('mouseup',   { clientX: 200, clientY: 300 }));

      const action = interact.lastAction;
      assert.ok(action, 'action must be emitted');
      assert.strictEqual(action.type, 'click');
      assert.strictEqual(action.x, 200);
      assert.strictEqual(action.y, 300);
    });

    test('click at canvas edge still produces correct coords', () => {
      interact.handleMouseDown(new MockMouseEvent('mousedown', { clientX: 1279, clientY: 799 }));
      interact.handleMouseUp(  new MockMouseEvent('mouseup',   { clientX: 1279, clientY: 799 }));
      const action = interact.lastAction;
      assert.strictEqual(action.type, 'click');
      assert.strictEqual(action.x, 1279);
      assert.strictEqual(action.y, 799);
    });
  });

  // ── Coordinate transform with zoom/pan ───────────────────────────────────────

  describe('coordinate transform', () => {
    test('click with zoom=2 produces correct page coords', () => {
      interact = new CanvasInteraction(canvas, {
        zoom: 2, panX: 0, panY: 0,
        liveVp: { scrollX: 0, scrollY: 0 },
      });
      interact.setInteractMode(true);
      canvas.getBoundingClientRect = () => ({ top:0,left:0,bottom:800,right:1280,width:1280,height:800,x:0,y:0 });

      // canvas pixel 200,300 with zoom=2 → page 100,150
      interact.handleMouseDown(new MockMouseEvent('mousedown', { clientX: 200, clientY: 300 }));
      interact.handleMouseUp(  new MockMouseEvent('mouseup',   { clientX: 200, clientY: 300 }));

      assert.strictEqual(interact.lastAction.x, 100, 'page x = canvasX / zoom');
      assert.strictEqual(interact.lastAction.y, 150, 'page y = canvasY / zoom');
    });

    test('click with panX=100 accounts for pan offset', () => {
      interact = new CanvasInteraction(canvas, {
        zoom: 1, panX: 100, panY: 0,
        liveVp: { scrollX: 0, scrollY: 0 },
      });
      interact.setInteractMode(true);
      canvas.getBoundingClientRect = () => ({ top:0,left:0,bottom:800,right:1280,width:1280,height:800,x:0,y:0 });

      interact.handleMouseDown(new MockMouseEvent('mousedown', { clientX: 200, clientY: 100 }));
      interact.handleMouseUp(  new MockMouseEvent('mouseup',   { clientX: 200, clientY: 100 }));

      // pageX = (200 - panX=100) / zoom=1 + scrollX=0 = 100
      assert.strictEqual(interact.lastAction.x, 100);
    });

    test('click with scrollX offset included in page coords', () => {
      interact = new CanvasInteraction(canvas, {
        zoom: 1, panX: 0, panY: 0,
        liveVp: { scrollX: 500, scrollY: 250 },
      });
      interact.setInteractMode(true);
      canvas.getBoundingClientRect = () => ({ top:0,left:0,bottom:800,right:1280,width:1280,height:800,x:0,y:0 });

      interact.handleMouseDown(new MockMouseEvent('mousedown', { clientX: 100, clientY: 100 }));
      interact.handleMouseUp(  new MockMouseEvent('mouseup',   { clientX: 100, clientY: 100 }));

      assert.strictEqual(interact.lastAction.x, 600, 'pageX = canvasX + scrollX');
      assert.strictEqual(interact.lastAction.y, 350, 'pageY = canvasY + scrollY');
    });
  });

  // ── Drag ────────────────────────────────────────────────────────────────────

  describe('drag (INTERACT on)', () => {
    test('drag > 5px sends drag action with fromX/fromY/toX/toY', () => {
      interact.handleMouseDown(new MockMouseEvent('mousedown', { clientX: 100, clientY: 100 }));
      interact.handleMouseMove(new MockMouseEvent('mousemove', { clientX: 110, clientY: 110 })); // 10px
      interact.handleMouseUp(  new MockMouseEvent('mouseup',   { clientX: 200, clientY: 250 }));

      const action = interact.lastAction;
      assert.strictEqual(action.type, 'drag');
      assert.ok('fromX' in action && 'fromY' in action, 'drag must have from coords');
      assert.ok('toX'   in action && 'toY'   in action, 'drag must have to coords');
    });

    test('small movement (≤5px) is treated as click, not drag', () => {
      interact.handleMouseDown(new MockMouseEvent('mousedown', { clientX: 100, clientY: 100 }));
      interact.handleMouseMove(new MockMouseEvent('mousemove', { clientX: 103, clientY: 103 })); // 3px
      interact.handleMouseUp(  new MockMouseEvent('mouseup',   { clientX: 103, clientY: 103 }));

      assert.strictEqual(interact.lastAction?.type, 'click', 'small move must be click');
    });
  });

  // ── Right-click ──────────────────────────────────────────────────────────────

  describe('right_click (INTERACT on)', () => {
    test('contextmenu sends right_click action', () => {
      const e = new MockMouseEvent('contextmenu', { clientX: 400, clientY: 200, button: 2 });
      let prevented = false;
      e.preventDefault = () => { prevented = true; };
      interact.handleContextMenu(e);

      assert.ok(prevented,  'default context menu must be prevented');
      assert.strictEqual(interact.lastAction?.type, 'right_click');
      assert.strictEqual(interact.lastAction.x, 400);
      assert.strictEqual(interact.lastAction.y, 200);
    });
  });

  // ── Scroll (INTERACT on) ────────────────────────────────────────────────────

  describe('mouse_scroll (INTERACT on)', () => {
    test('wheel sends mouse_scroll action with delta', () => {
      const e = new MockWheelEvent('wheel', { clientX: 300, clientY: 200, deltaX: 0, deltaY: 120 });
      e.preventDefault = () => {};
      interact.handleWheel(e);

      const action = interact.lastAction;
      assert.strictEqual(action.type, 'mouse_scroll');
      assert.strictEqual(action.deltaY, 120);
      assert.strictEqual(action.x, 300);
    });

    test('wheel does NOT zoom canvas in INTERACT mode', () => {
      const before = interact.zoom;
      const e = new MockWheelEvent('wheel', { clientX: 300, clientY: 200, deltaY: -120 });
      e.preventDefault = () => {};
      interact.handleWheel(e);
      assert.strictEqual(interact.zoom, before, 'zoom must not change in interact mode');
    });
  });

  // ── Non-INTERACT mode ────────────────────────────────────────────────────────

  describe('pan & zoom (INTERACT off)', () => {
    beforeEach(() => interact.setInteractMode(false));

    test('drag pans canvas, does NOT send action', () => {
      interact.handleMouseDown(new MockMouseEvent('mousedown', { clientX: 100, clientY: 100 }));
      interact.handleMouseMove(new MockMouseEvent('mousemove', { clientX: 150, clientY: 160 }));
      interact.handleMouseUp(  new MockMouseEvent('mouseup',   { clientX: 150, clientY: 160 }));

      assert.strictEqual(interact.allActions.length, 0, 'no action must be sent when not in interact mode');
      assert.ok(interact._panned, 'canvas must have been panned');
    });

    test('wheel zooms canvas, does NOT send action', () => {
      const before = interact.zoom;
      const e = new MockWheelEvent('wheel', { clientX: 300, clientY: 200, deltaY: -120 });
      e.preventDefault = () => {};
      interact.handleWheel(e);

      assert.ok(interact.zoom !== before, 'zoom must change when not in interact mode');
      assert.strictEqual(interact.allActions.length, 0, 'no action must be sent');
    });

    test('wheel down decreases zoom', () => {
      interact.handleWheel(Object.assign(new MockWheelEvent('wheel', { deltaY: 120 }), { preventDefault(){} }));
      assert.ok(interact.zoom < 1, 'scroll down must decrease zoom');
    });

    test('wheel up increases zoom', () => {
      interact.handleWheel(Object.assign(new MockWheelEvent('wheel', { deltaY: -120 }), { preventDefault(){} }));
      assert.ok(interact.zoom > 1, 'scroll up must increase zoom');
    });
  });
});
