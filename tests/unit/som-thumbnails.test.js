/**
 * tests/unit/som-thumbnails.test.js
 * Section 4.7 — Per-element thumbnail cache (T2 / packed-SoM slice 2)
 *
 * Exercises the REAL server/som-thumbnails.js: signature bucketing, freshness +
 * view-aware invalidation, per-tab eviction, and LRU bound.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createThumbStore, thumbSignature } = require('../../server/som-thumbnails');

describe('4.7 thumbSignature', () => {
  it('buckets size to the nearest 8px so jitter does not thrash', () => {
    assert.strictEqual(thumbSignature('#a', { w: 81, h: 30 }), thumbSignature('#a', { w: 83, h: 31 }));
    assert.notStrictEqual(thumbSignature('#a', { w: 80, h: 30 }), thumbSignature('#a', { w: 120, h: 30 }));
  });
  it('accepts both {w,h} and {width,height} rects', () => {
    assert.strictEqual(thumbSignature('#a', { w: 80, h: 32 }), thumbSignature('#a', { width: 80, height: 32 }));
  });
});

describe('4.7 thumbnail store get/set', () => {
  it('returns a fresh entry and counts hits/misses', () => {
    const s = createThumbStore();
    const sig = thumbSignature('#login', { w: 80, h: 30 });
    assert.strictEqual(s.get(1, sig), null);            // miss
    s.set(1, sig, { dataUrl: 'data:image/png;base64,QQ==', w: 80, h: 30 });
    const e = s.get(1, sig);                              // hit
    assert.ok(e && e.dataUrl.startsWith('data:image/'));
    assert.deepStrictEqual(s.stats(), { entries: 1, hits: 1, misses: 1 });
  });

  it('invalidates a tab\'s thumbnails after the page changes', () => {
    const s = createThumbStore();
    const sig = thumbSignature('#x', { w: 40, h: 40 });
    s.set(1, sig, { dataUrl: 'data:image/png;base64,QQ==' });
    s.markChanged(1, Date.now() + 1000); // change lands after capture → stale
    assert.strictEqual(s.get(1, sig), null);
  });

  it('keeps another tab\'s entries when one tab changes', () => {
    const s = createThumbStore();
    const sig = thumbSignature('#x', { w: 40, h: 40 });
    s.set(1, sig, { dataUrl: 'd1' });
    s.set(2, sig, { dataUrl: 'd2' });
    s.markChanged(1, Date.now() + 1000);
    assert.strictEqual(s.get(1, sig), null);
    assert.ok(s.get(2, sig));
  });

  it('drops every entry for a closed tab', () => {
    const s = createThumbStore();
    s.set(1, thumbSignature('#a', { w: 8, h: 8 }), { dataUrl: 'a' });
    s.set(1, thumbSignature('#b', { w: 8, h: 8 }), { dataUrl: 'b' });
    s.evictTab(1);
    assert.strictEqual(s.get(1, thumbSignature('#a', { w: 8, h: 8 })), null);
    assert.strictEqual(s.stats().entries, 0);
  });

  it('honours TTL expiry', () => {
    const s = createThumbStore({ ttlMs: 1000 });
    const sig = thumbSignature('#x', { w: 40, h: 40 });
    const t0 = Date.now();
    s.set(1, sig, { dataUrl: 'd' }, t0);
    assert.ok(s.get(1, sig, t0 + 500));   // within TTL
    assert.strictEqual(s.get(1, sig, t0 + 2000), null); // expired
  });

  it('evicts the least-recently-used entry past the cap', () => {
    const s = createThumbStore({ maxEntries: 2 });
    s.set(1, 'a', { dataUrl: 'a' });
    s.set(1, 'b', { dataUrl: 'b' });
    s.get(1, 'a');                 // touch a → b is now LRU
    s.set(1, 'c', { dataUrl: 'c' }); // evicts b
    assert.ok(s.get(1, 'a'));
    assert.strictEqual(s.get(1, 'b'), null);
    assert.ok(s.get(1, 'c'));
  });
});
