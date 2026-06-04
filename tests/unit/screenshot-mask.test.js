/**
 * tests/unit/screenshot-mask.test.js
 * Section 4.9 — Secret-guard screenshot masking is applied worker-side
 *
 * Masking moved from the MCP tool to screenshot-manager.capture so it applies over
 * MCP stdio, HTTP /api/screenshot, and the proxy forward alike (it used to be dead
 * under the proxy, which never received the guard, and dropped on the HTTP path).
 * Exercises the REAL server/screenshot-manager.capture with an injected provider.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sm = require('../../server/screenshot-manager');

// Drive one capture: it awaits the mask provider, then broadcasts (setting `sent`),
// then waits for handleResult. Flush microtasks, resolve, and inspect the broadcast.
async function runCapture(opts) {
  let sent = null;
  sm.setBroadcast((m) => { sent = m; });
  const p = sm.capture(1, opts);
  for (let i = 0; i < 5 && !sent; i++) await new Promise((r) => setTimeout(r, 2));
  sm.handleResult({ reqId: sent.reqId, dataUrl: 'data:image/png;base64,QQ==' });
  await p;
  return sent;
}

afterEach(() => { sm.setMaskProvider(null); });

describe('4.9 worker-side screenshot masking', () => {
  it('adds the provider\'s rects to the capture broadcast', async () => {
    const rects = [{ x: 1, y: 2, width: 3, height: 4 }];
    sm.setMaskProvider(async () => rects);
    const sent = await runCapture({ marks: false });
    assert.deepStrictEqual(sent.opts.maskRects, rects);
  });

  it('leaves maskRects unset when the provider returns nothing', async () => {
    sm.setMaskProvider(async () => []);
    const sent = await runCapture({});
    assert.strictEqual(sent.opts.maskRects, undefined);
  });

  it('does not call the provider when the caller already supplied maskRects', async () => {
    let called = false;
    sm.setMaskProvider(async () => { called = true; return [{ x: 9, y: 9, width: 9, height: 9 }]; });
    const sent = await runCapture({ maskRects: [{ x: 0, y: 0, width: 1, height: 1 }] });
    assert.strictEqual(called, false);
    assert.deepStrictEqual(sent.opts.maskRects, [{ x: 0, y: 0, width: 1, height: 1 }]);
  });

  it('still captures when the provider throws (masking is best-effort)', async () => {
    sm.setMaskProvider(async () => { throw new Error('boom'); });
    const sent = await runCapture({});
    assert.ok(sent, 'capture proceeded despite the masking error');
    assert.strictEqual(sent.opts.maskRects, undefined);
  });
});
