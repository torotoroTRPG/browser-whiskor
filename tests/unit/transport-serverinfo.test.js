/**
 * tests/unit/transport-serverinfo.test.js
 * Section 13.1 — MCP serverInfo
 *
 * Exercises the REAL buildServerInfo() from server/mcp/transport.js: identity
 * labelling and the redaction advertisement (counts only, never values).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildServerInfo } = require('../../server/mcp/transport');

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
