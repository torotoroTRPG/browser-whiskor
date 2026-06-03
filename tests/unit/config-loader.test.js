/**
 * tests/unit/config-loader.test.js
 * Section 8.1 — Config Loader
 *
 * Exercises the REAL server/config-loader.js (not an inline re-implementation).
 * Covers: built-in defaults, WHISKOR_* env overrides (case-insensitive,
 * type-coerced), and the mcp-tools config shape.
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadConfig, getDefaults, loadMcpToolsConfig } = require('../../server/config-loader');

// Env keys this suite mutates — cleaned up after every test so cases stay isolated.
const TOUCHED_ENV = [
  'WHISKOR_SECURITY_ALLOWEXECUTEJS',
  'WHISKOR_COLLECTION_MAXCONSOLELOGS',
  'WHISKOR_SERVER_WSPORT',
];

afterEach(() => {
  for (const k of TOUCHED_ENV) delete process.env[k];
});

describe('8.1 Config Loader — built-in defaults', () => {
  test('execute_js is OFF by default (security-critical default)', () => {
    // The whole point of the flag: it must default to false so execute_js
    // stays disabled until an operator opts in.
    assert.strictEqual(getDefaults().security.allowExecuteJs, false);
  });

  test('defaults expose the documented ports and safe toggles', () => {
    const d = getDefaults();
    assert.strictEqual(d.server.wsPort, 7891);
    assert.strictEqual(d.server.httpPort, 7892);
    assert.strictEqual(d.agentControl.allowAgentConfig, false);
    assert.strictEqual(d.adaptiveCollection.enabled, false);
  });

  test('getDefaults returns an independent object each call (no shared mutation)', () => {
    const a = getDefaults();
    a.security.allowExecuteJs = true;
    assert.strictEqual(getDefaults().security.allowExecuteJs, false,
      'mutating one result must not leak into the next');
  });
});

describe('8.1 Config Loader — env overrides via loadConfig()', () => {
  test('WHISKOR_<SECTION>_<KEY> overrides a value (boolean coercion)', () => {
    process.env.WHISKOR_SECURITY_ALLOWEXECUTEJS = 'true';
    assert.strictEqual(loadConfig().security.allowExecuteJs, true);

    process.env.WHISKOR_SECURITY_ALLOWEXECUTEJS = 'false';
    assert.strictEqual(loadConfig().security.allowExecuteJs, false,
      'string "false" must coerce to boolean false, not a truthy string');
  });

  test('numeric env values are coerced to numbers', () => {
    process.env.WHISKOR_COLLECTION_MAXCONSOLELOGS = '777';
    const v = loadConfig().collection.maxConsoleLogs;
    assert.strictEqual(v, 777);
    assert.strictEqual(typeof v, 'number');
  });

  test('key matching is case-insensitive', () => {
    process.env.WHISKOR_SERVER_WSPORT = '9999';
    assert.strictEqual(loadConfig().server.wsPort, 9999,
      'WSPORT must match the wsPort key regardless of case');
  });

  test('an unknown section is ignored, not crash-inducing', () => {
    process.env['WHISKOR_NOPE_THING'] = 'x';
    TOUCHED_ENV.push('WHISKOR_NOPE_THING');
    assert.doesNotThrow(() => loadConfig());
  });
});

describe('8.1 Config Loader — mcp-tools config', () => {
  test('returns the categories / tools / presets shape', () => {
    const cfg = loadMcpToolsConfig();
    assert.ok(cfg.categories && typeof cfg.categories === 'object');
    assert.ok(cfg.tools && typeof cfg.tools === 'object');
    assert.ok('presets' in cfg);
  });

  test('every tool carries a boolean enabled flag and a category', () => {
    const { tools } = loadMcpToolsConfig();
    for (const [name, tool] of Object.entries(tools)) {
      assert.strictEqual(typeof tool.enabled, 'boolean', `${name}.enabled must be boolean`);
      assert.strictEqual(typeof tool.category, 'string', `${name}.category must be set`);
    }
  });

  test('core read tool get_sessions is present and categorised as read', () => {
    const { tools } = loadMcpToolsConfig();
    assert.ok(tools.get_sessions, 'get_sessions must exist');
    assert.strictEqual(tools.get_sessions.category, 'read');
  });
});
