/**
 * tests/integration/secret-guard-flow.test.js
 *
 * Proves the redaction chokepoint: a secret present in collected data is
 * replaced before the message reaches the cache (and therefore before it is
 * persisted, broadcast, or read by the agent). Wires the real WhiskorCore with
 * the real secret guard and a recording cache.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WhiskorCore } = require('../../server/core');
const { createGuard } = require('../../server/secret-guard');

describe('Secret guard — core ingestion chokepoint', () => {
  it('redacts a secret in collected data before it reaches the cache', async () => {
    process.env.WHISKOR_SECRETS = 'alice@gmail.com:email';
    const guard = createGuard({ enabled: true, knownValues: 'env' });
    delete process.env.WHISKOR_SECRETS;

    let received = null;
    const cache = { handleMessage: async (m) => { received = m; } };
    const core = new WhiskorCore({ cache, secretGuard: guard });

    await core.routeMessage(
      { type: 'TEXT_COORDS', tabId: 1, payload: { words: [{ text: 'reach me at alice@gmail.com' }] } },
      undefined,
    );

    clearInterval(core._cleanupTimer);

    assert.ok(received, 'cache must have received the message');
    const body = JSON.stringify(received.payload);
    assert.ok(!body.includes('alice@gmail.com'), 'the secret must be gone before the cache sees it');
    assert.match(body, /WHISKOR_REDACTED type=email hint=@gmail\.com/);
  });

  it('leaves data untouched when the guard is disabled (default passthrough)', async () => {
    let received = null;
    const cache = { handleMessage: async (m) => { received = m; } };
    const core = new WhiskorCore({ cache }); // no secretGuard → passthrough default

    await core.routeMessage(
      { type: 'TEXT_COORDS', tabId: 1, payload: { words: [{ text: 'alice@gmail.com' }] } },
      undefined,
    );
    clearInterval(core._cleanupTimer);

    assert.match(JSON.stringify(received.payload), /alice@gmail\.com/);
  });

  it('reports secret-guard status on /health (counts only, never values)', () => {
    process.env.WHISKOR_SECRETS = 'alice@gmail.com:email,hunter2:password';
    const guard = createGuard({ enabled: true, knownValues: 'env' });
    delete process.env.WHISKOR_SECRETS;

    const core = new WhiskorCore({ secretGuard: guard });
    const res = core.handleHttpRequest({ method: 'GET', url: { pathname: '/health' } });
    clearInterval(core._cleanupTimer);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.secretGuard.active, true);
    assert.strictEqual(res.body.secretGuard.knownValues, 2);
    assert.strictEqual(res.body.secretGuard.patterns, 3, 'email + creditCard + jwt default on');
    const dump = JSON.stringify(res.body);
    assert.ok(!dump.includes('alice@gmail.com') && !dump.includes('hunter2'),
      'health must expose counts, never the secret values');
  });

  it('reports an inactive secret-guard by default', () => {
    const core = new WhiskorCore({});
    const res = core.handleHttpRequest({ method: 'GET', url: { pathname: '/health' } });
    clearInterval(core._cleanupTimer);
    assert.strictEqual(res.body.secretGuard.active, false);
    assert.strictEqual(res.body.secretGuard.knownValues, 0);
  });
});
