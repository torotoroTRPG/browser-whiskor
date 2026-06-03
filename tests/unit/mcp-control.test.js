/**
 * tests/unit/mcp-control.test.js
 * Section 4.4 — Control Tools
 *
 * Exercises the REAL control-tool handlers (server/mcp/tools/control.js) via a
 * capturing registry + mocked service callbacks. Verifies guard clauses,
 * argument forwarding, and response shaping — not inline stand-ins.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function captureTools(registerFn) {
  const map = {};
  const registry = {
    registerTools(arr) { for (const t of arr) map[t.definition.name] = t; },
    registerTool(def, handler) { map[def.name] = { definition: def, handler }; },
  };
  registerFn(registry);
  return map;
}

const ctl = captureTools(require('../../server/mcp/tools/control'));

describe('4.4 set_config', () => {
  it('errors gracefully when the config service is absent', async () => {
    const res = await ctl['set_config'].handler({ mode: 'manual' }, {});
    assert.match(res.error, /not available/i);
  });

  it('forwards the patch (mode/plugins/options) with the mcp-agent source', async () => {
    let captured = null;
    const cb = { _pushConfig: (patch, source) => { captured = { patch, source }; return { warnings: [] }; } };
    const res = await ctl['set_config'].handler(
      { mode: 'manual', plugins: { 'react-fiber': false } }, cb);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(captured.source, 'mcp-agent');
    assert.strictEqual(captured.patch.mode, 'manual');
    assert.strictEqual(captured.patch.plugins['react-fiber'], false);
    assert.strictEqual(res._note, undefined, 'no _note when there are no warnings');
  });

  it('surfaces a review note when pushConfig reports warnings', async () => {
    const cb = { _pushConfig: () => ({ warnings: [{ severity: 'danger', message: 'risky' }] }) };
    const res = await ctl['set_config'].handler({ mode: 'off' }, cb);
    assert.strictEqual(res.warnings.length, 1);
    assert.match(res._note, /auto-reverted|get_config_changes/);
  });
});

describe('4.4 get_config_changes', () => {
  it('errors when the change log is unavailable', async () => {
    const res = await ctl['get_config_changes'].handler({}, {});
    assert.match(res.error, /not available/i);
  });

  it('defaults to active-only changes and reports a total', async () => {
    const active = [{ id: 1 }, { id: 2 }];
    const cb = { _configLog: { getActiveChanges: () => active, _getAll: () => [...active, { id: 3 }] }, _startupWarnings: [] };
    const res = await ctl['get_config_changes'].handler({}, cb);
    assert.strictEqual(res.totalChanges, 2);
    assert.strictEqual(res.changes, active);
  });

  it('returns the full history when activeOnly is false', async () => {
    const cb = { _configLog: { getActiveChanges: () => [{ id: 1 }], _getAll: () => [{ id: 1 }, { id: 2 }, { id: 3 }] } };
    const res = await ctl['get_config_changes'].handler({ activeOnly: false }, cb);
    assert.strictEqual(res.totalChanges, 3);
  });
});

describe('4.4 trigger_collect', () => {
  it('errors when no browser is connected', async () => {
    const res = await ctl['trigger_collect'].handler({}, {});
    assert.match(res.error, /No browser/i);
  });

  it('forwards tabId/plugins and reports "all" when omitted', async () => {
    let args = null;
    const cb = { _triggerCollect: (tabId, plugins) => { args = { tabId, plugins }; } };
    const res = await ctl['trigger_collect'].handler({}, cb);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.tabId, 'all');
    assert.deepStrictEqual(args, { tabId: null, plugins: null });
  });
});

describe('4.4 trigger_explorer', () => {
  it('errors when the explorer service is missing', async () => {
    const res = await ctl['trigger_explorer'].handler({ tabId: 1, active: true }, {});
    assert.match(res.error, /not available/i);
  });

  it('defaults the strategy to breadth_first and forwards the call', async () => {
    let args = null;
    const cb = { _triggerExplorer: (tabId, active, strategy) => { args = { tabId, active, strategy }; } };
    const res = await ctl['trigger_explorer'].handler({ tabId: 5, active: true }, cb);
    assert.strictEqual(res.strategy, 'breadth_first');
    assert.strictEqual(args.tabId, 5);
    assert.strictEqual(args.active, true);
  });
});
