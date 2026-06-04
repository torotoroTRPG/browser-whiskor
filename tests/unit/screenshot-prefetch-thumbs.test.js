/**
 * tests/unit/screenshot-prefetch-thumbs.test.js
 * Section 4.10 — packed-SoM warms the per-element thumbnail cache (T2 slice B3)
 *
 * When prefetch is on, a packed capture emits per-element thumbnails (cropped from
 * the same bitmap by the extension) and the worker stores them in the thumbnail
 * cache under the selector key get_element_thumbnail uses — so a later selector
 * lookup is an instant hit, with no extra captureVisibleTab. The agent-facing
 * packed response stays compact (no thumbs).
 *
 * Exercises the REAL screenshot-manager + som-thumbnails.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sm = require('../../server/screenshot-manager');
const { createThumbStore, thumbSignature } = require('../../server/som-thumbnails');

afterEach(() => {
  sm.setSomCache(null); sm.setSomStats(null); sm.setSomThumbs(null);
  sm.setThumbPrefetch(false); sm.setBroadcast(null);
});

function driveCapture(tabId, marks) {
  let reqId = null, sentOpts = null;
  sm.setBroadcast((m) => { reqId = m.reqId; sentOpts = m.opts; });
  const p = sm.capturePackedSom(tabId, {});
  sm.handleResult({ reqId, dataUrl: 'data:image/png;base64,QQ==', marks });
  return { p, getSentOpts: () => sentOpts };
}

describe('4.10 packed-SoM thumbnail prefetch', () => {
  it('warms the per-element cache and asks the extension for thumbs when on', async () => {
    const thumbs = createThumbStore();
    sm.setSomCache(null); sm.setSomThumbs(thumbs); sm.setThumbPrefetch(true);

    const { p, getSentOpts } = driveCapture(1, [
      { n: 1, text: 'Login', selector: '#login', rect: { x: 0, y: 0, w: 80, h: 30 }, thumb: 'data:image/jpeg;base64,Tg==' },
    ]);
    const res = await p;

    assert.strictEqual(getSentOpts().emitThumbs, true, 'asked the extension to emit thumbs');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.marks[0].thumb, undefined, 'agent-facing marks stay compact');

    // Hit under the same key get_element_thumbnail({selector}) uses (selector + 96).
    const hit = thumbs.get(1, thumbSignature('#login#96', {}));
    assert.ok(hit, 'thumbnail cache warmed');
    assert.strictEqual(hit.dataUrl, 'data:image/jpeg;base64,Tg==');
  });

  it('does not emit thumbs or warm the cache when prefetch is off', async () => {
    const thumbs = createThumbStore();
    sm.setSomCache(null); sm.setSomThumbs(thumbs); sm.setThumbPrefetch(false);

    const { p, getSentOpts } = driveCapture(2, [
      { n: 1, selector: '#x', rect: { w: 1 }, thumb: 'data:image/jpeg;base64,Tg==' },
    ]);
    await p;

    assert.ok(!getSentOpts().emitThumbs, 'did not ask for thumbs');
    assert.strictEqual(thumbs.get(2, thumbSignature('#x#96', {})), null, 'cache not warmed');
  });
});
