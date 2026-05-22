'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');

// Geometry clamping logic extracted from cropImage (works without browser DOM APIs)
function computeCrop(imgW, imgH, viewW, rect, padding) {
  const dpr = Math.round((imgW / viewW) * 10) / 10 || 1;
  const sx = Math.max(0, Math.round((rect.x - padding) * dpr));
  const sy = Math.max(0, Math.round((rect.y - padding) * dpr));
  const sw = Math.min(imgW - sx, Math.round((rect.w + padding * 2) * dpr));
  const sh = Math.min(imgH - sy, Math.round((rect.h + padding * 2) * dpr));
  if (sw <= 0 || sh <= 0) {
    return { error: 'Crop region is outside the visible viewport' };
  }
  return { sx, sy, sw, sh, dpr };
}

describe('cropImage [sw.js element crop]', () => {
  it('should reject when clamping results in negative dimensions', () => {
    // sx clamps to 100 (= imgW), so sw = min(100-100, 1) = 0
    const r = computeCrop(100, 100, 1920, { x: 1000, y: 1000, w: 10, h: 10 }, 0);
    assert.strictEqual(r.error, 'Crop region is outside the visible viewport');
  });

  it('should compute valid crop rect for a normal request', () => {
    const r = computeCrop(3840, 2160, 1920, { x: 100, y: 50, w: 200, h: 100 }, 8);
    assert.ok(r.sx >= 0);
    assert.ok(r.sy >= 0);
    assert.ok(r.sw > 0);
    assert.ok(r.sh > 0);
    assert.strictEqual(r.dpr, 2);
  });
});
