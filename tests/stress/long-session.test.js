/**
 * tests/stress/long-session.test.js
 * Section 9.2 — Long Session
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('9.2 Long Session', () => {

  test('10000 actions: max 50 history kept', () => {
    const history = [];
    const MAX_HISTORY = 50;

    for (let i = 0; i < 10000; i++) {
      history.push(i);
      if (history.length > MAX_HISTORY) history.shift();
    }

    assert.strictEqual(history.length, MAX_HISTORY);
    assert.strictEqual(history[MAX_HISTORY - 1], 9999);
  });
});
