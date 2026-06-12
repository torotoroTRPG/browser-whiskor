/**
 * tests/unit/text-coords-viewport-persist.test.js
 * viewport.json must exist after a collect, not only after a scroll.
 *
 * VIEWPORT_UPDATE is emitted by the extension only on scroll/resize, so on pages
 * that never scroll raw/visual/viewport.json was never written and the documented
 * GET /api/sessions/:tabId/raw/visual/viewport.json returned 404 forever. The
 * TEXT_COORDS payload carries the same viewport snapshot — the cache-writer now
 * persists it from there. This drives the REAL handleMessage and asserts the file
 * and its index entry appear, and that a viewport-less payload does not clobber
 * a previously stored viewport.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whiskor-vp-'));
process.env.WHISKOR_CACHE_DIR = TMP;
const cw = require('../../server/cache-writer');

const TAB = 771144;
const URL = 'https://app.example.test/no-scroll';
const send = (type, payload) => cw.handleMessage({ type, tabId: TAB, tabUrl: URL, payload });

const VP = { width: 1280, height: 800, scrollX: 0, scrollY: 0 };
const textCoordsPayload = (extra = {}) => ({
  capturedAt: Date.now(),
  pageUrl: URL,
  totalWords: 1,
  words: [{ text: 'hello', xpath: '/html/body/p', absoluteX: 10, absoluteY: 20, width: 40, height: 12 }],
  lines: [], blocks: [], fullText: 'hello',
  ...extra,
});

describe('TEXT_COORDS persists the viewport snapshot', () => {
  before(async () => {
    await send('TEXT_COORDS', textCoordsPayload({ viewport: VP }));
  });

  it('writes raw/visual/viewport.json without any scroll event', () => {
    const vp = cw.readSessionFile(TAB, 'raw/visual/viewport.json');
    assert.ok(vp, 'viewport.json should exist after a plain collect');
    assert.strictEqual(vp.width, VP.width);
    assert.strictEqual(vp.height, VP.height);
    assert.ok(vp.capturedAt, 'capturedAt is stamped');
  });

  it('registers the index entry and in-memory viewport', () => {
    const s = cw.getSessionData(TAB);
    assert.strictEqual(s.files.raw.viewport, 'raw/visual/viewport.json');
  });

  it('a viewport-less TEXT_COORDS does not clobber the stored viewport', async () => {
    await send('TEXT_COORDS', textCoordsPayload());
    const vp = cw.readSessionFile(TAB, 'raw/visual/viewport.json');
    assert.ok(vp, 'viewport.json still present');
    assert.strictEqual(vp.width, VP.width, 'previous snapshot retained');
  });
});
