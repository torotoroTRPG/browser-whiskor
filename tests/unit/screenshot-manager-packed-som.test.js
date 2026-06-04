/**
 * tests/unit/screenshot-manager-packed-som.test.js
 * Section 4.6 — Packed Set-of-Marks freshness cache + usage-stats ordering
 *
 * These live on the WORKER (screenshot-manager), not the MCP layer, so they work
 * identically over MCP stdio, HTTP /api/packed-som, and the proxy's HTTP forward.
 * (Earlier they sat in the MCP tool and were silently dead under the proxy.) This
 * suite is the regression guard: capturePackedSom is the single path all three
 * callers use, so a second call returning _cached:true proves the cache is wired
 * everywhere it needs to be.
 *
 * Exercises the REAL server/screenshot-manager.js with the REAL som-cache.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sm = require('../../server/screenshot-manager');
const { createSomCache } = require('../../server/som-cache');

// Drive a single raw capture: capturePackedSom broadcasts synchronously (setting
// reqId) before awaiting, so we can resolve it via handleResult right after.
function resolveNextCapture(result) {
  let reqId = null;
  sm.setBroadcast((msg) => { reqId = msg.reqId; });
  return () => sm.handleResult({ reqId, ...result });
}

describe('4.6 packed-SoM worker cache', () => {
  it('captures on a miss then serves the second call from cache (no re-capture)', async () => {
    const cache = createSomCache();
    sm.setSomCache(cache);
    sm.setSomStats(null);

    // 1st call: cache miss → real raw capture (resolved via handleResult).
    const fire = resolveNextCapture({ dataUrl: 'data:image/png;base64,QQ==', marks: [{ n: 1, text: 'Login', selector: '#l', rect: { w: 1 } }] });
    const p1 = sm.capturePackedSom(1, {});
    fire();
    const r1 = await p1;
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1._cached, false);
    assert.strictEqual(r1.marks[0].text, 'Login');

    // 2nd call: must hit the cache and NOT broadcast another capture.
    let broadcasts = 0;
    sm.setBroadcast(() => { broadcasts++; });
    const r2 = await sm.capturePackedSom(1, {});
    assert.strictEqual(broadcasts, 0, 'a fresh cache hit must not re-capture');
    assert.strictEqual(r2._cached, true);
    assert.strictEqual(r2.marks[0].text, 'Login');
  });

  it('re-captures after the page changes (cache invalidated)', async () => {
    const cache = createSomCache();
    sm.setSomCache(cache);
    sm.setSomStats(null);

    let fire = resolveNextCapture({ dataUrl: 'data:image/png;base64,QQ==', marks: [{ n: 1, text: 'A', selector: '#a', rect: { w: 1 } }] });
    const p1 = sm.capturePackedSom(2, {});
    fire();
    await p1;

    // A page change bumps lastChangeAt → the cached entry is no longer fresh.
    // Use an explicitly-later timestamp so the sub-millisecond test is deterministic
    // (get() treats capturedAt >= lastChangeAt as still fresh).
    cache.markChanged(2, Date.now() + 1000);

    let captured = 0;
    fire = (() => {
      let reqId = null;
      sm.setBroadcast((msg) => { reqId = msg.reqId; captured++; });
      return () => sm.handleResult({ reqId, dataUrl: 'data:image/png;base64,QQ==', marks: [{ n: 1, text: 'B', selector: '#b', rect: { w: 1 } }] });
    })();
    const p2 = sm.capturePackedSom(2, {});
    fire();
    const r2 = await p2;
    assert.strictEqual(captured, 1, 'a changed page must re-capture');
    assert.strictEqual(r2._cached, false);
    assert.strictEqual(r2.marks[0].text, 'B');
  });
});

describe('4.6 packed-SoM usage-stats ordering', () => {
  it('orders marks by decayed stats score, leaving image numbers (n) unchanged', async () => {
    sm.setSomCache(null); // force a fresh capture path
    sm.setSomStats({ rank: (texts) => texts.map((t) => ({ text: t, label: t, score: t === 'Cart' ? 5 : 1 })) });

    const fire = resolveNextCapture({
      dataUrl: 'data:image/png;base64,QQ==',
      marks: [
        { n: 1, text: 'Login', selector: '#l', rect: { w: 1 } },
        { n: 2, text: 'Cart', selector: '#c', rect: { w: 1 } },
      ],
    });
    const p = sm.capturePackedSom(3, {});
    fire();
    const res = await p;

    assert.strictEqual(res._ordered, true);
    assert.strictEqual(res.marks[0].text, 'Cart');       // higher score first
    assert.ok(res.marks[0].score > res.marks[1].score);
    assert.strictEqual(res.marks[0].n, 2);               // badge number unchanged
  });
});
