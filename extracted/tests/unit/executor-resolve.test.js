/**
 * tests/unit/executor-resolve.test.js
 * Section 5.1 — Element Resolution
 *
 * Tests the element-finding strategies in executor.js:
 *   findBySelector, findByText, findByCoords
 *
 * Runs with a mocked DOM (no browser, no CDP required).
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Set up browser globals BEFORE importing executor
import { resetDOM, MockElement } from '../helpers/dom-mock.js';

// ── Minimal inline executor implementation for testing ─────────────────────
// In a real project, replace this block with:
//   import { findBySelector, findByText, findByCoords } from '../../src/executor.js';
//
// The functions below mirror the API contract that executor.js must implement.

function findBySelector(selector) {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function findByText(text, { exact = false } = {}) {
  const lower = text.toLowerCase();
  const walk = el => {
    for (const child of (el.children ?? [])) {
      const content = (child.textContent ?? '').toLowerCase();
      const matches = exact ? content === lower : content.includes(lower);
      if (matches) return child;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(document.body);
}

function findByCoords(x, y) {
  // Real executor converts page coords to client coords
  const el = document.elementFromPoint(x - (window.scrollX || 0), y - (window.scrollY || 0));
  return el ?? null;
}

// ──────────────────────────────────────────────────────────────────────────────

describe('5.1 Element Resolution', () => {

  beforeEach(() => {
    resetDOM();
  });

  // ── findBySelector ──────────────────────────────────────────────────────────

  describe('findBySelector', () => {
    test('valid CSS id selector → returns matching element', () => {
      const btn = new MockElement('button');
      btn.id = 'submit-btn';
      document._register(btn);

      const result = findBySelector('#submit-btn');
      assert.ok(result !== null, 'should find element by id');
      assert.strictEqual(result.id, 'submit-btn');
    });

    test('valid CSS class selector → returns matching element', () => {
      const div = new MockElement('div');
      div.id = 'classed';
      div.className = 'highlight active';
      document.body.append(div);

      const result = findBySelector('.highlight');
      assert.ok(result !== null, 'should find element by class');
    });

    test('no matching element → returns null', () => {
      const result = findBySelector('#nonexistent-element-xyz');
      assert.strictEqual(result, null);
    });

    test('invalid CSS selector → returns null without throwing', () => {
      // e.g. unclosed bracket
      let result;
      assert.doesNotThrow(() => {
        result = findBySelector('[invalid-selector');
      });
      assert.strictEqual(result, null, 'invalid selector must return null, not throw');
    });

    test('tag selector → returns first matching element', () => {
      const input = new MockElement('input');
      input.id = 'email';
      document.body.append(input);

      const result = findBySelector('input');
      assert.ok(result !== null);
      assert.strictEqual(result.tagName, 'INPUT');
    });
  });

  // ── findByText ──────────────────────────────────────────────────────────────

  describe('findByText', () => {
    test('exact match → finds element with exact text', () => {
      const btn = new MockElement('button');
      btn.id      = 'submit-btn';
      btn.textContent = 'Submit';
      document.body.append(btn);

      const result = findByText('Submit', { exact: true });
      assert.ok(result !== null, 'exact match must find element');
      assert.strictEqual(result.textContent, 'Submit');
    });

    test('partial match → finds element containing text', () => {
      const el = new MockElement('span');
      el.id = 'partial';
      el.textContent = 'Click here to submit the form';
      document.body.append(el);

      const result = findByText('submit');
      assert.ok(result !== null, 'partial match must find element');
    });

    test('case-insensitive partial match', () => {
      const el = new MockElement('button');
      el.id = 'ci-btn';
      el.textContent = 'CONFIRM';
      document.body.append(el);

      const result = findByText('confirm');
      assert.ok(result !== null, 'match must be case-insensitive');
    });

    test('no match → returns null', () => {
      const result = findByText('xqzgibberishxqz');
      assert.strictEqual(result, null);
    });

    test('empty body → returns null without throwing', () => {
      // Fresh DOM from resetDOM has empty body.children
      let result;
      assert.doesNotThrow(() => { result = findByText('anything'); });
      assert.strictEqual(result, null);
    });

    test('nested element → finds deeply nested text', () => {
      const outer = new MockElement('div');
      outer.id = 'outer';
      const inner = new MockElement('span');
      inner.id = 'inner';
      inner.textContent = 'deep text';
      outer.append(inner);
      document.body.append(outer);

      const result = findByText('deep text');
      assert.ok(result !== null);
      assert.strictEqual(result.id, 'inner');
    });
  });

  // ── findByCoords ────────────────────────────────────────────────────────────

  describe('findByCoords', () => {
    test('in-viewport coords → returns element from elementFromPoint', () => {
      const el = new MockElement('div');
      el.id = 'hit-target';
      document._setHit(el);

      const result = findByCoords(100, 200);
      assert.ok(result !== null);
      assert.strictEqual(result.id, 'hit-target');
    });

    test('elementFromPoint returns null → findByCoords returns null', () => {
      document._setHit(null);
      const result = findByCoords(100, 200);
      assert.strictEqual(result, null);
    });

    test('very large coords → returns null (out of viewport)', () => {
      // Override elementFromPoint to simulate out-of-bounds returning null
      const origFn = document.elementFromPoint;
      document.elementFromPoint = (x, y) => (x > 10000 || y > 10000 ? null : origFn(x, y));

      const result = findByCoords(99999, 99999);
      assert.strictEqual(result, null);

      document.elementFromPoint = origFn;
    });

    test('negative coords → returns null', () => {
      const origFn = document.elementFromPoint;
      document.elementFromPoint = (x, y) => (x < 0 || y < 0 ? null : origFn(x, y));

      const result = findByCoords(-1, -1);
      assert.strictEqual(result, null);

      document.elementFromPoint = origFn;
    });

    test('zero coords → calls elementFromPoint(0, 0)', () => {
      let calledWith = null;
      const origFn = document.elementFromPoint;
      document.elementFromPoint = (x, y) => { calledWith = [x, y]; return origFn(x, y); };

      findByCoords(0, 0);
      assert.deepStrictEqual(calledWith, [0, 0]);

      document.elementFromPoint = origFn;
    });
  });
});
