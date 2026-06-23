/**
 * tests/unit/config-local-merge.test.js
 * Section 1.x — config.local.json deep-merge layer
 *
 * Exercises the REAL server/config-loader.deepMerge. config.local.json lets a
 * developer keep personal values without editing the committed config.json, so
 * the published defaults can't drift on push. These guard the merge semantics:
 * nested objects merge (siblings survive); arrays and scalars replace wholesale.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deepMerge } = require('../../server/config-loader');

function baseConfig() {
  return {
    security:  { allowExecuteJs: false, allowActions: true, allowedMcpOrigins: ['localhost'] },
    agentControl: { screenshot: { httpInlineImage: true, format: 'jpeg', quality: 70 } },
    updateFrequencies: [{ id: 'viewport', valueMs: 100 }],
  };
}

describe('1.x config.local.json deep-merge', () => {
  it('overrides a leaf without disturbing siblings', () => {
    const c = deepMerge(baseConfig(), { security: { allowExecuteJs: true } });
    assert.strictEqual(c.security.allowExecuteJs, true);
    assert.strictEqual(c.security.allowActions, true, 'sibling untouched');
  });

  it('overrides a deeply nested leaf, keeping its siblings', () => {
    const c = deepMerge(baseConfig(), { agentControl: { screenshot: { httpInlineImage: false } } });
    assert.strictEqual(c.agentControl.screenshot.httpInlineImage, false);
    assert.strictEqual(c.agentControl.screenshot.format, 'jpeg', 'sibling untouched');
    assert.strictEqual(c.agentControl.screenshot.quality, 70, 'sibling untouched');
  });

  it('merges multiple sections at once', () => {
    const c = deepMerge(baseConfig(), {
      security: { allowExecuteJs: true },
      agentControl: { screenshot: { httpInlineImage: false } },
    });
    assert.strictEqual(c.security.allowExecuteJs, true);
    assert.strictEqual(c.agentControl.screenshot.httpInlineImage, false);
  });

  it('replaces arrays wholesale (no element-wise splice)', () => {
    const c = deepMerge(baseConfig(), { security: { allowedMcpOrigins: ['*'] } });
    assert.deepStrictEqual(c.security.allowedMcpOrigins, ['*']);
  });

  it('replaces a scalar even when base holds an object at that key', () => {
    const c = deepMerge(baseConfig(), { agentControl: { screenshot: 'disabled' } });
    assert.strictEqual(c.agentControl.screenshot, 'disabled');
  });

  it('adds a section absent from the base', () => {
    const c = deepMerge(baseConfig(), { privacy: { secretGuard: { enabled: true } } });
    assert.strictEqual(c.privacy.secretGuard.enabled, true);
    assert.strictEqual(c.security.allowExecuteJs, false, 'existing sections untouched');
  });

  it('is a no-op for empty / non-object overrides', () => {
    assert.strictEqual(deepMerge(baseConfig(), {}).security.allowExecuteJs, false);
    assert.strictEqual(deepMerge(baseConfig(), null).security.allowExecuteJs, false);
    assert.strictEqual(deepMerge(baseConfig(), undefined).security.allowExecuteJs, false);
  });
});
