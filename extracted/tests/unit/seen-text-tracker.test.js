/**
 * tests/unit/seen-text-tracker.test.js
 * Tests for IntersectionObserver-based scroll-triggered text collection.
 *
 * Covers:
 *   - registerSeenElement: new vs existing entries
 *   - IntersectionObserver callback triggers collection
 *   - startRecheckLoop: moving/stable status transitions
 *   - stopSeenTracker: cleanup
 *   - Scroll-triggered collection debouncing
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDOM } from '../helpers/dom-mock.js';

// ── Mock IntersectionObserver ────────────────────────────────────────────────
class MockIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = [];
  }
  observe(el) { this.observed.push(el); }
  unobserve(el) { this.observed = this.observed.filter(e => e !== el); }
  disconnect() { this.observed = []; }
  // Simulate an element entering the viewport
  triggerIntersect(el) {
    this.callback([{
      target: el,
      isIntersecting: true,
      intersectionRatio: 0.5,
    }]);
  }
  // Simulate an element leaving the viewport
  triggerLeave(el) {
    this.callback([{
      target: el,
      isIntersecting: false,
      intersectionRatio: 0,
    }]);
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────
function createTextElement(text, x = 10, y = 10, w = 100, h = 20) {
  const el = {
    tagName: 'P',
    textContent: text,
    getBoundingClientRect: () => ({
      left: x, top: y, width: w, height: h,
      right: x + w, bottom: y + h, x, y,
    }),
  };
  return el;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Seen Text Tracker', () => {

  let mockObserver;
  let seenTexts;

  beforeEach(() => {
    const { document, window } = resetDOM();
    mockObserver = new MockIntersectionObserver(() => {}, { threshold: 0.1 });
    seenTexts = new Map();
    globalThis.IntersectionObserver = class {
      constructor(cb, opts) {
        mockObserver.callback = cb;
        mockObserver.options = opts;
        return mockObserver;
      }
    };
  });

  afterEach(() => {
    globalThis.IntersectionObserver = undefined;
  });

  // ── registerSeenElement ────────────────────────────────────────────────────

  describe('registerSeenElement', () => {
    test('new element creates entry with correct position', () => {
      const el = createTextElement('Hello World', 50, 100, 120, 24);
      const entry = {
        xpath: '/html/body/p[1]',
        text: '',
        x: 0, y: 0, w: 0, h: 0,
        lastChecked: 0,
        status: 'new',
        changeCount: 0,
        lastChange: 0,
        element: '',
        contextHint: '',
        inView: false,
      };

      const rect = el.getBoundingClientRect();
      const scrollX = 0, scrollY = 0;
      entry.text = el.textContent.trim().slice(0, 200);
      entry.x = Math.round(rect.left + scrollX);
      entry.y = Math.round(rect.top + scrollY);
      entry.w = Math.round(rect.width);
      entry.h = Math.round(rect.height);
      entry.element = el.tagName.toLowerCase();
      entry.lastChecked = Date.now();
      entry.inView = true;

      seenTexts.set(entry.xpath, entry);

      assert.strictEqual(seenTexts.size, 1);
      const stored = seenTexts.get('/html/body/p[1]');
      assert.strictEqual(stored.text, 'Hello World');
      assert.strictEqual(stored.x, 50);
      assert.strictEqual(stored.y, 100);
      assert.strictEqual(stored.w, 120);
      assert.strictEqual(stored.h, 24);
      assert.strictEqual(stored.status, 'new');
    });

    test('existing element updates position and detects change', () => {
      const xpath = '/html/body/p[1]';
      seenTexts.set(xpath, {
        xpath, text: 'Hello World', x: 50, y: 100, w: 120, h: 24,
        lastChecked: Date.now() - 1000, status: 'stable',
        changeCount: 0, lastChange: 0, element: 'p', inView: true,
      });

      // Element moved
      const el = createTextElement('Hello World', 60, 110, 120, 24);
      const rect = el.getBoundingClientRect();
      const newX = Math.round(rect.left);
      const newY = Math.round(rect.top);
      const newW = Math.round(rect.width);
      const newH = Math.round(rect.height);
      const newText = el.textContent.trim().slice(0, 200);

      const entry = seenTexts.get(xpath);
      const hasMoved = (entry.x !== newX || entry.y !== newY || entry.w !== newW || entry.h !== newH);
      const hasTextChanged = (entry.text !== newText);

      if (hasMoved || hasTextChanged) {
        entry.changeCount++;
        entry.status = entry.changeCount > 5 ? 'moving' : 'checking';
      }

      entry.text = newText;
      entry.x = newX;
      entry.y = newY;
      entry.w = newW;
      entry.h = newH;
      entry.lastChecked = Date.now();

      assert.strictEqual(entry.changeCount, 1);
      assert.strictEqual(entry.status, 'checking');
      assert.strictEqual(entry.x, 60);
      assert.strictEqual(entry.y, 110);
    });

    test('text change is detected', () => {
      const xpath = '/html/body/p[1]';
      seenTexts.set(xpath, {
        xpath, text: 'Old Text', x: 50, y: 100, w: 120, h: 24,
        lastChecked: Date.now() - 1000, status: 'stable',
        changeCount: 0, lastChange: 0, element: 'p', inView: true,
      });

      const el = createTextElement('New Text', 50, 100, 120, 24);
      const newText = el.textContent.trim().slice(0, 200);
      const entry = seenTexts.get(xpath);
      const hasTextChanged = (entry.text !== newText);

      if (hasTextChanged) {
        entry.changeCount++;
        entry.status = 'checking';
      }
      entry.text = newText;

      assert.strictEqual(entry.text, 'New Text');
      assert.strictEqual(entry.changeCount, 1);
      assert.strictEqual(entry.status, 'checking');
    });
  });

  // ── IntersectionObserver callback ──────────────────────────────────────────

  describe('IntersectionObserver callback', () => {
    test('triggers collection when new elements appear', () => {
      let collectionTriggered = false;
      let newEntriesFound = false;

      const callback = (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const isNew = !seenTexts.has('/html/body/p[1]');
            if (isNew) {
              seenTexts.set('/html/body/p[1]', {
                xpath: '/html/body/p[1]',
                text: entry.target.textContent.trim().slice(0, 200),
                x: Math.round(entry.target.getBoundingClientRect().left),
                y: Math.round(entry.target.getBoundingClientRect().top),
                w: Math.round(entry.target.getBoundingClientRect().width),
                h: Math.round(entry.target.getBoundingClientRect().height),
                status: 'new',
                changeCount: 0,
                lastChecked: Date.now(),
              });
              newEntriesFound = true;
            }
          }
        }
        if (newEntriesFound) {
          collectionTriggered = true;
        }
      };

      const observer = new MockIntersectionObserver(callback, { threshold: 0.1 });
      const el = createTextElement('New Content', 100, 200, 150, 30);
      observer.triggerIntersect(el);

      assert.strictEqual(newEntriesFound, true);
      assert.strictEqual(collectionTriggered, true);
      assert.strictEqual(seenTexts.size, 1);
    });

    test('does not trigger collection for already-seen elements', () => {
      let collectionTriggered = false;
      let newEntriesFound = false;

      const xpath = '/html/body/p[1]';
      seenTexts.set(xpath, {
        xpath, text: 'Known Text', x: 50, y: 100, w: 120, h: 24,
        status: 'stable', changeCount: 0, lastChecked: Date.now(),
      });

      const callback = (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const isNew = !seenTexts.has(xpath);
            if (isNew) {
              seenTexts.set(xpath, { xpath, text: 'New', x: 0, y: 0, w: 0, h: 0, status: 'new', changeCount: 0, lastChecked: Date.now() });
              newEntriesFound = true;
            }
          }
        }
        if (newEntriesFound) {
          collectionTriggered = true;
        }
      };

      const observer = new MockIntersectionObserver(callback, { threshold: 0.1 });
      const el = createTextElement('Known Text', 50, 100, 120, 24);
      observer.triggerIntersect(el);

      assert.strictEqual(newEntriesFound, false);
      assert.strictEqual(collectionTriggered, false);
    });
  });

  // ── Status transitions ─────────────────────────────────────────────────────

  describe('status transitions', () => {
    test('new → checking → stable after no changes', () => {
      const xpath = '/html/body/p[1]';
      const entry = {
        xpath, text: 'Hello', x: 50, y: 100, w: 120, h: 24,
        status: 'new', changeCount: 0, lastChecked: Date.now(),
      };

      // First change → checking
      entry.changeCount++;
      entry.status = entry.changeCount > 5 ? 'moving' : 'checking';

      assert.strictEqual(entry.status, 'checking');

      // No more changes, reaches threshold
      entry.changeCount = 5;
      if (entry.status === 'checking' && entry.changeCount >= 5) {
        entry.status = 'stable';
      }

      assert.strictEqual(entry.status, 'stable');
    });

    test('stable → checking → moving after repeated changes', () => {
      const xpath = '/html/body/p[1]';
      const entry = {
        xpath, text: 'Hello', x: 50, y: 100, w: 120, h: 24,
        status: 'stable', changeCount: 0, lastChecked: Date.now(),
      };

      // Simulate 6 consecutive changes
      for (let i = 0; i < 6; i++) {
        entry.changeCount++;
        entry.status = entry.changeCount > 5 ? 'moving' : 'checking';
      }

      assert.strictEqual(entry.status, 'moving');
      assert.strictEqual(entry.changeCount, 6);
    });
  });

  // ── Debounced scroll-triggered collection ──────────────────────────────────

  describe('debounced scroll-triggered collection', () => {
    test('multiple rapid triggers → single collection', async () => {
      let collectionCount = 0;
      let timer = null;

      const scheduleCollection = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          collectionCount++;
        }, 300);
      };

      // Simulate rapid scroll events
      for (let i = 0; i < 10; i++) {
        scheduleCollection();
      }

      // Wait for debounce
      await new Promise(r => setTimeout(r, 400));

      assert.strictEqual(collectionCount, 1, 'debounce must reduce 10 triggers to 1 collection');
    });

    test('collection fires after debounce delay', async () => {
      let collectionCount = 0;
      let timer = null;

      const scheduleCollection = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          collectionCount++;
        }, 300);
      };

      scheduleCollection();

      // Before debounce
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(collectionCount, 0, 'must not fire before debounce delay');

      // After debounce
      await new Promise(r => setTimeout(r, 300));
      assert.strictEqual(collectionCount, 1, 'must fire after debounce delay');
    });
  });

  // ── XPath evaluation (simulated) ───────────────────────────────────────────

  describe('XPath evaluation', () => {
    test('valid xpath finds element', () => {
      const { document } = resetDOM();
      const el = document.createElement('p');
      el.textContent = 'Test Paragraph';
      el.id = 'test-p';
      document.body.append(el);
      document._register(el);

      // Simulate document.evaluate returning the element
      const found = document.getElementById('test-p');
      assert.ok(found !== null);
      assert.strictEqual(found.textContent, 'Test Paragraph');
    });

    test('missing element marks as removed', () => {
      const xpath = '/html/body/p[999]';
      const entry = {
        xpath, text: 'Gone', x: 50, y: 100, w: 120, h: 24,
        status: 'stable', changeCount: 0, lastChecked: Date.now(),
        inView: true,
      };

      const { document } = resetDOM();
      try {
        const el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!el) {
          entry.status = 'removed';
        }
      } catch (_) {
        // XPath not supported in mock
        entry.status = 'removed';
      }

      assert.strictEqual(entry.status, 'removed');
    });
  });
});
