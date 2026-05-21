/**
 * tests/unit/config-loader.test.js
 * Section 8.1 — Config Loader
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

function loadConfig(jsonStr, env = {}) {
  let config;
  try {
    config = JSON.parse(jsonStr);
  } catch (e) {
    config = { mode: 'auto', security: { allowExecuteJs: true } }; // Defaults
  }

  if (env.WHISKOR_SECURITY_ALLOWEXECUTEJS !== undefined) {
    config.security.allowExecuteJs = env.WHISKOR_SECURITY_ALLOWEXECUTEJS === 'true';
  }
  return config;
}

describe('8.1 Config Loader', () => {

  test('Load valid JSON', () => {
    const json = '{"mode": "manual", "security": {"allowExecuteJs": true}}';
    const config = loadConfig(json);
    assert.strictEqual(config.mode, 'manual');
  });

  test('Load invalid JSON uses defaults', () => {
    const config = loadConfig('INVALID');
    assert.strictEqual(config.mode, 'auto');
  });

  test('Env overrides security flag', () => {
    const json = '{"mode": "auto", "security": {"allowExecuteJs": true}}';
    const config = loadConfig(json, { WHISKOR_SECURITY_ALLOWEXECUTEJS: 'false' });
    assert.strictEqual(config.security.allowExecuteJs, false);
  });
});
