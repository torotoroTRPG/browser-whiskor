/**
 * tests/unit/transport-serverinfo.test.js
 * Section 13.1 — MCP serverInfo
 *
 * Exercises the REAL buildServerInfo() and resolveRedaction() from
 * server/mcp/transport.js: identity labelling and the redaction advertisement
 * (counts only, never values), including the proxy-mode async provider path
 * (T11b — the proxy holds no in-process guard and asks the worker's /health).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildServerInfo, resolveRedaction } = require('../../server/mcp/transport');

describe('13.1 buildServerInfo', () => {
  it('always reports the product name and a version', () => {
    const info = buildServerInfo(null, null);
    assert.strictEqual(info.name, 'browser-whiskor');
    assert.ok(typeof info.version === 'string' && info.version.length > 0);
    assert.ok(!('redaction' in info));
  });

  it('includes instance identity when provided', () => {
    const info = buildServerInfo({ instanceId: 'whiskor-host-7892', name: 'mine' }, null);
    assert.strictEqual(info.instanceId, 'whiskor-host-7892');
    assert.strictEqual(info.instanceName, 'mine');
  });

  it('advertises active redaction with counts only, plus a how-to note', () => {
    const info = buildServerInfo(null, { active: true, knownValues: 2, patterns: 3, refs: 1 });
    assert.strictEqual(info.redaction.active, true);
    assert.strictEqual(info.redaction.knownValues, 2);
    assert.strictEqual(info.redaction.patterns, 3);
    assert.strictEqual(info.redaction.refs, 1);
    assert.match(info.redaction.note, /type_secret/);
    assert.match(info.redaction.note, /WHISKOR_REDACTED/);
  });

  it('omits redaction when it is inactive or absent', () => {
    assert.ok(!('redaction' in buildServerInfo(null, { active: false })));
    assert.ok(!('redaction' in buildServerInfo(null, null)));
  });
});

describe('13.1 resolveRedaction', () => {
  it('maps an in-process guard (standalone mode) to the serverInfo shape', async () => {
    const r = await resolveRedaction({
      _secretGuard: { active: true, count: 2, patternCount: 3, refCount: 1 },
    });
    assert.deepStrictEqual(r, { active: true, knownValues: 2, patterns: 3, refs: 1 });
  });

  it('prefers the async provider (proxy mode) over a guard, normalizing /health counts', async () => {
    const r = await resolveRedaction({
      _redactionStatus: async () => ({ active: true, knownValues: 5, patterns: 1, refs: 4 }),
      _secretGuard: { active: true, count: 99, patternCount: 99, refCount: 99 },
    });
    assert.deepStrictEqual(r, { active: true, knownValues: 5, patterns: 1, refs: 4 });
  });

  it('returns null when the provider reports inactive, fails, or nothing is wired', async () => {
    assert.strictEqual(await resolveRedaction({ _redactionStatus: async () => ({ active: false }) }), null);
    assert.strictEqual(await resolveRedaction({ _redactionStatus: async () => null }), null);
    assert.strictEqual(await resolveRedaction({ _redactionStatus: async () => { throw new Error('worker down'); } }), null);
    assert.strictEqual(await resolveRedaction({ _secretGuard: { active: false } }), null);
    assert.strictEqual(await resolveRedaction({}), null);
    assert.strictEqual(await resolveRedaction(), null);
  });
});
