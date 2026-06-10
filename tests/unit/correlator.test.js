/**
 * tests/unit/correlator.test.js
 * Review #4 — evidence-based, discriminative chain confidence.
 *
 * Exercises the REAL server/correlator.js. Before this, every chain on a real
 * page scored a uniform ~0.66 under the single network_dom_temporal rule;
 * confidence now spreads with auditable evidence (mutating method +, static
 * asset −, candidate ambiguity −) and each chain carries an `evidence` object.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TimeSeriesCorrelator, scoreChainEvidence, scoreNetworkToDom } =
  require('../../server/correlator');

const TAB = 4242;

function response(ts, { url = '/api/data', method = 'GET', reqId = `r${ts}` } = {}) {
  return {
    type: 'NETWORK_RESPONSE',
    tabId: TAB,
    payload: { ts, url, method, status: 200, reqId },
  };
}

function domMutation(ts, selector = '#list') {
  return {
    type: 'DOM_MUTATION',
    tabId: TAB,
    payload: { timestamp: ts, records: [{ targetSelector: selector }] },
  };
}

describe('review #4 — scoreChainEvidence discriminates instead of flat-lining', () => {
  test('a mutating POST outranks a same-distance static image (which drops below floor)', () => {
    const post = scoreChainEvidence({ url: '/api/save', method: 'POST' }, 1200, false, 2);
    const img  = scoreChainEvidence({ url: '/img/banner.png', method: 'GET' }, 1200, false, 2);

    assert.ok(post.confidence > img.confidence,
      `POST (${post.confidence}) must outrank image (${img.confidence})`);
    assert.strictEqual(post.evidence.mutatingMethod, 0.05);
    assert.strictEqual(img.evidence.staticAsset, -0.2);
    assert.ok(img.confidence < 0.5, 'a coincidental image response must fall below the default floor');
  });

  test('candidate ambiguity dilutes confidence, capped, and is recorded', () => {
    const solo  = scoreChainEvidence({ url: '/api/a' }, 100, false, 1);
    const four  = scoreChainEvidence({ url: '/api/a' }, 100, false, 4);
    const many  = scoreChainEvidence({ url: '/api/a' }, 100, false, 50);

    assert.ok(solo.confidence > four.confidence, 'competition must reduce per-candidate confidence');
    assert.strictEqual(solo.evidence.ambiguity, undefined, 'no penalty when uncontested');
    assert.strictEqual(four.evidence.ambiguity, -0.12);
    assert.strictEqual(many.evidence.ambiguity, -0.12, 'penalty is capped at 0.12');
  });

  test('framework confirmation stays the top tier and never reaches 1.0', () => {
    const { confidence, evidence } = scoreChainEvidence({ url: '/api/x', method: 'POST' }, 40, true, 1);
    assert.strictEqual(confidence, 0.95, 'clamped at 0.95 — a chain is an inference, not an observation');
    assert.strictEqual(evidence.frameworkConfirmed, true);
    assert.strictEqual(scoreNetworkToDom(40, true), 0.95);
  });

  test('the evidence object always carries the auditable base facts', () => {
    const { evidence } = scoreChainEvidence({ url: '/api/q' }, 700, false, 3);
    assert.strictEqual(evidence.temporal, scoreNetworkToDom(700, false));
    assert.strictEqual(evidence.deltaMs, 700);
    assert.strictEqual(evidence.candidates, 3);
  });
});

describe('review #4 — chains emitted by the correlator carry the evidence', () => {
  test('end-to-end: POST chain survives, image chain is dropped at the floor', () => {
    const c = new TimeSeriesCorrelator();
    const t0 = Date.now();
    c.addMessage(response(t0,       { url: '/api/save', method: 'POST', reqId: 'post1' }));
    c.addMessage(response(t0 + 10,  { url: '/img/spinner.gif', reqId: 'img1' }));
    const chains = c.addMessage(domMutation(t0 + 1200));

    assert.strictEqual(chains.length, 1, 'only the POST chain clears the floor');
    assert.strictEqual(chains[0].network.requestId, 'post1');
    assert.strictEqual(chains[0].rule, 'network_dom_temporal');
    assert.ok(chains[0].evidence, 'chain must expose its evidence');
    assert.strictEqual(chains[0].evidence.mutatingMethod, 0.05);
    assert.strictEqual(chains[0].evidence.candidates, 2);
  });

  test('confidence is no longer uniform across differing candidates', () => {
    const c = new TimeSeriesCorrelator();
    const t0 = Date.now();
    c.addMessage(response(t0,       { url: '/api/items', method: 'POST', reqId: 'w' }));
    c.addMessage(response(t0 + 900, { url: '/api/poll',  method: 'GET',  reqId: 'p' }));
    const chains = c.addMessage(domMutation(t0 + 1000));

    const byId = Object.fromEntries(chains.map(ch => [ch.network.requestId, ch.confidence]));
    assert.ok(byId.w !== byId.p, `chains must spread: POST=${byId.w} GET=${byId.p}`);
  });

  test('Proposal A: visual_delta is suppressed when a dom_mutation covers the window', () => {
    const c = new TimeSeriesCorrelator();
    const t0 = Date.now();
    c.addMessage(response(t0, { url: '/api/data', method: 'POST' }));
    c.addMessage(domMutation(t0 + 100));
    const fromVisual = c.addMessage({
      type: 'TEXT_COORD_DELTA',
      tabId: TAB,
      payload: { timestamp: t0 + 200, deltas: [{ selector: '#list' }] },
    });
    assert.strictEqual(fromVisual.length, 0, 'visual_delta must defer to the mutation_observer signal');
  });
});
