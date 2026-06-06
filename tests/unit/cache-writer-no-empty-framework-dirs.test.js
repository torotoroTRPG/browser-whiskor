/**
 * tests/unit/cache-writer-no-empty-framework-dirs.test.js
 * C-2 — framework dirs are created on demand, not pre-made empty.
 *
 * getSession() used to pre-mkdir raw/react, raw/vue, raw/angular, raw/svelte for
 * every session, so a single-framework page left empty noise dirs (and export /
 * dashboard surfaced them). They are now created only when a snapshot actually
 * lands — matching how preact/alpine/solid already behaved.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whiskor-emptydir-'));
process.env.WHISKOR_CACHE_DIR = TMP;
const cw = require('../../server/cache-writer');

const TAB = 246810;
const URL = 'https://app.example.test/react-only';
const send = (type, payload) => cw.handleMessage({ type, tabId: TAB, tabUrl: URL, payload });
const has = (rel) => fs.existsSync(path.join(cw.getSessionDir(TAB), rel));

describe('C-2 no empty framework dirs', () => {
  before(async () => {
    // Create the session with a non-framework message, then a single React snapshot.
    await send('NETWORK_REQUEST', { reqId: 'x', method: 'GET', url: '/api', ts: Date.now() });
    await send('REACT_SNAPSHOT', { capturedAt: Date.now(), tree: { n: 'Root' } });
  });

  it('does NOT pre-create framework dirs for absent frameworks', () => {
    for (const fw of ['raw/vue', 'raw/angular', 'raw/svelte', 'raw/preact', 'raw/alpine', 'raw/solid']) {
      assert.strictEqual(has(fw), false, `${fw} should not exist for a React-only page`);
    }
  });

  it('creates the framework dir on demand when its snapshot lands', () => {
    assert.strictEqual(has('raw/react/snapshot.json'), true, 'react snapshot wrote its dir+file');
  });

  it('still pre-creates the always-on data dirs', () => {
    for (const d of ['raw/network', 'raw/console', 'raw/perf', 'raw/dom']) {
      assert.strictEqual(has(d), true, `${d} should be present`);
    }
  });
});
