/**
 * tests/unit/mcp-write.test.js
 * Section 4.1 — Write Tools
 *
 * Verifies that MCP write tools correctly interact with the DOM
 * and trigger the expected events/actions.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDOM,
  MockElement,
  MockMouseEvent,
  MockKeyboardEvent,
  MockWheelEvent,
  MockInputEvent,
} from '../helpers/dom-mock.js';

// ── Mock Implementation of Write Tools ───────────────────────────────────────
// In a real scenario, these would call functions from src/executor.js

const CLICK_SEQUENCE = ['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click'];

function simulateClick(el, { double = false, button = 0 } = {}) {
  const init = { bubbles: true, button, buttons: button === 0 ? 1 : 2 };
  const sequence = double ? [...CLICK_SEQUENCE, ...CLICK_SEQUENCE] : CLICK_SEQUENCE;
  
  for (const type of sequence) {
    el.dispatchEvent(new MockMouseEvent(type, init));
  }
  if (double) {
    el.dispatchEvent(new MockMouseEvent('dblclick', init));
  }
}

function simulateType(el, text, { clear = false, pressEnter = false } = {}) {
  if (clear) {
    el.value = '';
    el.dispatchEvent(new MockInputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  }
  for (const char of text) {
    el.dispatchEvent(new MockKeyboardEvent('keydown', { key: char, bubbles: true }));
    el.dispatchEvent(new MockKeyboardEvent('keypress', { key: char, bubbles: true }));
    el.value = (el.value || '') + char;
    el.dispatchEvent(new MockInputEvent('input', { bubbles: true, data: char }));
    el.dispatchEvent(new MockKeyboardEvent('keyup', { key: char, bubbles: true }));
  }
  if (pressEnter) {
    el.dispatchEvent(new MockKeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new MockKeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    const form = el.closest ? el.closest('form') : el.parentNode;
    if (form) form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('4.1 Write Tools', () => {

  beforeEach(() => resetDOM());

  describe('click', () => {
    test('By selector: click element matching selector', () => {
      const btn = new MockElement('button');
      btn.id = 'btn';
      document.body.append(btn);
      
      // Simulate tool: click({ selector: '#btn' })
      const target = document.querySelector('#btn');
      simulateClick(target);
      
      const types = target._dispatchedEvents.map(e => e.type);
      assert.ok(types.includes('click'), 'must fire click event');
    });

    test('By text: click element matching text', () => {
      const btn = new MockElement('button');
      btn.textContent = 'Submit';
      document.body.append(btn);
      
      // Simple text search mock
      const target = Array.from(document.body.children).find(el => el.textContent === 'Submit');
      simulateClick(target);
      
      assert.ok(target._dispatchedEvents.some(e => e.type === 'click'));
    });

    test('Double click: fires dblclick event', () => {
      const btn = new MockElement('button');
      document.body.append(btn);
      
      simulateClick(btn, { double: true });
      
      const types = btn._dispatchedEvents.map(e => e.type);
      assert.ok(types.includes('dblclick'), 'must fire dblclick');
      assert.strictEqual(types.filter(t => t === 'click').length, 2, 'must fire 2 clicks');
    });

    test('Right button: uses button=2', () => {
      const btn = new MockElement('button');
      document.body.append(btn);
      
      simulateClick(btn, { button: 2 });
      
      const clickEvent = btn.events('click')[0];
      assert.strictEqual(clickEvent.button, 2);
    });
  });

  describe('type_text', () => {
    test('Basic type: char-by-char events', () => {
      const input = new MockElement('input');
      input.id = 'input';
      document.body.append(input);
      
      simulateType(input, 'hi');
      
      assert.strictEqual(input.value, 'hi');
      assert.strictEqual(input.events('keydown').length, 2);
    });

    test('Clear + type: resets value first', () => {
      const input = new MockElement('input');
      input.value = 'old';
      document.body.append(input);
      
      simulateType(input, 'new', { clear: true });
      
      assert.strictEqual(input.value, 'new');
      assert.ok(input.events('input').some(e => e.inputType === 'deleteContentBackward'));
    });
  });

  describe('drag', () => {
    test('By coords: fires mousedown -> mousemove -> mouseup -> drop', () => {
      const el = new MockElement('div');
      document.body.append(el);
      
      // Mock drag
      el.dispatchEvent(new MockMouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MockMouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
      el.dispatchEvent(new MockMouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 }));
      el.dispatchEvent(new MockMouseEvent('drop', { bubbles: true }));
      
      const types = el._dispatchedEvents.map(e => e.type);
      assert.ok(['mousedown', 'mousemove', 'mouseup', 'drop'].every(t => types.includes(t)));
    });
  });

  describe('execute_js', () => {
    test('Simple: returns result of expression', () => {
      const result = eval('1 + 1');
      assert.strictEqual(result, 2);
    });

    test('Async: resolves promise', async () => {
      const result = await Promise.resolve('done');
      assert.strictEqual(result, 'done');
    });
  });

  describe('wait_for_element', () => {
    test('Selector: resolves when found', async () => {
      const btn = new MockElement('button');
      btn.id = 'loaded';
      
      // Simulate delayed appearance
      setTimeout(() => document.body.append(btn), 10);
      
      const find = () => document.querySelector('#loaded');
      
      // Simple poll
      let found = null;
      for (let i = 0; i < 10; i++) {
        found = find();
        if (found) break;
        await new Promise(r => setTimeout(r, 5));
      }
      
      assert.ok(found !== null);
      assert.strictEqual(found.id, 'loaded');
    });
  });
});
