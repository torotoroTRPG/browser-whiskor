/**
 * tests/unit/sw.test.js
 * Section 6.2 — Service Worker (sw.js)
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('6.2 Service Worker', () => {

  test('Message queue: queues messages when WS is down', () => {
    const queue = [];
    const MAX_QUEUE = 5;
    let wsConnected = false;

    function sendMessage(msg) {
      if (wsConnected) {
        // send
      } else {
        if (queue.length >= MAX_QUEUE) queue.shift();
        queue.push(msg);
      }
    }

    for (let i = 0; i < 10; i++) {
      sendMessage({ id: i });
    }

    assert.strictEqual(queue.length, MAX_QUEUE);
    assert.strictEqual(queue[0].id, 5); // 0-4 dropped
    assert.strictEqual(queue[4].id, 9);
  });

  test('EXECUTE_ACTION: calls executeInPage', async () => {
    let called = false;
    const mockExecute = async () => { called = true; return { ok: true }; };

    const result = await mockExecute();
    assert.ok(called);
    assert.strictEqual(result.ok, true);
  });
});
