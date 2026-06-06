/**
 * tests/unit/cache-writer-network.test.js
 * Review #2 — network capture field-name normalization.
 *
 * The page-JS hooks (injected/analyzers/network.js) emit NETWORK_REQUEST /
 * NETWORK_RESPONSE with `reqId / headers / bodyPreview / ts`, while mock-data and
 * the rest of the server use `requestId / requestHeaders / requestBody / startTime`.
 * The cache-writer used to read only the latter, so every live request had an
 * undefined id — dedup then collapsed them all onto the first entry (totalRequests
 * was permanently 1) and headers/body/tokens were dropped. This drives the REAL
 * server/cache-writer.js handleMessage and asserts both conventions survive.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// Point the cache at a throwaway dir BEFORE the module reads the env at load.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whiskor-net-'));
process.env.WHISKOR_CACHE_DIR = TMP;

const cw = require('../../server/cache-writer');

const TAB = 778899;
const URL = 'https://app.example.test/realtime';

async function req(payload) {
  await cw.handleMessage({ type: 'NETWORK_REQUEST', tabId: TAB, tabUrl: URL, payload });
}
async function res(payload) {
  await cw.handleMessage({ type: 'NETWORK_RESPONSE', tabId: TAB, tabUrl: URL, payload });
}
function readRequests() {
  return cw.readSessionFile(TAB, 'raw/network/requests.json');
}

describe('review #2 — network field-name normalization', () => {
  before(async () => {
    // Three distinct page-JS requests (injected naming), each with its own reqId.
    await req({ reqId: 'a1', method: 'GET',  url: '/api/one',   headers: { 'x-a': '1' }, ts: 1000 });
    await req({ reqId: 'b2', method: 'POST', url: '/api/two',   headers: { 'x-b': '2' }, ts: 1010, bodyPreview: '{"q":1}' });
    await req({ reqId: 'c3', method: 'GET',  url: '/api/three', headers: {},             ts: 1020 });
    await res({ reqId: 'a1', url: '/api/one', status: 200, headers: { 'content-type': 'application/json' }, bodyPreview: 'ok', ts: 1050 });
    await res({ reqId: 'b2', url: '/api/two', status: 500, ts: 1030 });
    // One request using the server/mock-data naming, to prove both still work.
    await req({ requestId: 'm9', method: 'GET', url: '/api/mock', startTime: 2000, requestHeaders: { 'x-m': '9' } });
    await res({ requestId: 'm9', status: 204, duration: 12 });
  });

  it('keeps each request distinct (no collapse onto a single null id)', () => {
    const data = readRequests();
    assert.ok(data, 'requests.json should exist');
    assert.strictEqual(data.totalRequests, 4, 'three page-JS + one mock = 4 distinct requests');
    assert.deepStrictEqual(
      data.requests.map(r => r.url).sort(),
      ['/api/mock', '/api/one', '/api/three', '/api/two'],
    );
  });

  it('maps page-JS reqId/headers/bodyPreview onto the canonical fields', () => {
    const r = readRequests().requests.find(r => r.url === '/api/two');
    assert.strictEqual(r.requestId, 'b2');
    assert.strictEqual(r.method, 'POST');
    assert.deepStrictEqual(r.requestHeaders, { 'x-b': '2' });
    assert.strictEqual(r.requestBody, '{"q":1}', 'bodyPreview should land in requestBody');
  });

  it('correlates responses to their request and derives duration from timestamps', () => {
    const one = readRequests().requests.find(r => r.url === '/api/one');
    assert.strictEqual(one.status, 200);
    assert.deepStrictEqual(one.responseHeaders, { 'content-type': 'application/json' });
    assert.strictEqual(one.responseBody, 'ok');
    assert.strictEqual(one.duration, 50, 'ts(1050) - startTime(1000)');
  });

  it('still honours the server/mock-data naming (requestId/duration)', () => {
    const m = readRequests().requests.find(r => r.url === '/api/mock');
    assert.strictEqual(m.requestId, 'm9');
    assert.strictEqual(m.status, 204);
    assert.strictEqual(m.duration, 12, 'explicit duration is used verbatim');
    assert.deepStrictEqual(m.requestHeaders, { 'x-m': '9' });
  });
});

describe('review #2 — WebSocket frame summaries', () => {
  const WTAB = 991122;
  const WURL = 'https://app.example.test/ws';
  async function wreq(p) { await cw.handleMessage({ type: 'NETWORK_REQUEST', tabId: WTAB, tabUrl: WURL, payload: p }); }
  async function wres(p) { await cw.handleMessage({ type: 'NETWORK_RESPONSE', tabId: WTAB, tabUrl: WURL, payload: p }); }
  const ws = () => cw.readSessionFile(WTAB, 'raw/network/requests.json').requests.find(r => r.url === 'wss://app.example.test/socket');

  before(async () => {
    await wreq({ reqId: 'ws-1', url: 'wss://app.example.test/socket', method: 'WS', kind: 'websocket', ts: 5000 });
    // throttled mid-stream summary: no status, must not wipe the (still-null) status
    await wres({ reqId: 'ws-1', url: 'wss://app.example.test/socket', frames: { sent: 2, received: 5, sentBytes: 40, recvBytes: 300, sample: [{ d: 'in', t: '{"hi":1}' }] }, ts: 5200 });
  });

  it('records the WS connection as a request entry with method WS', () => {
    const r = ws();
    assert.ok(r, 'WS connection should be captured');
    assert.strictEqual(r.method, 'WS');
    assert.strictEqual(r.initiatorType, 'websocket', 'kind maps to initiatorType');
  });

  it('stores the throttled frame summary without clobbering status', () => {
    const r = ws();
    assert.strictEqual(r.status, null, 'mid-stream summary carries no status → stays null');
    assert.strictEqual(r.frames.received, 5);
    assert.strictEqual(r.frames.recvBytes, 300);
  });

  it('a later close frame sets the close code but keeps the latest summary', async () => {
    await wres({ reqId: 'ws-1', url: 'wss://app.example.test/socket', status: 1000, frames: { sent: 3, received: 9, sentBytes: 60, recvBytes: 500, sample: [] }, ts: 6000 });
    const r = ws();
    assert.strictEqual(r.status, 1000, 'close code recorded');
    assert.strictEqual(r.frames.received, 9, 'frame summary updated to final');
    assert.strictEqual(r.duration, 1000, 'ts(6000) - startTime(5000)');
  });
});

describe('review #2 — NETWORK_ERROR is captured, not dropped', () => {
  const ETAB = 443322;
  const EURL = 'https://app.example.test/err';
  const send = (type, payload) => cw.handleMessage({ type, tabId: ETAB, tabUrl: EURL, payload });
  const find = (url) => cw.readSessionFile(ETAB, 'raw/network/requests.json').requests.find(r => r.url === url);

  it('marks an in-flight request as errored (matched by id)', async () => {
    await send('NETWORK_REQUEST', { reqId: 'e1', method: 'GET', url: '/api/flaky', ts: 1000 });
    await send('NETWORK_ERROR', { reqId: 'e1', url: '/api/flaky', error: 'Failed to fetch', ts: 1080 });
    const r = find('/api/flaky');
    assert.strictEqual(r.error, 'Failed to fetch');
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.duration, 80, 'derived from ts - startTime');
  });

  it('keeps a minimal entry when the error has no recorded request', async () => {
    await send('NETWORK_ERROR', { reqId: 'orphan', method: 'POST', url: '/api/orphan', error: 'CORS', ts: 2000 });
    const r = find('/api/orphan');
    assert.ok(r, 'orphan failure should still be visible');
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.error, 'CORS');
    assert.strictEqual(r.method, 'POST');
  });
});
