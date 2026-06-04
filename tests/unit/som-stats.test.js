/**
 * tests/unit/som-stats.test.js
 * Section 14.1 — Packed SoM usage statistics
 *
 * Exercises the REAL server/som-stats.js. Stores use persist:false and an
 * injected `now` so decay and ranking are deterministic and touch no disk.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStatsStore, normalize, HALF_LIFE_DAYS } = require('../../server/som-stats');

const DAY = 86400000;
const store = (over = {}) => createStatsStore({ persist: false, ...over });

describe('14.1 normalize', () => {
  it('lowercases, trims and collapses whitespace', () => {
    assert.strictEqual(normalize('  Add   To  Cart '), 'add-to-cart'); // also synonym-folded
  });
  it('strips surrounding punctuation/emoji', () => {
    assert.strictEqual(normalize('» Continue «'), 'continue');
    assert.strictEqual(normalize('Login →'), 'login');
  });
  it('folds known synonyms to a canonical label', () => {
    assert.strictEqual(normalize('Sign In'), 'login');
    assert.strictEqual(normalize('Create Account'), 'signup');
  });
  it('returns null for unusable text', () => {
    assert.strictEqual(normalize('   '), null);
    assert.strictEqual(normalize(''), null);
    assert.strictEqual(normalize(42), null);
  });
});

describe('14.1 record / score', () => {
  it('records an action and reflects it in the score', () => {
    const s = store({ seedPrior: false });
    const now = 1_000_000_000_000;
    assert.strictEqual(s.record('Checkout', 1, now), 'checkout');
    assert.ok(s.score('Checkout', now) >= 1);
    assert.strictEqual(s.score('never-seen', now), 0);
  });

  it('decays the score by half over one half-life', () => {
    const s = store({ seedPrior: false });
    const now = 1_000_000_000_000;
    s.record('login', 1, now);
    const later = now + HALF_LIFE_DAYS * DAY;
    const ratio = s.score('login', later) / s.score('login', now);
    assert.ok(Math.abs(ratio - 0.5) < 0.02, `expected ~0.5, got ${ratio}`);
  });

  it('accumulates repeated actions (decay-then-add)', () => {
    const s = store({ seedPrior: false });
    const now = 1_000_000_000_000;
    s.record('search', 1, now);
    s.record('search', 1, now);
    assert.ok(s.score('search', now) > 1.5);
  });
});

describe('14.1 rank', () => {
  it('orders candidates by decayed score, stable on ties', () => {
    const s = store({ seedPrior: false });
    const now = 1_000_000_000_000;
    s.record('Login', 5, now);
    s.record('Help', 1, now);
    const ranked = s.rank(['Help', 'Login', 'Unknown'], now);
    assert.deepStrictEqual(ranked.map((r) => r.label), ['login', 'help', 'unknown']);
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it('never drops a candidate, only biases order', () => {
    const s = store({ seedPrior: false });
    const ranked = s.rank(['A', 'B', 'C'], 1_000_000_000_000);
    assert.strictEqual(ranked.length, 3);
  });
});

describe('14.1 cold-start prior', () => {
  it('seeds universal labels so ranking is useful before any stats', () => {
    const s = store(); // seedPrior default on
    const now = 1_000_000_000_000;
    // "login" (prior) should outrank a never-seen made-up label.
    const ranked = s.rank(['zzqx-nonsense', 'Login'], now);
    assert.strictEqual(ranked[0].label, 'login');
    assert.ok(s.score('login', now) > 0);
  });

  it('a really-acted label outranks a mere prior', () => {
    const s = store();
    const now = 1_000_000_000_000;
    s.record('zzqx-nonsense', 3, now);
    const ranked = s.rank(['login', 'zzqx-nonsense'], now);
    assert.strictEqual(ranked[0].label, 'zzqx-nonsense');
  });
});
