/**
 * tests/unit/state-similar.test.js
 * Section 7.3 — Similar-state suggestions
 *
 * Verifies the semantic + structural ranking used to suggest alternative states
 * when navigate_to_state cannot find a replayable path. Drives the REAL
 * state-navigator._findSimilarStates against an in-memory graph.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const navigator = require('../../server/state-navigator');

function graph() {
  return {
    nodes: {
      target:   { hash: 'target',   label: 'Cart page (2 items)',      url: 'https://shop.test/cart',         tags: ['cart', 'authenticated'] },
      sharedTags: { hash: 'sharedTags', label: 'Cart page (empty)',    url: 'https://shop.test/cart?empty=1', tags: ['cart', 'authenticated'] },
      sameUrl:  { hash: 'sameUrl',   label: 'Totally different label', url: 'https://shop.test/cart',          tags: [] },
      samePath: { hash: 'samePath',  label: 'Cart variant',            url: 'https://shop.test/cart#section',  tags: ['promo'] },
      unrelated:{ hash: 'unrelated', label: 'Settings',                url: 'https://shop.test/settings',      tags: ['settings'] },
      evicted:  { hash: 'evicted',   label: 'Cart page (old)',         url: 'https://shop.test/cart',          tags: ['cart'], evicted: true },
    },
  };
}

describe('7.3 _findSimilarStates', () => {
  it('returns matches ranked by combined similarity, target excluded', () => {
    const out = navigator._findSimilarStates(graph(), 'target', 10);
    const hashes = out.map(s => s.hash);
    assert.ok(!hashes.includes('target'), 'target itself is excluded');
    assert.ok(hashes.includes('sharedTags'), 'shared-tag node surfaces');
    assert.ok(hashes.includes('sameUrl'),    'same-URL node surfaces');
  });

  it('excludes evicted nodes', () => {
    const out = navigator._findSimilarStates(graph(), 'target', 10);
    assert.ok(!out.some(s => s.hash === 'evicted'), 'evicted nodes must not be suggested');
  });

  it('ranks shared-tags + similar-label highest, settings lowest (or absent)', () => {
    const out = navigator._findSimilarStates(graph(), 'target', 10);
    assert.equal(out[0].hash, 'sharedTags',
      'node sharing tags AND a similar label should rank first');
    const settings = out.find(s => s.hash === 'unrelated');
    assert.ok(!settings, 'a fully unrelated state should not be suggested');
  });

  it('attaches a human-readable reason and numeric score', () => {
    const out = navigator._findSimilarStates(graph(), 'target', 10);
    for (const s of out) {
      assert.equal(typeof s.score, 'number');
      assert.ok(s.score > 0);
      assert.equal(typeof s.reason, 'string');
      assert.ok(s.reason.length > 0);
    }
  });

  it('respects the limit argument', () => {
    const out = navigator._findSimilarStates(graph(), 'target', 1);
    assert.equal(out.length, 1);
  });

  it('returns empty array for an unknown target hash', () => {
    assert.deepEqual(navigator._findSimilarStates(graph(), 'nope', 5), []);
  });
});
