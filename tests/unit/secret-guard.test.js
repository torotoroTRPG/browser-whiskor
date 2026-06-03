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

describe('12.1 secret-guard — pattern detection (no pre-registration)', () => {
  it('auto-redacts an email it was never told about', () => {
    const g = createGuard({ enabled: true, knownValues: 'off', patterns: { email: true } });
    assert.strictEqual(g.active, true, 'patterns alone make the guard active');
    const out = g.redactString('write to bob@example.org today');
    assert.ok(!out.includes('bob@example.org'));
    assert.match(out, /type=email hint=@example\.org reason=pattern/);
  });

  it('redacts a Luhn-valid card number but leaves a random digit run alone', () => {
    const g = createGuard({ enabled: true, knownValues: 'off', patterns: { creditCard: true } });

    const valid = g.redactString('card 4242 4242 4242 4242 here');   // Luhn-valid
    assert.ok(!valid.includes('4242 4242 4242 4242'));
    assert.match(valid, /type=credit-card reason=pattern/);

    const bogus = g.redactString('order 1234 5678 9012 3456 ref');   // fails Luhn
    assert.match(bogus, /1234 5678 9012 3456/, 'a non-card digit run must not be redacted');
  });

  it('does not touch emails when the email pattern is disabled', () => {
    const g = createGuard({ enabled: true, knownValues: 'off', patterns: { email: false, creditCard: false } });
    assert.strictEqual(g.active, false);
    assert.strictEqual(g.redactString('bob@example.org'), 'bob@example.org');
  });

  it('known values and patterns coexist (known wins, then patterns sweep)', () => {
    process.env.WHISKOR_SECRETS = 'hunter2:password';
    const g = createGuard({ enabled: true, knownValues: 'env', patterns: { email: true } });
    delete process.env.WHISKOR_SECRETS;
    const out = g.redactString('login hunter2 mail a@b.io');
    assert.ok(!out.includes('hunter2'));
    assert.ok(!out.includes('a@b.io'));
    assert.match(out, /type=password/);
    assert.match(out, /type=email/);
  });
});

describe('12.1 secret-guard — disabled / empty', () => {
  it('is a passthrough when disabled', () => {
    const g = createGuard({ enabled: false });
    assert.strictEqual(g.active, false);
    assert.strictEqual(g.redactString('hunter2'), 'hunter2');
  });

  it('is a passthrough when enabled but nothing to match (no secrets, no patterns)', () => {
    const g = createGuard({ enabled: true, knownValues: 'env', patterns: { email: false, creditCard: false } });
    assert.strictEqual(g.active, false);
    assert.strictEqual(g.redactString('anything'), 'anything');
  });

  it('ignores too-short values (false-positive guard)', () => {
    process.env.WHISKOR_SECRETS = 'ab:token'; // 2 chars → ignored
    const g = createGuard({ enabled: true, knownValues: 'env', patterns: { email: false, creditCard: false } });
    delete process.env.WHISKOR_SECRETS;
    assert.strictEqual(g.active, false, 'a too-short value registers nothing');
    assert.strictEqual(g.redactString('ab cd ab'), 'ab cd ab');
  });
});
