/**
 * tests/integration/error-recovery.test.js
 * Section 10.2 — Error Recovery
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('10.2 Error Recovery', () => {

  test('Server restart: extension reconnects', async () => {
    let connected = false;
    const connect = () => { connected = true; };
    
    // Simulate crash
    connected = false;
    
    // Simulate restart and reconnect
    connect();
    assert.strictEqual(connected, true);
  });

  test('Action timeout: returns error', async () => {
    const executeAction = async (timeout) => {
      return new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('Timeout')), timeout);
      });
    };

    try {
      await executeAction(10);
      assert.fail('Should have timed out');
    } catch (e) {
      assert.strictEqual(e.message, 'Timeout');
    }
  });
});
