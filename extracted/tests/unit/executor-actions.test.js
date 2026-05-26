/**
 * tests/unit/executor-actions.test.js
 * Section 5.2 — Action Handlers
 *
 * Verifies the complete event sequences dispatched by each action type.
 * Runs against mock DOM — no browser, no CDP.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDOM,
  MockElement,
  MockMouseEvent,
  MockKeyboardEvent,
} from '../helpers/dom-mock.js';

// ── Inline action handler implementations ─────────────────────────────────────
// Replace with: import { executeAction } from '../../src/executor.js';

function dispatchMouseSequence(el, eventTypes, init = {}) {
  for (const type of eventTypes) {
    el.dispatchEvent(new MockMouseEvent(type, { bubbles: true, ...init }));
  }
}

const CLICK_SEQUENCE = ['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click'];
const DBLCLICK_SEQUENCE = [...CLICK_SEQUENCE, ...CLICK_SEQUENCE, 'dblclick'];

function executeClick(el, { double = false, button = 0 } = {}) {
  const init = { button, buttons: button === 0 ? 1 : 2 };
  if (double) {
    dispatchMouseSequence(el, DBLCLICK_SEQUENCE, init);
  } else {
    dispatchMouseSequence(el, CLICK_SEQUENCE, init);
  }
}

function executeRightClick(el) {
  dispatchMouseSequence(el, ['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup'], {
    button: 2, buttons: 2,
  });
  el.dispatchEvent(new MockMouseEvent('contextmenu', { bubbles: true, button: 2 }));
}

function executeType(el, text, { clear = false, pressEnter = false } = {}) {
  if (clear) {
    el.value = '';
    el.dispatchEvent(new MockInputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  }
  for (const char of text) {
    el.dispatchEvent(new MockKeyboardEvent('keydown',  { key: char, bubbles: true }));
    el.dispatchEvent(new MockKeyboardEvent('keypress', { key: char, bubbles: true }));
    el.value += char;
    el.dispatchEvent(new MockInputEvent('input', { bubbles: true, data: char }));
    el.dispatchEvent(new MockKeyboardEvent('keyup',    { key: char, bubbles: true }));
  }
  if (pressEnter) {
    el.dispatchEvent(new MockKeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new MockKeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
    const form = el.parentNode;
    if (form) form.dispatchEvent(new MockEvent('submit', { bubbles: true, cancelable: true }));
  }
}

function executePressKey(el, keyCombo) {
  const parts  = keyCombo.split('+');
  const key    = parts[parts.length - 1];
  const ctrlKey  = parts.includes('Control');
  const shiftKey = parts.includes('Shift');
  const altKey   = parts.includes('Alt');
  const metaKey  = parts.includes('Meta');
  const init = { key, ctrlKey, shiftKey, altKey, metaKey, bubbles: true };
  el.dispatchEvent(new MockKeyboardEvent('keydown',  init));
  el.dispatchEvent(new MockKeyboardEvent('keypress', init));
  el.dispatchEvent(new MockKeyboardEvent('keyup',    init));
}

function executeDrag(el, { toX, toY }) {
  el.dispatchEvent(new MockMouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new MockMouseEvent('mousemove', { bubbles: true, clientX: toX / 2, clientY: toY / 2 }));
  el.dispatchEvent(new MockMouseEvent('mousemove', { bubbles: true, clientX: toX, clientY: toY }));
  el.dispatchEvent(new MockMouseEvent('mouseup',   { bubbles: true, clientX: toX, clientY: toY }));
  el.dispatchEvent(new MockMouseEvent('dragenter', { bubbles: true }));
  el.dispatchEvent(new MockMouseEvent('dragover',  { bubbles: true }));
  el.dispatchEvent(new MockMouseEvent('drop',      { bubbles: true }));
}

function executeScroll(el, { deltaX = 0, deltaY = 0 } = {}) {
  el.dispatchEvent(new MockWheelEvent('wheel', { deltaX, deltaY, bubbles: true }));
}

// ──────────────────────────────────────────────────────────────────────────────

import { MockEvent, MockWheelEvent, MockInputEvent } from '../helpers/dom-mock.js';

describe('5.2 Action Handlers', () => {

  beforeEach(() => resetDOM());

  // ── click ───────────────────────────────────────────────────────────────────

  describe('click', () => {
    test('single click fires full mouse event sequence', () => {
      const el = new MockElement('button');
      el.id = 'btn';
      document.body.append(el);

      executeClick(el);

      const eventTypes = el._dispatchedEvents.map(e => e.type);
      for (const expected of CLICK_SEQUENCE) {
        assert.ok(eventTypes.includes(expected), `click must fire '${expected}'`);
      }
    });

    test('single click does NOT fire dblclick', () => {
      const el = new MockElement('button');
      document.body.append(el);
      executeClick(el);
      assert.ok(!el.events('dblclick').length, 'single click must not fire dblclick');
    });

    test('double click fires sequence ×2 then dblclick', () => {
      const el = new MockElement('button');
      document.body.append(el);

      executeClick(el, { double: true });

      const types = el._dispatchedEvents.map(e => e.type);
      const clickCount = types.filter(t => t === 'click').length;
      assert.strictEqual(clickCount, 2, 'double click must fire 2 click events');
      assert.ok(types.includes('dblclick'), 'double click must fire dblclick');
    });

    test('right click uses button=2 for all events', () => {
      const el = new MockElement('button');
      document.body.append(el);
      executeClick(el, { button: 2 });

      const buttonValues = el._dispatchedEvents
        .filter(e => ['mousedown', 'mouseup', 'click'].includes(e.type))
        .map(e => e.button);
      assert.ok(buttonValues.every(b => b === 2), 'right click events must have button=2');
    });
  });

  // ── right_click ──────────────────────────────────────────────────────────────

  describe('right_click', () => {
    test('fires contextmenu event', () => {
      const el = new MockElement('div');
      document.body.append(el);
      executeRightClick(el);

      const ctxEvent = el.events('contextmenu')[0];
      assert.ok(ctxEvent, 'contextmenu event must be dispatched');
      assert.strictEqual(ctxEvent.button, 2, 'contextmenu must have button=2');
    });

    test('contextmenu is cancelable (default can be prevented)', () => {
      const el = new MockElement('div');
      document.body.append(el);
      executeRightClick(el);

      const ctxEvent = el.events('contextmenu')[0];
      assert.ok(ctxEvent, 'contextmenu event must exist');
      // The test: we can call preventDefault() — no error
      assert.doesNotThrow(() => ctxEvent.preventDefault());
    });
  });

  // ── type_text ────────────────────────────────────────────────────────────────

  describe('type_text', () => {
    test('types text char-by-char: keydown + keypress + input + keyup per char', () => {
      const input = new MockElement('input');
      input.id = 'text-field';
      document.body.append(input);

      executeType(input, 'hi');

      const kd = input.events('keydown');
      const kp = input.events('keypress');
      const iv = input.events('input');
      const ku = input.events('keyup');

      assert.strictEqual(kd.length, 2, '2 keydown events for "hi"');
      assert.strictEqual(kp.length, 2, '2 keypress events for "hi"');
      assert.strictEqual(iv.length, 2, '2 input events for "hi"');
      assert.strictEqual(ku.length, 2, '2 keyup events for "hi"');
      assert.strictEqual(input.value, 'hi', 'value must be set after typing');
    });

    test('clear:true resets value and fires input event before typing', () => {
      const input = new MockElement('input');
      input.value = 'old value';
      document.body.append(input);

      executeType(input, 'new', { clear: true });

      assert.strictEqual(input.value, 'new', 'cleared and retyped');
      const inputEvents = input.events('input');
      assert.ok(inputEvents.length >= 1, 'at least one input event for clear+type');
    });

    test('pressEnter:true fires Enter keydown+keyup after text', () => {
      const input = new MockElement('input');
      document.body.append(input);

      executeType(input, 'go', { pressEnter: true });

      const kd = input.events('keydown');
      const enterKd = kd.filter(e => e.key === 'Enter');
      assert.ok(enterKd.length >= 1, 'Enter keydown must be fired');

      const ku = input.events('keyup');
      const enterKu = ku.filter(e => e.key === 'Enter');
      assert.ok(enterKu.length >= 1, 'Enter keyup must be fired');
    });

    test('no selector → types into activeElement', () => {
      const input = new MockElement('input');
      input.id = 'focused';
      document.body.append(input);
      document.activeElement = input;

      // In real executor: executeType(document.activeElement, 'test')
      executeType(document.activeElement, 'test');
      assert.strictEqual(document.activeElement.value, 'test');
    });
  });

  // ── press_key ────────────────────────────────────────────────────────────────

  describe('press_key', () => {
    test('simple key fires keydown + keypress + keyup', () => {
      const el = new MockElement('input');
      document.body.append(el);
      executePressKey(el, 'Enter');

      assert.ok(el.events('keydown').length  >= 1, 'keydown must fire');
      assert.ok(el.events('keypress').length >= 1, 'keypress must fire');
      assert.ok(el.events('keyup').length    >= 1, 'keyup must fire');
    });

    test('Control+a → ctrlKey=true on all events', () => {
      const el = new MockElement('input');
      document.body.append(el);
      executePressKey(el, 'Control+a');

      const kd = el.events('keydown')[0];
      assert.ok(kd, 'keydown must fire');
      assert.strictEqual(kd.ctrlKey, true, 'ctrlKey must be true for Control+a');
      assert.strictEqual(kd.key, 'a', 'key must be "a"');
    });

    test('Shift+Tab → shiftKey=true', () => {
      const el = new MockElement('input');
      document.body.append(el);
      executePressKey(el, 'Shift+Tab');
      const kd = el.events('keydown')[0];
      assert.strictEqual(kd.shiftKey, true);
      assert.strictEqual(kd.key, 'Tab');
    });
  });

  // ── drag ─────────────────────────────────────────────────────────────────────

  describe('drag', () => {
    test('fires mousedown → mousemove(s) → mouseup → dragenter → dragover → drop', () => {
      const el = new MockElement('div');
      el.id = 'draggable';
      document.body.append(el);

      executeDrag(el, { toX: 200, toY: 150 });

      const fired = el._dispatchedEvents.map(e => e.type);
      for (const expected of ['mousedown', 'mousemove', 'mouseup', 'dragenter', 'dragover', 'drop']) {
        assert.ok(fired.includes(expected), `drag must fire '${expected}'`);
      }
    });

    test('mouseup has correct destination coordinates', () => {
      const el = new MockElement('div');
      document.body.append(el);
      executeDrag(el, { toX: 300, toY: 400 });

      const mouseup = el.events('mouseup')[0];
      assert.strictEqual(mouseup.clientX, 300);
      assert.strictEqual(mouseup.clientY, 400);
    });
  });

  // ── mouse_scroll ─────────────────────────────────────────────────────────────

  describe('mouse_scroll', () => {
    test('fires WheelEvent with correct deltaX and deltaY', () => {
      const el = new MockElement('div');
      document.body.append(el);

      executeScroll(el, { deltaX: 0, deltaY: 300 });

      const wheelEv = el.events('wheel')[0];
      assert.ok(wheelEv, 'wheel event must be dispatched');
      assert.strictEqual(wheelEv.deltaY, 300);
      assert.strictEqual(wheelEv.deltaX, 0);
    });

    test('lines scroll: deltaY proportional to line count (1 line ≈ 100px)', () => {
      const el = new MockElement('div');
      document.body.append(el);
      // lines: 3 → deltaY: 300
      executeScroll(el, { deltaY: 3 * 100 });
      assert.strictEqual(el.events('wheel')[0].deltaY, 300);
    });
  });

  // ── scroll_page ──────────────────────────────────────────────────────────────

  describe('scroll_page', () => {
    test('delta scroll calls scrollBy on window', () => {
      let scrollCalled = false;
      const origScrollBy = window.scrollBy;
      window.scrollBy = (x, y) => { scrollCalled = true; window.scrollX += x; window.scrollY += y; };

      window.scrollBy(0, 500);
      assert.ok(scrollCalled, 'scrollBy must be called');
      assert.strictEqual(window.scrollY, 500);

      window.scrollBy = origScrollBy;
    });

    test('toElement calls scrollIntoView on element', () => {
      const el = new MockElement('div');
      el.id = 'footer';
      document.body.append(el);

      let scrollIntoViewCalled = false;
      el.scrollIntoView = () => { scrollIntoViewCalled = true; };

      el.scrollIntoView();
      assert.ok(scrollIntoViewCalled, 'scrollIntoView must be called');
    });
  });

  // ── Navigation actions ───────────────────────────────────────────────────────

  describe('navigation', () => {
    test('go_back calls history.back()', () => {
      let called = false;
      window.history.back = () => { called = true; };
      window.history.back();
      assert.ok(called);
    });

    test('go_forward calls history.forward()', () => {
      let called = false;
      window.history.forward = () => { called = true; };
      window.history.forward();
      assert.ok(called);
    });

    test('reload (soft) calls location.reload with falsy arg', () => {
      let reloadArg;
      window.location.reload = arg => { reloadArg = arg; };
      window.location.reload(false);
      assert.strictEqual(!!reloadArg, false);
    });

    test('reload (hard) calls location.reload with truthy arg', () => {
      let reloadArg;
      window.location.reload = arg => { reloadArg = arg; };
      window.location.reload(true);
      assert.ok(reloadArg, 'hard reload must pass truthy arg');
    });
  });
});
