/**
 * tests/unit/session-to-cache.test.js
 * Operation → cache integration — drive a realistic page session through the REAL
 * server/cache-writer.js handleMessage and verify each piece lands on disk and is
 * registered in the session index.
 *
 * This is the "operation to cache verification" guard: it exercises the full write
 * path + index assembly that the per-feature tests touch individually, and would
 * have caught a type that routes but writes nothing (e.g. the Vue3 case gap, the
 * PERF vitals omission).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whiskor-sess-'));
process.env.WHISKOR_CACHE_DIR = TMP;
const cw = require('../../server/cache-writer');

const TAB = 909090;
const URL = 'https://app.example.test/dashboard';
const send = (type, payload) => cw.handleMessage({ type, tabId: TAB, tabUrl: URL, payload });
const now = () => Date.now();

describe('a page session is fully reflected in the cache', () => {
  before(async () => {
    await send('FRAMEWORK_DETECTION', { capturedAt: now(), url: URL, detected: [{ frameworkId: 'react' }] });
    await send('PERF_METRICS', {
      capturedAt: now(),
      navigation: { ttfb: 40, domContentLoaded: 120, load: 300, transferSize: 2048 },
      vitals: { lcp: 250, lcpElement: 'H1', cls: 0.04, fcp: 90, longTasks: 1, longTaskTotalMs: 75 },
      resources: [], memory: null,
    });
    await send('CONSOLE_LOG', { entries: [{ level: 'error', message: 'boom', ts: now() }, { level: 'log', message: 'hi', ts: now() }] });
    await send('STORAGE_SNAPSHOT', { capturedAt: now(), local: { token: 'x' }, session: {} });
    await send('NETWORK_REQUEST', { reqId: 'n1', method: 'GET', url: '/api/data', ts: now() });
    await send('NETWORK_RESPONSE', { reqId: 'n1', url: '/api/data', status: 200, ts: now() });
  });

  it('registers every raw file in the session index', () => {
    const idx = cw.getSessionData(TAB);
    assert.strictEqual(idx.files.raw.perf, 'raw/perf/metrics.json');
    assert.strictEqual(idx.files.raw.console_logs, 'raw/console/logs.json');
    assert.strictEqual(idx.files.raw.storage, 'raw/storage/data.json');
    assert.strictEqual(idx.files.raw.network, 'raw/network/requests.json');
  });

  it('summary counts reflect what arrived', () => {
    const idx = cw.getSessionData(TAB);
    assert.deepStrictEqual(idx.summary.detectedFrameworks, ['react']);
    assert.strictEqual(idx.summary.consoleLogs, 2);
    assert.strictEqual(idx.summary.networkRequests, 1);
  });

  it('PERF_METRICS lands on disk WITH the Core Web Vitals (not just navigation)', () => {
    const perf = cw.readSessionFile(TAB, 'raw/perf/metrics.json');
    assert.ok(perf.vitals, 'vitals must be persisted, not dropped');
    assert.strictEqual(perf.vitals.lcp, 250);
    assert.strictEqual(perf.vitals.cls, 0.04);
    assert.strictEqual(perf.navigation.load, 300);
  });

  it('console errors are queryable from the cache', () => {
    const logs = cw.readSessionFile(TAB, 'raw/console/logs.json');
    assert.strictEqual(logs.totalEntries, 2);
    assert.ok(logs.entries.some(e => e.level === 'error' && e.message === 'boom'));
  });

  it('the network request is correlated with its response', () => {
    const r = cw.readSessionFile(TAB, 'raw/network/requests.json').requests.find(r => r.url === '/api/data');
    assert.strictEqual(r.requestId, 'n1');
    assert.strictEqual(r.status, 200);
  });
});
