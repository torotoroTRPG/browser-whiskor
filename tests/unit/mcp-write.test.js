/**
 * tests/unit/mcp-write.test.js
 * Section 4.3 — Write Tools
 *
 * Exercises the REAL write-tool handlers (server/mcp/tools/write.js) via a
 * capturing registry + a mock action executor. Verifies the action each tool
 * builds, how it resolves input fidelity from config, and the observe guard —
 * not an inline re-implementation of DOM behaviour. (The page-side DOM event
 * sequence lives in the injected executor and is covered by the e2e suite.)
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

const writeTools = captureTools(require('../../server/mcp/tools/write'));

// A cb that records the action passed to _callAction and echoes a result.
function recordingCb(config = {}) {
  const calls = [];
  return {
    calls,
    _config: config,
    _callAction: async (tabId, action, timeoutMs) => {
      calls.push({ tabId, action, timeoutMs });
      return { ok: true };
    },
  };
}

describe('4.3 click', () => {
  it('forwards a click action with the chosen target', async () => {
    const cb = recordingCb();
    await writeTools['click'].handler({ tabId: 3, selector: '#go', double: true }, cb);
    const { tabId, action } = cb.calls[0];
    assert.strictEqual(tabId, 3);
    assert.strictEqual(action.type, 'click');
    assert.strictEqual(action.selector, '#go');
    assert.strictEqual(action.double, true);
  });

  it('defaults inputMode to "off" when no high-fidelity config is set', async () => {
    const cb = recordingCb();
    await writeTools['click'].handler({ tabId: 1, x: 10, y: 20 }, cb);
    assert.strictEqual(cb.calls[0].action.inputMode, 'off');
  });

  it('reads inputMode from agentControl.input.highFidelity', async () => {
    const cb = recordingCb({ agentControl: { input: { highFidelity: 'always' } } });
    await writeTools['click'].handler({ tabId: 1, selector: '#x' }, cb);
    assert.strictEqual(cb.calls[0].action.inputMode, 'always');
  });
});

describe('4.3 type_text', () => {
  it('builds a type action carrying text, selector and submit intent', async () => {
    const cb = recordingCb();
    await writeTools['type_text'].handler(
      { tabId: 2, text: 'hello', selector: 'input', submit: 'enter' }, cb);
    const a = cb.calls[0].action;
    assert.strictEqual(a.type, 'type');
    assert.strictEqual(a.text, 'hello');
    assert.strictEqual(a.submit, 'enter');
  });

  it('defaults submitOnFail to "type-only" and honours config override', async () => {
    const def = recordingCb();
    await writeTools['type_text'].handler({ tabId: 1, text: 'x' }, def);
    assert.strictEqual(def.calls[0].action.submitOnFail, 'type-only');

    const cfg = recordingCb({ agentControl: { submitInference: { onFail: 'abort' } } });
    await writeTools['type_text'].handler({ tabId: 1, text: 'x' }, cfg);
    assert.strictEqual(cfg.calls[0].action.submitOnFail, 'abort');
  });
});

describe('4.3 press_key', () => {
  it('forwards the key combo verbatim', async () => {
    const cb = recordingCb();
    await writeTools['press_key'].handler({ tabId: 1, key: 'Control+a' }, cb);
    assert.strictEqual(cb.calls[0].action.type, 'press_key');
    assert.strictEqual(cb.calls[0].action.key, 'Control+a');
  });
});

describe('4.3 type_secret', () => {
  // The value is resolved worker-side (action-executor) from the ref; the MCP
  // layer only carries the ref, so it works under the proxy. (Resolution + the
  // guard-off/unknown-ref errors are covered in action-secret-ref.test.js.)
  it('passes the ref (not a value) on the action; agent result is safe', async () => {
    const cb = recordingCb();
    const res = await writeTools['type_secret'].handler({ tabId: 5, ref: 'user_password', selector: '#pw' }, cb);
    const action = cb.calls[0].action;
    assert.strictEqual(action.type, 'type');
    assert.strictEqual(action.secretRef, 'user_password', 'carries the ref, not the value');
    assert.strictEqual(action.text, undefined, 'the MCP layer never carries the value');
    assert.strictEqual(action.selector, '#pw');
    assert.strictEqual(action._sensitive, true);
    assert.strictEqual(res.ref, 'user_password');
    assert.strictEqual(res.typed, true);
  });

  it('surfaces a worker error when the guard is disabled', async () => {
    const cb = { _config: {}, _callAction: async () => ({ ok: false, error: 'Secret guard is not enabled on the server.' }) };
    const res = await writeTools['type_secret'].handler({ tabId: 1, ref: 'user_password' }, cb);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /not enabled/i);
  });

  it('surfaces a worker error + available refs for an unknown ref', async () => {
    const cb = { _config: {}, _callAction: async () => ({ ok: false, error: 'No secret registered for ref "nope".', availableRefs: ['user_password'] }) };
    const res = await writeTools['type_secret'].handler({ tabId: 1, ref: 'nope' }, cb);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /No secret registered/);
    assert.deepStrictEqual(res.availableRefs, ['user_password']);
  });
});

describe('4.3 observe guard', () => {
  it('reports observation unavailable when no hash broadcast channel exists', async () => {
    const cb = recordingCb();           // no _navigateBroadcast
    const res = await writeTools['click'].handler({ tabId: 1, selector: '#x', observe: true }, cb);
    assert.strictEqual(res._observation.available, false);
    assert.strictEqual(cb.calls.length, 1, 'the action itself must still execute');
  });
});
