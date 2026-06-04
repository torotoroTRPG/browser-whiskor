/**
 * tests/unit/mcp-capture-packed-som.test.js
 * Section 4.5 — Packed Set-of-Marks capture tool
 *
 * Exercises the REAL capture_packed_som handler (server/mcp/tools/capture.js)
 * via a capturing registry + a mock _capturePackedSom. The pixel packing lives
 * in the extension (canvas) and is covered separately; here we verify the tool's
 * response shaping and guards.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function captureTools(registerFn) {
  const map = {};
  const registry = {
    registerTools(arr) { for (const t of arr) map[t.definition.name] = t; },
    registerTool(def, handler) { map[def.name] = { definition: def, handler }; },
  };
  registerFn(registry);
  return map;
}

const tools = captureTools(require('../../server/mcp/tools/capture'));
const packed = tools['capture_packed_som'];

describe('4.5 capture_packed_som', () => {
  it('is registered as a capture tool requiring tabId', () => {
    assert.ok(packed, 'capture_packed_som must be registered');
    assert.deepStrictEqual(packed.definition.inputSchema.required, ['tabId']);
  });

  it('errors when no browser is connected', async () => {
    const res = await packed.handler({ tabId: 1 }, {});
    assert.match(res.error, /not available|no browser/i);
  });

  it('forwards max/types and returns the marks map + an image block (no pixels in text)', async () => {
    let gotOpts = null;
    const cb = {
      _capturePackedSom: async (tabId, opts) => {
        gotOpts = { tabId, opts };
        return {
          ok: true,
          filePath: '/cache/x.png',
          dataUrl: 'data:image/png;base64,QUJD',
          marks: [
            { n: 1, text: 'Login', selector: '#login', rect: { x: 0, y: 0, w: 80, h: 30 } },
            { n: 2, text: 'Cart', selector: '.cart', rect: { x: 90, y: 0, w: 40, h: 30 } },
          ],
        };
      },
    };
    const res = await packed.handler({ tabId: 7, max: 20, types: ['button', 'link'] }, cb);

    assert.strictEqual(gotOpts.tabId, 7);
    assert.strictEqual(gotOpts.opts.max, 20);
    assert.deepStrictEqual(gotOpts.opts.types, ['button', 'link']);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.count, 2);
    assert.strictEqual(res.marks[0].n, 1);
    assert.strictEqual(res.marks[0].selector, '#login');
    assert.strictEqual(res.filePath, '/cache/x.png');
    // The image rides as an MCP image block, never as base64 in the text JSON.
    assert.strictEqual(res._mcpImage.data, 'QUJD');
    assert.ok(!JSON.stringify({ ...res, _mcpImage: undefined }).includes('QUJD'));
  });

  it('defaults max to 40 when omitted', async () => {
    let opts = null;
    const cb = { _capturePackedSom: async (tabId, o) => { opts = o; return { ok: true, marks: [] }; } };
    await packed.handler({ tabId: 1 }, cb);
    assert.strictEqual(opts.max, 40);
  });

  it('orders marks by usage-stats score when a stats store is present (image numbers unchanged)', async () => {
    const cb = {
      _capturePackedSom: async () => ({
        ok: true,
        dataUrl: 'data:image/png;base64,QQ==',
        marks: [
          { n: 1, text: 'Login', selector: '#l', rect: { x: 0, y: 0, w: 1, h: 1 } },
          { n: 2, text: 'Cart', selector: '#c', rect: { x: 0, y: 0, w: 1, h: 1 } },
        ],
      }),
      _somStats: { rank: (texts) => texts.map((t) => ({ text: t, label: t.toLowerCase(), score: t === 'Cart' ? 5 : 1 })) },
    };
    const res = await packed.handler({ tabId: 1 }, cb);
    // Cart (score 5) is listed before Login (score 1) ...
    assert.strictEqual(res.marks[0].text, 'Cart');
    assert.ok(res.marks[0].score > res.marks[1].score);
    // ... but its image badge number is unchanged (still 2).
    assert.strictEqual(res.marks[0].n, 2);
    assert.match(res._note, /likely relevance/);
  });

  it('serves a fresh cached capture without re-capturing', async () => {
    let captured = 0;
    const cb = {
      _capturePackedSom: async () => { captured++; return { ok: true, dataUrl: 'data:image/png;base64,QQ==', marks: [] }; },
      _somCache: {
        get: () => ({ ok: true, dataUrl: 'data:image/png;base64,QzE=', filePath: '/c.png', marks: [{ n: 1, text: 'Cached', selector: '#c', rect: { w: 1 } }] }),
        set: () => {},
      },
    };
    const res = await packed.handler({ tabId: 1 }, cb);
    assert.strictEqual(captured, 0, 'must not re-capture when the cache is fresh');
    assert.strictEqual(res._cached, true);
    assert.strictEqual(res.marks[0].text, 'Cached');
  });

  it('captures and stores when the cache misses', async () => {
    let stored = null;
    const cb = {
      _capturePackedSom: async () => ({ ok: true, dataUrl: 'data:image/png;base64,QQ==', marks: [{ n: 1, text: 'Fresh', selector: '#f', rect: { w: 1 } }] }),
      _somCache: { get: () => null, set: (tabId, v) => { stored = { tabId, v }; } },
    };
    const res = await packed.handler({ tabId: 7 }, cb);
    assert.strictEqual(res._cached, false);
    assert.strictEqual(stored.tabId, 7);
    assert.strictEqual(res.marks[0].text, 'Fresh');
  });

  it('passes through a failed capture', async () => {
    const cb = { _capturePackedSom: async () => ({ ok: false, error: 'tab gone', tabGone: true, liveTabs: [2] }) };
    const res = await packed.handler({ tabId: 9 }, cb);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /tab gone/);
    assert.strictEqual(res.tabGone, true);
  });
});
