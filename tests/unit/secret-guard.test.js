/**
 * tests/unit/secret-guard.test.js
 * Section 12.1 — Secret Guard (redaction)
 *
 * Exercises the REAL server/secret-guard.js. Secrets are injected via the
 * WHISKOR_SECRETS env source (knownValues:'env') so the suite is deterministic
 * and never depends on a secrets.local.json file.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGuard } = require('../../server/secret-guard');

afterEach(() => { delete process.env.WHISKOR_SECRETS; });

function guardWith(secretsEnv, overrides = {}) {
  process.env.WHISKOR_SECRETS = secretsEnv;
  return createGuard({ enabled: true, knownValues: 'env', ...overrides });
}

describe('12.1 secret-guard — known-value redaction', () => {
  it('replaces a known value with a value-free token', () => {
    const g = guardWith('hunter2:password');
    const out = g.redactString('my login is hunter2 ok');
    assert.ok(!out.includes('hunter2'), 'the raw secret must not survive');
    assert.match(out, /\[WHISKOR_REDACTED type=password reason=user-blacklist\]/);
  });

  it('exposes only the domain as a hint for emails', () => {
    const g = guardWith('alice@gmail.com:email');
    const out = g.redactString('contact alice@gmail.com please');
    assert.ok(!out.includes('alice@gmail.com'));
    assert.match(out, /type=email/);
    assert.match(out, /hint=@gmail\.com/);
    assert.ok(!out.includes('alice'), 'the local-part must not leak');
  });

  it('gives passwords/tokens no hint at all', () => {
    const g = guardWith('s3cr3t-token-value:token');
    const out = g.redactString('Authorization: s3cr3t-token-value');
    assert.ok(!/hint=/.test(out), 'tokens must not expose a hint');
  });

  it('replaces every occurrence', () => {
    const g = guardWith('hunter2:password');
    const out = g.redactString('hunter2 then hunter2 again');
    assert.ok(!out.includes('hunter2'));
    assert.strictEqual(out.match(/WHISKOR_REDACTED/g).length, 2);
  });

  it('redacts the longer secret first when one contains another', () => {
    const g = guardWith('pass:password,passw0rd-long:password');
    const out = g.redactString('value passw0rd-long here');
    // The long secret must be fully redacted, not chopped by the short one.
    assert.ok(!out.includes('passw0rd-long'));
    assert.ok(!out.includes('w0rd-long'), 'long secret must redact as a whole');
  });
});

describe('12.1 secret-guard — deep + message', () => {
  it('recurses through nested objects and arrays', () => {
    const g = guardWith('hunter2:password');
    const out = g.redactDeep({ a: { b: ['x', 'hunter2', { c: 'hunter2!' }] }, n: 5 });
    assert.ok(!JSON.stringify(out).includes('hunter2'));
    assert.strictEqual(out.n, 5, 'non-strings pass through unchanged');
  });

  it('redacts msg.payload but leaves routing fields intact', () => {
    const g = guardWith('alice@gmail.com:email');
    const msg = { type: 'TEXT_COORDS', tabId: 7, payload: { words: [{ text: 'alice@gmail.com' }] } };
    g.redactMessage(msg);
    assert.strictEqual(msg.type, 'TEXT_COORDS');
    assert.strictEqual(msg.tabId, 7);
    assert.ok(!JSON.stringify(msg.payload).includes('alice@gmail.com'));
  });
});

describe('12.1 secret-guard — disabled / empty', () => {
  it('is a passthrough when disabled', () => {
    const g = createGuard({ enabled: false });
    assert.strictEqual(g.active, false);
    assert.strictEqual(g.redactString('hunter2'), 'hunter2');
  });

  it('is a passthrough when enabled but no secrets are registered', () => {
    const g = createGuard({ enabled: true, knownValues: 'env' }); // no WHISKOR_SECRETS
    assert.strictEqual(g.active, false);
    assert.strictEqual(g.redactString('anything'), 'anything');
  });

  it('ignores too-short values (false-positive guard)', () => {
    const g = guardWith('ab:token'); // 2 chars → ignored
    assert.strictEqual(g.redactString('ab cd ab'), 'ab cd ab');
  });
});
