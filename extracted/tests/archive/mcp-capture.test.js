'use strict';
const { describe, it, mock } = require('node:test');
const assert = require('node:assert');

function buildHandler(captureScreenshot) {
  return async (args) => {
    if (!captureScreenshot) {
      return { error: 'Screenshot service not available (no browser connected).' };
    }

    if (!args.selector && !args.rect) {
      return { error: 'Provide either selector or rect.' };
    }

    const opts = {
      selector: args.selector || undefined,
      rect:     args.rect     || undefined,
      padding:  typeof args.padding  === 'number' ? args.padding  : 4,
      format:   args.format  || 'png',
      quality:  typeof args.quality  === 'number' ? args.quality  : 85,
    };

    const full = await captureScreenshot(args.tabId, { marks: false });
    if (!full.ok) return full;

    const response = {
      ok:         true,
      capturedAt: full.capturedAt,
      rect:       opts.rect,
      padding:    opts.padding,
    };

    if (opts.rect) {
      response._note = `${opts.rect.w}\u00d7${opts.rect.h}px element (padding: ${opts.padding}px)`;
    }

    if (full.dataUrl) {
      response.dataUrl = full.dataUrl;
      const b64 = full.dataUrl.split(',')[1] || '';
      response.sizeBytes = Math.round(b64.length * 0.75);
    }

    return response;
  };
}

describe('mcp-capture [capture_element_screenshot]', () => {
  it('should return error when neither selector nor rect is provided', async () => {
    const handler = buildHandler(() => ({ ok: true, dataUrl: 'data:image/png,abc', capturedAt: 1 }));
    const result = await handler({ tabId: 1 });
    assert.strictEqual(result.error, 'Provide either selector or rect.');
  });

  it('should return ok with expected shape when rect is provided', async () => {
    const capturedAt = 12345;
    const fakeScreenshot = mock.fn(() => ({ ok: true, dataUrl: 'data:image/png,abc', capturedAt }));
    const handler = buildHandler(fakeScreenshot);
    const result = await handler({ tabId: 1, rect: { x: 10, y: 20, w: 200, h: 48 } });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.capturedAt, capturedAt);
    assert.deepStrictEqual(result.rect, { x: 10, y: 20, w: 200, h: 48 });
    assert.strictEqual(result.padding, 4);
    assert.ok(result.dataUrl);
    assert.ok(typeof result.sizeBytes === 'number');
    assert.ok(result._note.includes('200\u00d748px'));
  });

  it('should default padding to 4', async () => {
    const fakeScreenshot = mock.fn(() => ({ ok: true, dataUrl: 'data:image/png,abc', capturedAt: 1 }));
    const handler = buildHandler(fakeScreenshot);
    const result = await handler({ tabId: 1, rect: { x: 0, y: 0, w: 100, h: 100 } });
    assert.strictEqual(result.padding, 4);
  });
});
