/**
 * tests/unit/cache-writer-framework-snapshots.test.js
 * Design-drift fix — framework snapshots that were silently dropped.
 *
 * The vue3 / alpine / preact / solid adapters emit VUE3_SNAPSHOT / ALPINE_SNAPSHOT
 * / PREACT_SNAPSHOT / SOLID_SNAPSHOT, but the cache-writer only had cases for the
 * other frameworks (plus a vestigial VUE_SNAPSHOT with no producer). Their state
 * therefore never reached the cache. This drives the REAL handleMessage and asserts
 * each snapshot now lands on disk under its raw/<fw>/snapshot.json path.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whiskor-fw-'));
process.env.WHISKOR_CACHE_DIR = TMP;
const cw = require('../../server/cache-writer');

const TAB = 553311;
const URL = 'https://app.example.test/fw';
const send = (type, payload) => cw.handleMessage({ type, tabId: TAB, tabUrl: URL, payload });

const CASES = [
  { type: 'VUE3_SNAPSHOT',   rel: 'raw/vue/snapshot.json',     idxKey: 'vue_snapshot',     fresh: 'vue3' },
  { type: 'PREACT_SNAPSHOT', rel: 'raw/preact/snapshot.json',  idxKey: 'preact_snapshot',  fresh: 'preact' },
  { type: 'ALPINE_SNAPSHOT', rel: 'raw/alpine/snapshot.json',  idxKey: 'alpine_snapshot',  fresh: 'alpine' },
  { type: 'SOLID_SNAPSHOT',  rel: 'raw/solid/snapshot.json',   idxKey: 'solid_snapshot',   fresh: 'solid' },
];

describe('framework snapshots reach the cache', () => {
  before(async () => {
    for (const c of CASES) {
      await send(c.type, { capturedAt: Date.now(), marker: c.type, tree: { n: 'Root' } });
    }
  });

  for (const c of CASES) {
    it(`${c.type} → ${c.rel}`, () => {
      const data = cw.readSessionFile(TAB, c.rel);
      assert.ok(data, `${c.rel} should be written`);
      assert.strictEqual(data.marker, c.type, 'payload persisted verbatim');
    });

    it(`${c.type} registers its index file + freshness`, () => {
      const idx = cw.getSessionData(TAB);
      assert.strictEqual(idx.files.raw[c.idxKey], c.rel);
      assert.ok(idx.dataFreshness[c.fresh] != null, `freshness key ${c.fresh} should be set`);
    });
  }

  it('legacy VUE_SNAPSHOT alias still routes to the same vue file', async () => {
    await send('VUE_SNAPSHOT', { capturedAt: Date.now(), marker: 'LEGACY' });
    assert.strictEqual(cw.readSessionFile(TAB, 'raw/vue/snapshot.json').marker, 'LEGACY');
  });
});
