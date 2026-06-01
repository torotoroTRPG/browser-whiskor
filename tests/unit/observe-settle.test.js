/**
 * tests/unit/observe-settle.test.js
 * Post-action observe settle loop — adaptive interval + quiescent window.
 *
 * Drives the real _awaitSettled / _observeOpts internals (write.js) with a mock
 * navigator that replays a scripted sequence of state-hash reads. No browser.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _internals } = require('../../server/mcp/tools/write');
const { _awaitSettled, _observeOpts, OBSERVE_DEFAULTS } = _internals;

// Mock navigator whose requestHash returns the next compositeHash in `seq`.
// Once exhausted it keeps returning the last value (page is now static).
function mockNavigator(seq) {
  let i = 0;
  return {
    requestHash: async () => {
      const v = i < seq.length ? seq[i++] : seq[seq.length - 1];
      if (v instanceof Error) throw v;
      return { compositeHash: v };
    },
  };
}

const noopBroadcast = () => {};

describe('_observeOpts', () => {
  it('falls back to defaults when no config is present', () => {
    const o = _observeOpts({});
    assert.equal(o.adaptive, true);
    assert.deepEqual(o.intervalsMs, OBSERVE_DEFAULTS.intervalsMs);
    assert.equal(o.settleReads, OBSERVE_DEFAULTS.settleReads);
    assert.equal(o.quiescentMs, OBSERVE_DEFAULTS.quiescentMs);
  });

  it('honours an explicit observe config', () => {
    const o = _observeOpts({ _config: { observe: { intervalsMs: [10, 20], settleReads: 3, quiescentMs: 40 } } });
    assert.deepEqual(o.intervalsMs, [10, 20]);
    assert.equal(o.settleReads, 3);
    assert.equal(o.quiescentMs, 40);
  });

  it('legacy mode (adaptive=false) disables the quiescent window', () => {
    const o = _observeOpts({ _config: { observe: { adaptive: false } } });
    assert.equal(o.adaptive, false);
    assert.equal(o.quiescentMs, 0);
  });
});

describe('_awaitSettled', () => {
  const fastAdaptive = { adaptive: true, intervalsMs: [2, 2, 2], intervalMs: 2, settleReads: 2, quiescentMs: 0 };

  it('settles after settleReads consecutive equal reads (adaptive)', async () => {
    const nav = mockNavigator(['h1', 'h1']);
    const obs = await _awaitSettled(nav, 1, noopBroadcast, null, 1000, fastAdaptive);
    assert.equal(obs.available, true);
    assert.equal(obs.settled, true);
    assert.equal(obs.toHash, 'h1');
    assert.equal(obs.mode, 'adaptive');
    assert.ok(obs.reads >= 2);
  });

  it('reports hashChanged relative to fromHash', async () => {
    const nav = mockNavigator(['new', 'new']);
    const obs = await _awaitSettled(nav, 1, noopBroadcast, 'old', 1000, fastAdaptive);
    assert.equal(obs.hashChanged, true);
    assert.equal(obs.toHash, 'new');
  });

  it('resets the stable counter when the hash changes mid-flight', async () => {
    // a → b → b : must settle on b (not a), proving the counter reset.
    const nav = mockNavigator(['a', 'b', 'b']);
    const obs = await _awaitSettled(nav, 1, noopBroadcast, null, 1000, fastAdaptive);
    assert.equal(obs.settled, true);
    assert.equal(obs.toHash, 'b');
    assert.ok(obs.reads >= 3);
  });

  it('reports unavailable when the hash channel never responds', async () => {
    const nav = mockNavigator([new Error('no channel')]);
    const obs = await _awaitSettled(nav, 1, noopBroadcast, null, 1000, fastAdaptive);
    assert.equal(obs.available, false);
  });

  it('legacy fixed mode reports mode="fixed" and still settles', async () => {
    const nav = mockNavigator(['x', 'x']);
    const legacy = { adaptive: false, intervalsMs: [2], intervalMs: 2, settleReads: 2, quiescentMs: 0 };
    const obs = await _awaitSettled(nav, 1, noopBroadcast, null, 1000, legacy);
    assert.equal(obs.mode, 'fixed');
    assert.equal(obs.settled, true);
    assert.equal(obs.toHash, 'x');
  });
});
