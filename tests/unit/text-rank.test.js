/**
 * tests/unit/text-rank.test.js
 * Section 2.x — shared text-target ranking policy
 *
 * Exercises the REAL shared/injected/lib/text-rank.js — the policy that both the
 * browser-side click(text) resolver (executor.js findByText) and the server-side
 * find_target tool defer to, so they order candidates identically.
 *
 * The regression that motivated it: {text:"x.com"} on a search-results page
 * landed on a ".x.com" breadcrumb/meta span instead of the real link, because a
 * plain-text substring tied the link on raw text score alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rank = require('../../shared/injected/lib/text-rank.js');

describe('2.x text-rank policy', () => {
  it('x.com regression: a real link outranks a meta span of equal text score', () => {
    const res = rank.rankCandidates([
      { textScore: 0.55, kind: 'text', text: '.x.com', selector: 'span.cite' },
      { textScore: 0.55, kind: 'link', text: 'x.com', selector: 'a', inViewport: true, hasAccessibleName: true },
    ]);
    assert.strictEqual(res.best.kind, 'link', 'the link wins the tie');
    assert.ok(res.best.finalScore > res.ranked[1].finalScore);
  });

  it('a clearly better text match still wins across kinds (weights only break ties)', () => {
    const res = rank.rankCandidates([
      { textScore: 1.0, kind: 'text', text: 'Submit', selector: 'span' },
      { textScore: 0.55, kind: 'button', text: 'Submit form please', selector: 'button' },
    ]);
    assert.strictEqual(res.best.kind, 'text', 'exact text match beats a weaker button match');
  });

  it('viewport bonus lifts an on-screen candidate over an off-screen equal', () => {
    const res = rank.rankCandidates([
      { textScore: 0.7, kind: 'link', text: 'Next', selector: 'a#a', inViewport: false },
      { textScore: 0.7, kind: 'link', text: 'Next', selector: 'a#b', inViewport: true },
    ]);
    assert.strictEqual(res.best.selector, 'a#b');
  });

  it('reachability: an obstructed candidate yields to a reachable one of similar score', () => {
    const res = rank.rankCandidates([
      { textScore: 0.8, kind: 'button', text: 'OK', selector: '#x', clickable: false },
      { textScore: 0.7, kind: 'button', text: 'OK', selector: '#y', clickable: true },
    ]);
    assert.strictEqual(res.best.selector, '#y', 'obstructed -0.2 drops it below the reachable one');
  });

  it('unknown reachability (null, offscreen) is only a light penalty', () => {
    const res = rank.rankCandidates([
      { textScore: 0.8, kind: 'button', text: 'OK', selector: '#x', clickable: null },
      { textScore: 0.7, kind: 'button', text: 'OK', selector: '#y', clickable: true },
    ]);
    assert.strictEqual(res.best.selector, '#x', '-0.05 is not enough to overturn a 0.1 text lead');
  });

  it('prefer override boosts the chosen kind', () => {
    const cands = [
      { textScore: 0.7, kind: 'text', text: 'Repos', selector: 'span' },
      { textScore: 0.7, kind: 'link', text: 'Repos', selector: 'a' },
    ];
    const def = rank.rankCandidates(cands);
    assert.strictEqual(def.best.kind, 'link'); // link already wins by kind weight
    const pref = rank.rankCandidates(cands, { textMatch: { prefer: 'text' } });
    assert.strictEqual(pref.best.kind, 'text', 'prefer:text overrides the default kind order');
  });

  it('scope:viewport drops off-screen candidates entirely', () => {
    const res = rank.rankCandidates([
      { textScore: 0.9, kind: 'link', text: 'A', selector: '#a', inViewport: false },
      { textScore: 0.4, kind: 'link', text: 'A', selector: '#b', inViewport: true },
    ], { textMatch: { scope: 'viewport' } });
    assert.strictEqual(res.ranked.length, 1);
    assert.strictEqual(res.best.selector, '#b');
  });

  it('index picks the Nth-ranked candidate', () => {
    const res = rank.rankCandidates([
      { textScore: 0.9, kind: 'link', text: 'one', selector: '#1' },
      { textScore: 0.8, kind: 'link', text: 'two', selector: '#2' },
    ], { textMatch: { index: 1 } });
    assert.strictEqual(res.chosenIndex, 1);
    assert.strictEqual(res.best.selector, '#2');
  });

  it('boost (list and map) nudges matching selectors up', () => {
    const cands = [
      { textScore: 0.8, kind: 'text', text: 'Go', selector: 'span.menu-item' },
      { textScore: 0.7, kind: 'text', text: 'Go', selector: 'span.other' },
    ];
    const listed = rank.rankCandidates(cands, { textMatch: { boost: ['other'] } });
    assert.strictEqual(listed.best.selector, 'span.other', '+0.2 overtakes the 0.1 lead');
    const mapped = rank.rankCandidates(cands, { textMatch: { boost: { other: 0.5 } } });
    assert.strictEqual(mapped.best.selector, 'span.other');
  });

  it('exclude drops candidates matching selector OR text', () => {
    const bySel = rank.rankCandidates([
      { textScore: 0.9, kind: 'link', text: 'Ad', selector: 'a.sponsored' },
      { textScore: 0.5, kind: 'link', text: 'Real', selector: 'a.real' },
    ], { textMatch: { exclude: 'sponsored' } });
    assert.strictEqual(bySel.ranked.length, 1);
    assert.strictEqual(bySel.best.selector, 'a.real');

    const byText = rank.rankCandidates([
      { textScore: 0.9, kind: 'text', text: '.x.com', selector: 'span' },
      { textScore: 0.6, kind: 'link', text: 'x.com', selector: 'a' },
    ], { textMatch: { exclude: '.x.com' } });
    assert.strictEqual(byText.best.kind, 'link');
  });

  it('skips malformed candidates (no numeric textScore) without throwing', () => {
    const res = rank.rankCandidates([
      { kind: 'link', text: 'no score' },
      null,
      { textScore: 0.5, kind: 'link', text: 'ok', selector: 'a' },
    ]);
    assert.strictEqual(res.ranked.length, 1);
    assert.strictEqual(res.best.text, 'ok');
  });

  it('toMatchedBy returns a slim, serializable explanation (no DOM refs)', () => {
    const res = rank.rankCandidates([
      { textScore: 0.55, kind: 'link', text: 'x.com', selector: 'a', inViewport: true, _el: { fake: 'dom-node' } },
      { textScore: 0.55, kind: 'text', text: '.x.com', selector: 'span', _el: { fake: 'dom-node' } },
    ]);
    const mb = rank.toMatchedBy(res, { limit: 5 });
    assert.strictEqual(mb.kind, 'link');
    assert.strictEqual(typeof mb.score, 'number');
    assert.strictEqual(mb.index, 0);
    assert.strictEqual(mb.candidates.length, 2);
    // explains WHY: signals carry the contributing components, not a fabricated number
    assert.strictEqual(mb.candidates[0].signals.textScore, 0.55);
    assert.strictEqual(mb.candidates[0].signals.kindBonus, rank.KIND_WEIGHT.link);
    // no DOM ref leaks into the report
    assert.ok(!JSON.stringify(mb).includes('dom-node'), '_el is never copied into the report');
  });

  it('does not mutate the input candidates', () => {
    const input = [{ textScore: 0.5, kind: 'link', text: 'a', selector: '#a' }];
    rank.rankCandidates(input, { textMatch: { prefer: 'link' } });
    assert.deepStrictEqual(Object.keys(input[0]), ['textScore', 'kind', 'text', 'selector'],
      'finalScore/signals are added only to the returned copies');
  });
});
