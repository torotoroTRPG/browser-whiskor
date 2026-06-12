/**
 * tests/unit/ext-hello-reload.test.js
 *
 * Exercises the REAL server/core.js extension version handshake:
 *   - EXT_HELLO records { browser, version } per socket (visible in /health)
 *   - version mismatch → RELOAD_EXTENSION sent ONCE per stale version
 *     (loop guard: stale files on disk must not cause a reload loop)
 *   - extensionUpdate.autoReload=false → warn only, no reload
 *   - requestExtensionReload() / POST /api/extension/reload broadcast + count
 *   - no filesystem path ever appears in what crosses the wire
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WhiskorCore } = require('../../server/core');
const SERVER_VERSION = require('../../package.json').version;

function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
    on() {},
    of(type) { return this.sent.filter(m => m.type === type); },
  };
}

let core;
beforeEach(() => {
  core = new WhiskorCore({});            // all deps default to no-ops
  core._cleanupTimer && clearInterval(core._cleanupTimer);
});

describe('EXT_HELLO version handshake', () => {
  test('records browser + version for /health (no paths)', async () => {
    const ws = fakeWs();
    core.handleSWConnect(ws, {});
    await core.routeMessage({ type: 'EXT_HELLO', browser: 'chrome-mv3', version: SERVER_VERSION }, ws);

    const res = core.handleHttpRequest({ method: 'GET', url: { pathname: '/health' }, body: null });
    assert.deepStrictEqual(res.body.extensions, [{ browser: 'chrome-mv3', version: SERVER_VERSION }]);
    // Privacy: nothing path-like in the health payload
    assert.ok(!JSON.stringify(res.body).includes('.whiskor'));
  });

  test('matching version → no reload request', async () => {
    const ws = fakeWs();
    core.handleSWConnect(ws, {});
    await core.routeMessage({ type: 'EXT_HELLO', browser: 'chrome-mv3', version: SERVER_VERSION }, ws);
    assert.strictEqual(ws.of('RELOAD_EXTENSION').length, 0);
  });

  test('stale version → RELOAD_EXTENSION once, then warn-only (loop guard)', async () => {
    const ws1 = fakeWs();
    core.handleSWConnect(ws1, {});
    await core.routeMessage({ type: 'EXT_HELLO', browser: 'chrome-mv3', version: '0.0.1' }, ws1);

    const reloads = ws1.of('RELOAD_EXTENSION');
    assert.strictEqual(reloads.length, 1);
    assert.strictEqual(reloads[0].reason, 'version_mismatch');
    assert.strictEqual(reloads[0].serverVersion, SERVER_VERSION);

    // The extension reconnects still stale (files on disk unchanged) — the
    // server must NOT ask again, or a reload loop would spin forever.
    const ws2 = fakeWs();
    core.handleSWConnect(ws2, {});
    await core.routeMessage({ type: 'EXT_HELLO', browser: 'chrome-mv3', version: '0.0.1' }, ws2);
    assert.strictEqual(ws2.of('RELOAD_EXTENSION').length, 0);
  });

  test('extensionUpdate.autoReload=false → no reload, info still recorded', async () => {
    core.globalConfig.extensionUpdate = { autoReload: false };
    const ws = fakeWs();
    core.handleSWConnect(ws, {});
    await core.routeMessage({ type: 'EXT_HELLO', browser: 'firefox-mv2', version: '0.0.1' }, ws);

    assert.strictEqual(ws.of('RELOAD_EXTENSION').length, 0);
    assert.deepStrictEqual([...core._wsToExtInfo.values()],
      [{ browser: 'firefox-mv2', version: '0.0.1' }]);
  });

  test('disconnect removes the extension info from /health', async () => {
    const ws = fakeWs();
    let closeHandler;
    ws.on = (ev, fn) => { if (ev === 'close') closeHandler = fn; };
    core.handleSWConnect(ws, {});
    await core.routeMessage({ type: 'EXT_HELLO', browser: 'chrome-mv3', version: SERVER_VERSION }, ws);
    closeHandler();

    const res = core.handleHttpRequest({ method: 'GET', url: { pathname: '/health' }, body: null });
    assert.deepStrictEqual(res.body.extensions, []);
  });
});

describe('extension reload broadcast', () => {
  test('requestExtensionReload sends to every open socket and returns the count', () => {
    const a = fakeWs(), b = fakeWs(), closed = fakeWs();
    closed.readyState = 3;
    core.handleSWConnect(a, {});
    core.handleSWConnect(b, {});
    core.handleSWConnect(closed, {});

    const sent = core.requestExtensionReload('test');
    assert.strictEqual(sent, 2);
    assert.strictEqual(a.of('RELOAD_EXTENSION').length, 1);
    assert.strictEqual(b.of('RELOAD_EXTENSION')[0].reason, 'test');
    assert.strictEqual(closed.of('RELOAD_EXTENSION').length, 0);
  });

  test('POST /api/extension/reload routes to the broadcast and reports sent', () => {
    const ws = fakeWs();
    core.handleSWConnect(ws, {});
    const res = core.handleHttpRequest({
      method: 'POST', url: { pathname: '/api/extension/reload' }, body: { reason: 'setup' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true, sent: 1 });
    assert.strictEqual(ws.of('RELOAD_EXTENSION')[0].reason, 'setup');
  });
});
