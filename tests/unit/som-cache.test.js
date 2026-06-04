/**
 * tests/unit/som-cache.test.js
 * Section 14.2 — Packed SoM freshness cache
 *
 * Exercises the REAL server/som-cache.js with an injected `now` so freshness,
 * TTL and LRU behaviour are deterministic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSomCache } = require('../../server/som-cache');

const result = (id) => ({ dataUrl: 'data:image/png;base64,' + id, marks: [{ n: 1 }] });

describe('14.2 som-cache — freshness', () => {
  it('misses on an empty cache', () => {
    const c = createSomCache();
    assert.strictEqual(c.get(1, 1000), null);
    assert.strictEqual(c.stats().misses, 1);
  });

  it('returns a stored result while the page is unchanged', () => {
    const c = createSomCache();
    c.set(1, result('a'), 1000);
    const got = c.get(1, 1500);
    assert.ok(got);
    assert.strictEqual(got.dataUrl, 'data:image/png;base64,a');
    assert.strictEqual(c.stats().hits, 1);
  });

  it('invalidates the entry once the page changes', () => {
    const c = createSomCache();
    c.set(1, result('a'), 1000);
    c.markChanged(1, 2000);          // DOM mutation / navigation after the capture
    assert.strictEqual(c.get(1, 2500), null, 'a changed page must not serve a stale capture');
  });

  it('serves a capture taken after the last change', () => {
    const c = createSomCache();
    c.markChanged(1, 1000);
    c.set(1, result('a'), 2000);     // captured after the change
    assert.ok(c.get(1, 2500));
  });

  it('expires by TTL even with no change signal', () => {
    const c = createSomCache({ ttlMs: 1000 });
    c.set(1, result('a'), 1000);
    assert.ok(c.get(1, 1500));               // within TTL
    assert.strictEqual(c.get(1, 2500), null); // past TTL
  });
});

describe('14.2 som-cache — lifecycle', () => {
  it('evictTab drops a tab', () => {
    const c = createSomCache();
    c.set(1, result('a'), 1000);
    c.evictTab(1);
    assert.strictEqual(c.get(1, 1100), null);
  });

  it('bounds tabs with LRU eviction (least-recently-used dropped)', () => {
    const c = createSomCache({ maxTabs: 2 });
    c.set(1, result('a'), 1000);
    c.set(2, result('b'), 1000);
    c.get(1, 1000);                  // touch tab 1 → tab 2 is now LRU
    c.set(3, result('c'), 1000);     // over cap → evict LRU (tab 2)
    assert.ok(c.get(1, 1000), 'recently used tab survives');
    assert.ok(c.get(3, 1000));
    assert.strictEqual(c.get(2, 1000), null, 'LRU tab was evicted');
  });
});
