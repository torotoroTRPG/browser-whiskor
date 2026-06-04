/**
 * tests/unit/config-env-overrides.test.js
 * Section 1.x — WHISKOR_* env overrides, including nested keys
 *
 * Exercises the REAL server/config-loader.applyEnvOverrides. Nested keys
 * (privacy.secretGuard.enabled) were previously unreachable via env even though
 * the docs advertise .env overrides — this guards the fix.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyEnvOverrides } = require('../../server/config-loader');

const TOUCHED = [];
function setEnv(k, v) { TOUCHED.push(k); process.env[k] = v; }
afterEach(() => { for (const k of TOUCHED.splice(0)) delete process.env[k]; });

function baseConfig() {
  return {
    security:  { allowExecuteJs: false },
    collection:{ maxConsoleLogs: 2000 },
    privacy:   { secretGuard: { enabled: false, knownValues: 'file' } },
    agentControl: { packedSom: { prefetchOnNavigate: false } },
  };
}

describe('1.x env overrides', () => {
  it('overrides a one-level key (backward compatible)', () => {
    setEnv('WHISKOR_SECURITY_ALLOWEXECUTEJS', 'true');
    const c = applyEnvOverrides(baseConfig());
    assert.strictEqual(c.security.allowExecuteJs, true);
  });

  it('overrides a multi-word one-level key', () => {
    setEnv('WHISKOR_COLLECTION_MAXCONSOLELOGS', '500');
    const c = applyEnvOverrides(baseConfig());
    assert.strictEqual(c.collection.maxConsoleLogs, 500);
  });

  it('overrides a two-level nested key (privacy.secretGuard.enabled)', () => {
    setEnv('WHISKOR_PRIVACY_SECRETGUARD_ENABLED', 'true');
    const c = applyEnvOverrides(baseConfig());
    assert.strictEqual(c.privacy.secretGuard.enabled, true);
    assert.strictEqual(c.privacy.secretGuard.knownValues, 'file', 'siblings untouched');
  });

  it('overrides a nested key spelled with underscores between words', () => {
    setEnv('WHISKOR_PRIVACY_SECRET_GUARD_ENABLED', 'true');
    const c = applyEnvOverrides(baseConfig());
    assert.strictEqual(c.privacy.secretGuard.enabled, true);
  });

  it('overrides agentControl.packedSom.prefetchOnNavigate', () => {
    setEnv('WHISKOR_AGENTCONTROL_PACKEDSOM_PREFETCHONNAVIGATE', 'true');
    const c = applyEnvOverrides(baseConfig());
    assert.strictEqual(c.agentControl.packedSom.prefetchOnNavigate, true);
  });

  it('ignores an env var that matches no config key (never creates keys)', () => {
    setEnv('WHISKOR_PRIVACY_NOPE_X', 'true');
    const c = applyEnvOverrides(baseConfig());
    assert.ok(!('nope' in c.privacy));
    assert.deepStrictEqual(Object.keys(c.privacy), ['secretGuard']);
  });

  it('leaves config untouched when no WHISKOR_* vars are set', () => {
    const c = applyEnvOverrides(baseConfig());
    assert.strictEqual(c.privacy.secretGuard.enabled, false);
  });
});
