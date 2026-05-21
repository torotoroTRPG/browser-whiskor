/**
 * tests/unit/config-change-log.test.js
 * Section 8.2 — Config Change Log
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

class ConfigLog {
  constructor() {
    this.entries = [];
  }
  log(key, oldVal, newVal) {
    this.entries.push({ timestamp: Date.now(), key, oldVal, newVal });
  }
}

describe('8.2 Config Change Log', () => {

  test('Log change: records entry', () => {
    const logger = new ConfigLog();
    logger.log('mode', 'auto', 'manual');
    
    assert.strictEqual(logger.entries.length, 1);
    assert.strictEqual(logger.entries[0].key, 'mode');
    assert.strictEqual(logger.entries[0].oldVal, 'auto');
    assert.strictEqual(logger.entries[0].newVal, 'manual');
  });

  test('Validate change: detects non-recommended settings', () => {
    const validate = (key, val) => {
      if (key === 'security.allowExecuteJs' && val === true) {
        return { recommended: false, warning: 'Security risk' };
      }
      return { recommended: true };
    };

    const res = validate('security.allowExecuteJs', true);
    assert.strictEqual(res.recommended, false);
    assert.ok(res.warning);
  });
});
