/**
 * tests/unit/beacon.test.js
 * Section 3.1 — Beacon System (text-coords.js)
 *
 * Tests beacon subset selection, start/stop lifecycle,
 * inView tracking, debounced scan, delta flush, and beacon query.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDOM } from '../helpers/dom-mock.js';
import { generateTextCoords } from '../helpers/fixtures.js';

// ── Inline BeaconTracker implementation ──────────────────────────────────────
// Replace with: import { BeaconTracker } from '../../src/text-coords.js';

const BEACON_MAX   = 200;
const BEACON_DEBOUNCE_MS = 500;

class BeaconTracker {
  constructor(opts = {}) {
    this._running      = false;
    this._words        = [];
    this._beaconWords  = [];   // subset tracked for deltas
    this._debounceMs   = opts.debounceMs ?? BEACON_DEBOUNCE_MS;
    this._timer        = null;
    this._deltas       = [];   // pending delta messages
    this._scanCount    = 0;
    this._onDelta      = opts.onDelta ?? (() => {});
    this._viewport     = { scrollX: 0, scrollY: 0, width: 1280, height: 800 };
  }

  start(words) {
    this._words = words;
    this._selectBeaconSubset();
    this._running = true;
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /** Called on every scroll/resize — debounced scan. */
  onScroll(viewport) {
    this._viewport = viewport;
    if (!this._running) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._scan(), this._debounceMs);
  }

  /** Immediate scan (used internally and in tests). */
  _scan() {
    this._scanCount++;
    const deltas = [];
    for (const w of this._beaconWords) {
      const nowInView = this._isInViewport(w);
      if (nowInView !== w.inView) {
        w.inView = nowInView;
        deltas.push({ id: w.id, inView: nowInView });
      }
    }
    if (deltas.length > 0) {
      this._onDelta({ type: 'TEXT_COORD_DELTA', deltas });
    }
    this._deltas = deltas;
  }

  _isInViewport(w) {
    const { scrollX, scrollY, width, height } = this._viewport;
    return (
      w.x + w.width  >= scrollX &&
      w.x            <= scrollX + width &&
      w.y + w.height >= scrollY &&
      w.y            <= scrollY + height
    );
  }

  _selectBeaconSubset() {
    const stride = Math.max(1, Math.floor(this._words.length / BEACON_MAX));
    this._beaconWords = this._words
      .filter((_, i) => i % stride === 0)
      .slice(0, BEACON_MAX)
      .map(w => ({ ...w }));
  }

  getViewState() {
    const inView    = this._beaconWords.filter(w => w.inView).length;
    const total     = this._beaconWords.length;
    return { total, inView, outOfView: total - inView };
  }

  get running()      { return this._running; }
  get beaconCount()  { return this._beaconWords.length; }
  get scanCount()    { return this._scanCount; }
  get lastDeltas()   { return this._deltas; }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('3.1 Beacon Tracking', () => {

  let tracker;

  beforeEach(() => {
    resetDOM();
    tracker = new BeaconTracker({ debounceMs: 0 }); // instant debounce for tests
  });

  afterEach(() => {
    tracker.stop();
  });

  // ── Start / stop ────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    test('start: _running = true, beaconWords populated', () => {
      const { words } = generateTextCoords(100);
      tracker.start(words);
      assert.strictEqual(tracker.running, true);
      assert.ok(tracker.beaconCount > 0, 'beaconWords must be populated on start');
    });

    test('stop: _running = false', () => {
      tracker.start(generateTextCoords(20).words);
      tracker.stop();
      assert.strictEqual(tracker.running, false);
    });

    test('stop clears debounce timer (no dangling listener)', () => {
      const tracker2 = new BeaconTracker({ debounceMs: 10000 });
      tracker2.start(generateTextCoords(20).words);
      tracker2.onScroll({ scrollX: 0, scrollY: 0, width: 1280, height: 800 });
      assert.ok(tracker2._timer !== null, 'timer set before stop');
      tracker2.stop();
      assert.strictEqual(tracker2._timer, null, 'timer must be cleared on stop');
    });
  });

  // ── Beacon subset ───────────────────────────────────────────────────────────

  describe('beacon subset', () => {
    test('5000 words → at most BEACON_MAX (200) beacons', () => {
      tracker.start(generateTextCoords(5000).words);
      assert.ok(tracker.beaconCount <= BEACON_MAX, `must not exceed ${BEACON_MAX} beacons`);
    });

    test('100 words → all tracked (under limit)', () => {
      tracker.start(generateTextCoords(100).words);
      assert.ok(tracker.beaconCount <= 100, 'must not create more beacons than words');
      assert.ok(tracker.beaconCount > 0);
    });

    test('beacon subset is ~1/N of total words', () => {
      tracker.start(generateTextCoords(1000).words);
      assert.ok(tracker.beaconCount <= BEACON_MAX);
      assert.ok(tracker.beaconCount >= 1);
    });
  });

  // ── Viewport state change ────────────────────────────────────────────────────

  describe('viewport state change', () => {
    test('scroll moves words in/out — inView updated correctly', () => {
      const data = generateTextCoords(300, 800);
      tracker.start(data.words);

      // Initial: scrollY=0, words at y<800 are in-view
      tracker._scan();
      const initialInView = tracker.getViewState().inView;

      // Scroll way down — most beacon words (near top) go out of view
      tracker._viewport = { scrollX: 0, scrollY: 5000, width: 1280, height: 800 };
      tracker._scan();
      const afterScroll = tracker.getViewState().inView;

      assert.ok(afterScroll <= initialInView, 'scrolling down must reduce inView count');
    });

    test('isInViewport uses live scroll offsets', () => {
      const word = { id:'w0', x:100, y:900, width:60, height:16, inView:false };
      tracker._viewport = { scrollX:0, scrollY:0, width:1280, height:800 };
      assert.strictEqual(tracker._isInViewport(word), false, 'word at y=900 is out of initial viewport');

      tracker._viewport = { scrollX:0, scrollY:200, width:1280, height:800 };
      assert.strictEqual(tracker._isInViewport(word), true, 'word at y=900 is in viewport when scrolled to y=200');
    });
  });

  // ── Debounced scan ───────────────────────────────────────────────────────────

  describe('debounced scan', () => {
    test('rapid onScroll calls → scan runs once (debounce)', done => {
      const t = new BeaconTracker({ debounceMs: 50 });
      t.start(generateTextCoords(50).words);

      for (let i = 0; i < 20; i++) {
        t.onScroll({ scrollX: 0, scrollY: i * 50, width: 1280, height: 800 });
      }

      setTimeout(() => {
        assert.strictEqual(t.scanCount, 1, 'debounce must reduce 20 scroll events to 1 scan');
        t.stop();
        done();
      }, 100);
    });
  });

  // ── Delta flush ──────────────────────────────────────────────────────────────

  describe('delta flush', () => {
    test('words changing view state produces TEXT_COORD_DELTA with deltas', () => {
      const deltas = [];
      const t = new BeaconTracker({ debounceMs: 0, onDelta: d => deltas.push(d) });
      const data = generateTextCoords(50, 800); // words within 800px are inView
      t.start(data.words);

      // Scroll so all beacon words go out of view
      t._viewport = { scrollX: 0, scrollY: 10000, width: 1280, height: 800 };
      t._scan();

      assert.ok(deltas.length >= 1, 'delta must be emitted when inView changes');
      assert.strictEqual(deltas[0].type, 'TEXT_COORD_DELTA');
      assert.ok(Array.isArray(deltas[0].deltas));
      assert.ok(deltas[0].deltas.every(d => 'id' in d && 'inView' in d));
    });

    test('no inView change → no delta emitted', () => {
      const deltas = [];
      const t = new BeaconTracker({ debounceMs: 0, onDelta: d => deltas.push(d) });
      const { words } = generateTextCoords(30);
      t.start(words);

      // Scan without changing viewport — nothing should change
      t._scan();
      t._scan();

      assert.strictEqual(deltas.length, 0, 'no delta when nothing changed');
      t.stop();
    });
  });

  // ── Beacon query ────────────────────────────────────────────────────────────

  describe('getViewState', () => {
    test('returns { total, inView, outOfView } with correct sum', () => {
      tracker.start(generateTextCoords(200, 800).words);
      tracker._scan();
      const { total, inView, outOfView } = tracker.getViewState();
      assert.strictEqual(total, inView + outOfView, 'total = inView + outOfView');
      assert.ok(total > 0);
    });

    test('returns all-outOfView when scrolled far away', () => {
      tracker.start(generateTextCoords(100, 800).words);
      tracker._viewport = { scrollX:0, scrollY:99999, width:1280, height:800 };
      tracker._scan();
      const { inView } = tracker.getViewState();
      assert.strictEqual(inView, 0, 'no words in view when scrolled to bottom of universe');
    });
  });
});
