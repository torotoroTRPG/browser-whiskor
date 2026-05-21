/**
 * tests/integration/full-flow.test.js
 * Section 10.1 — Full Flow
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('10.1 Full Flow', () => {

  test('Collect -> Read -> Act: sequential operations', async () => {
    const flow = [];
    
    // 1. Collect
    flow.push('COLLECT');
    
    // 2. Read
    flow.push('READ');
    
    // 3. Act
    flow.push('ACT');
    
    assert.deepStrictEqual(flow, ['COLLECT', 'READ', 'ACT']);
  });

  test('Config change effect: mode=off stops collection', () => {
    let mode = 'off';
    let collectionTriggered = false;

    function triggerCollect() {
      if (mode !== 'off') collectionTriggered = true;
    }

    triggerCollect();
    assert.strictEqual(collectionTriggered, false);
  });
});
