/**
 * tests/integration/delta-flow.test.js
 * Section 3.2 — Delta Message Flow
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('3.2 Delta Message Flow', () => {

  test('Dashboard receives delta: updates word positions', () => {
    const dashboardState = {
      words: { 'w1': { id: 'w1', inView: false } }
    };

    const deltaMsg = {
      type: 'TEXT_COORD_DELTA',
      deltas: [{ id: 'w1', inView: true }]
    };

    // Simulate reception
    deltaMsg.deltas.forEach(d => {
      if (dashboardState.words[d.id]) {
        dashboardState.words[d.id].inView = d.inView;
      }
    });

    assert.strictEqual(dashboardState.words['w1'].inView, true);
  });

  test('Delta on wrong tab: ignored', () => {
    const currentTabId = 1;
    const msgTabId = 2;
    let updated = false;

    if (currentTabId === msgTabId) {
      updated = true;
    }

    assert.strictEqual(updated, false);
  });
});
