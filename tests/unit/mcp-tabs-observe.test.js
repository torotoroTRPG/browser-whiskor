/**
 * tests/unit/mcp-tabs-observe.test.js
 * Section 4.2 — Tab tools & post-action observation
 *
 * Exercises the REAL tool modules (server/mcp/tools/tabs.js and write.js) through
 * a lightweight registry that captures their handlers, then drives the handlers
 * with a mock action executor. No browser, no server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Capture the tools a register function emits into a name→tool map.
function captureTools(registerFn) {
  const map = {};
  const registry = {
    registerTools(arr) { for (const t of arr) map[t.definition.name] = t; },
    registerTool(def, handler) { map[def.name] = { definition: def, handler }; },
  };
  registerFn(registry);
  return map;
}

const tabTools   = captureTools(require('../../server/mcp/tools/tabs'));
const writeTools = captureTools(require('../../server/mcp/tools/write'));

describe('4.2 Tab tools', () => {
  it('registers list_tabs / switch_tab / open_tab / close_tab', () => {
    for (const name of ['list_tabs', 'switch_tab', 'open_tab', 'close_tab']) {
      assert.ok(tabTools[name], `${name} must be registered`);
    }
  });

  it('list_tabs unwraps the extension payload and reports a count', async () => {
    const cb = {
      _callAction: async (tabId, action) => {
        assert.equal(action.type, 'list_tabs');
        return { ok: true, result: { ok: true, tabs: [{ tabId: 1 }, { tabId: 2 }, { tabId: 3 }] } };
      },
    };
    const res = await tabTools['list_tabs'].handler({}, cb);
    assert.equal(res.ok, true);
    assert.equal(res.count, 3);
    assert.equal(res.tabs.length, 3);
  });

  it('list_tabs returns an error when no browser is connected', async () => {
    const res = await tabTools['list_tabs'].handler({}, {});
    assert.equal(res.ok, false);
  });

  it('switch_tab forwards the target tab id in the action', async () => {
    let captured = null;
    const cb = {
      _callAction: async (tabId, action) => { captured = { tabId, action }; return { ok: true, result: { ok: true, tabId: action.targetTabId } }; },
    };
    const res = await tabTools['switch_tab'].handler({ tabId: 42 }, cb);
    assert.equal(captured.action.type, 'switch_tab');
    assert.equal(captured.action.targetTabId, 42);
    assert.equal(res.ok, true);
    assert.equal(res.tabId, 42);
  });

  it('open_tab passes url + active and runs untargeted (tabId null)', async () => {
    let captured = null;
    const cb = {
      _callAction: async (tabId, action) => { captured = { tabId, action }; return { ok: true, result: { ok: true, tabId: 99, url: action.url } }; },
    };
    const res = await tabTools['open_tab'].handler({ url: 'https://example.com', active: false }, cb);
    assert.equal(captured.tabId, null);
    assert.equal(captured.action.type, 'open_tab');
    assert.equal(captured.action.url, 'https://example.com');
    assert.equal(captured.action.active, false);
    assert.equal(res.tabId, 99);
  });

  it('close_tab forwards the target tab id', async () => {
    let captured = null;
    const cb = {
      _callAction: async (tabId, action) => { captured = action; return { ok: true, result: { ok: true, closedTabId: action.targetTabId } }; },
    };
    const res = await tabTools['close_tab'].handler({ tabId: 7 }, cb);
    assert.equal(captured.type, 'close_tab');
    assert.equal(captured.targetTabId, 7);
    assert.equal(res.closedTabId, 7);
  });
});

describe('4.2 Post-action observation (observe)', () => {
  it('passes through unchanged when observe is not set', async () => {
    let calls = 0;
    const cb = { _callAction: async () => { calls++; return { ok: true, result: { ok: true } }; } };
    const res = await writeTools['click'].handler({ tabId: 1, selector: '#x' }, cb);
    assert.equal(calls, 1);
    assert.ok(!('_observation' in res), 'no observation attached without observe:true');
  });

  it('reports observation unavailable when no navigate broadcast exists', async () => {
    const cb = { _callAction: async () => ({ ok: true, result: { ok: true } }) }; // no _navigateBroadcast
    const res = await writeTools['click'].handler({ tabId: 1, selector: '#x', observe: true }, cb);
    assert.ok(res._observation, 'observation object present');
    assert.equal(res._observation.available, false);
  });

  it('exposes the observe schema on interaction tools', () => {
    for (const name of ['click', 'type_text', 'hover', 'drag', 'select_option', 'check_box', 'mouse_scroll', 'press_key', 'scroll_page', 'right_click']) {
      const props = writeTools[name].definition.inputSchema.properties;
      assert.ok(props.observe, `${name} should expose observe`);
      assert.ok(props.observeTimeoutMs, `${name} should expose observeTimeoutMs`);
    }
  });
});
