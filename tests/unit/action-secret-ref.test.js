/**
 * tests/unit/action-secret-ref.test.js
 * Section 5.x — type_secret resolves the value worker-side (proxy-safe)
 *
 * The secret value is resolved in action-executor (the single dispatch chokepoint
 * all paths reach) from the agent-supplied ref, so it works under the proxy whose
 * MCP process has no guard. The agent/proxy only ever carry the ref; the value is
 * placed on the action just before dispatch and never returned.
 *
 * Exercises the REAL server/action-executor.js with an injected fake guard.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ae = require('../../server/action-executor');

const guard = {
  active: true,
  resolveSecret: (ref) => (ref === 'pw' ? 'hunter2-secret' : null),
  listRefs: () => ['pw'],
};

afterEach(() => { ae.setSecretGuard(null); ae.setBroadcast(null); });

describe('5.x type_secret worker-side resolution', () => {
  it('resolves secretRef to the value on the dispatched action, never exposing it', async () => {
    ae.setSecretGuard(guard);
    let sent = null;
    ae.setBroadcast((m) => { sent = m; });

    const p = ae.execute(1, { type: 'type', secretRef: 'pw', selector: '#pwd', _sensitive: true });
    // _resolveSecretRef is synchronous, so the broadcast already happened.
    assert.ok(sent, 'the action was dispatched');
    assert.strictEqual(sent.action.text, 'hunter2-secret', 'value placed on the action');
    assert.strictEqual(sent.action.secretRef, undefined, 'ref stripped before dispatch');

    ae.handleResult({ actionId: sent.actionId, ok: true });
    const res = await p;
    assert.strictEqual(res.ok, true);
    assert.ok(!JSON.stringify(res).includes('hunter2'), 'value never in the result');
  });

  it('returns a clear error for an unknown ref and does NOT dispatch', async () => {
    ae.setSecretGuard(guard);
    let dispatched = false;
    ae.setBroadcast(() => { dispatched = true; });

    const res = await ae.execute(1, { type: 'type', secretRef: 'nope' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /No secret registered/);
    assert.deepStrictEqual(res.availableRefs, ['pw']);
    assert.strictEqual(dispatched, false);
  });

  it('errors when the guard is disabled/missing', async () => {
    ae.setSecretGuard(null);
    let dispatched = false;
    ae.setBroadcast(() => { dispatched = true; });

    const res = await ae.execute(1, { type: 'type', secretRef: 'pw' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /not enabled/i);
    assert.strictEqual(dispatched, false);
  });

  it('leaves a normal action (no secretRef) untouched', async () => {
    ae.setSecretGuard(guard);
    let sent = null;
    ae.setBroadcast((m) => { sent = m; });
    const p = ae.execute(1, { type: 'type', text: 'hello', selector: '#x' });
    assert.ok(sent);
    assert.strictEqual(sent.action.text, 'hello');
    ae.handleResult({ actionId: sent.actionId, ok: true });
    await p;
  });
});
