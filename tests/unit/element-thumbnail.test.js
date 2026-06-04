/**
 * tests/unit/element-thumbnail.test.js
 * Section 4.8 — Per-element thumbnail capture (T2) cache path + MCP tool
 *
 * Worker path: REAL screenshot-manager.captureElementThumbnail + REAL thumb store,
 * driving the underlying single-element capture via handleResult. MCP tool: REAL
 * get_element_thumbnail handler as a thin pass-through over _captureElementThumbnail.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sm = require('../../server/screenshot-manager');
const { createThumbStore } = require('../../server/som-thumbnails');

describe('4.8 captureElementThumbnail (worker cache)', () => {
  it('captures on a miss then serves the 2nd reference from cache', async () => {
    sm.setSomThumbs(createThumbStore());
    let reqId = null;
    sm.setBroadcast((m) => { reqId = m.reqId; });
    const p1 = sm.captureElementThumbnail(1, { selector: '#login' });
    sm.handleResult({ reqId, dataUrl: 'data:image/jpeg;base64,QQ==', rect: { x: 0, y: 0, w: 80, h: 30 } });
    const r1 = await p1;
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1._cached, false);

    let broadcasts = 0;
    sm.setBroadcast(() => { broadcasts++; });
    const r2 = await sm.captureElementThumbnail(1, { selector: '#login' });
    assert.strictEqual(broadcasts, 0, 'a cached element must not re-capture');
    assert.strictEqual(r2._cached, true);
    assert.strictEqual(r2.dataUrl, r1.dataUrl);
  });

  it('re-captures after the element/page changes (cache invalidated)', async () => {
    const store = createThumbStore();
    sm.setSomThumbs(store);
    let reqId = null;
    sm.setBroadcast((m) => { reqId = m.reqId; });
    const p1 = sm.captureElementThumbnail(2, { selector: '#x' });
    sm.handleResult({ reqId, dataUrl: 'data:image/jpeg;base64,QQ==', rect: { x: 0, y: 0, w: 40, h: 40 } });
    await p1;

    store.markChanged(2, Date.now() + 1000);

    let captured = 0;
    sm.setBroadcast((m) => { reqId = m.reqId; captured++; });
    const p2 = sm.captureElementThumbnail(2, { selector: '#x' });
    sm.handleResult({ reqId, dataUrl: 'data:image/jpeg;base64,Qg==', rect: { x: 0, y: 0, w: 40, h: 40 } });
    const r2 = await p2;
    assert.strictEqual(captured, 1, 'a changed page must re-capture');
    assert.strictEqual(r2._cached, false);
  });
});

function captureTools(registerFn) {
  const map = {};
  const registry = {
    registerTools(arr) { for (const t of arr) map[t.definition.name] = t; },
    registerTool(def, handler) { map[def.name] = { definition: def, handler }; },
  };
  registerFn(registry);
  return map;
}
const tools = captureTools(require('../../server/mcp/tools/capture-element'));
const thumb = tools['get_element_thumbnail'];

describe('4.8 get_element_thumbnail (MCP tool)', () => {
  it('is registered requiring tabId', () => {
    assert.ok(thumb);
    assert.deepStrictEqual(thumb.definition.inputSchema.required, ['tabId']);
  });

  it('errors without a connected browser', async () => {
    const res = await thumb.handler({ tabId: 1, selector: '#a' }, {});
    assert.match(res.error, /not available|no browser/i);
  });

  it('requires selector or rect', async () => {
    const res = await thumb.handler({ tabId: 1 }, { _captureElementThumbnail: async () => ({ ok: true }) });
    assert.match(res.error, /selector or rect/i);
  });

  it('returns the image as a block and surfaces _cached (no base64 in text)', async () => {
    const cb = {
      _captureElementThumbnail: async () => ({ ok: true, _cached: true, rect: { w: 80, h: 30 }, dataUrl: 'data:image/jpeg;base64,QUJD' }),
    };
    const res = await thumb.handler({ tabId: 1, selector: '#login' }, cb);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res._cached, true);
    assert.strictEqual(res._mcpImage.data, 'QUJD');
    assert.match(res._note, /cached thumbnail/i);
    assert.ok(!JSON.stringify({ ...res, _mcpImage: undefined }).includes('QUJD'));
  });

  it('passes through a failed capture', async () => {
    const cb = { _captureElementThumbnail: async () => ({ ok: false, error: 'tab gone', tabGone: true, liveTabs: [2] }) };
    const res = await thumb.handler({ tabId: 9, selector: '#x' }, cb);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /tab gone/);
    assert.strictEqual(res.tabGone, true);
  });
});
