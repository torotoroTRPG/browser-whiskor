/**
 * tests/unit/uninstrumented-tabs.test.js
 * Exercises the REAL WhiskorCore.getUninstrumentedTabs — the diff between the
 * browser's tab inventory (TAB_INVENTORY push) and tabs that actually have a
 * whiskor session, classified so get_sessions can warn the agent.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WhiskorCore } = require('../../server/core');

let core;
afterEach(() => { if (core?._cleanupTimer) clearInterval(core._cleanupTimer); core = null; });

function withInventory(tabs) {
  core = new WhiskorCore({});
  core._tabInventory = tabs;
  return core;
}

describe('getUninstrumentedTabs', () => {
  it('returns only tabs without a session', () => {
    const c = withInventory([
      { tabId: 1, url: 'https://a.test', title: 'A' },
      { tabId: 2, url: 'https://b.test', title: 'B' },
      { tabId: 3, url: 'https://c.test', title: 'C' },
    ]);
    const out = c.getUninstrumentedTabs([2]); // tab 2 has a session
    assert.deepStrictEqual(out.map(t => t.tabId).sort(), [1, 3]);
  });

  it("classifies browser-internal pages as 'restricted'", () => {
    const c = withInventory([
      { tabId: 1, url: 'chrome://extensions', title: 'Extensions' },
      { tabId: 2, url: 'about:debugging', title: 'about' },
      { tabId: 3, url: 'https://chromewebstore.google.com/x', title: 'Store' },
      { tabId: 4, url: 'view-source:https://x.test', title: 'src' },
    ]);
    const out = c.getUninstrumentedTabs([]);
    assert.ok(out.every(t => t.reason === 'restricted'), 'all restricted');
  });

  it("classifies normal pages as 'reload_needed'", () => {
    const c = withInventory([{ tabId: 5, url: 'https://example.com/app', title: 'App' }]);
    const out = c.getUninstrumentedTabs([]);
    assert.strictEqual(out[0].reason, 'reload_needed');
  });

  it('treats a missing URL as restricted (nothing actionable)', () => {
    const c = withInventory([{ tabId: 9, url: '', title: '' }]);
    assert.strictEqual(c.getUninstrumentedTabs([])[0].reason, 'restricted');
  });

  it('is empty when every tab has a session', () => {
    const c = withInventory([{ tabId: 1, url: 'https://a.test' }, { tabId: 2, url: 'https://b.test' }]);
    assert.deepStrictEqual(c.getUninstrumentedTabs([1, 2]), []);
  });
});
