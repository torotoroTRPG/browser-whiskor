/**
 * tests/unit/mcp-source-context.test.js
 * Section 15.2 — get_source_context tool
 *
 * Exercises the REAL get_source_context handler (server/mcp/tools/source.js) via
 * a capturing registry + a mock _sourceContext callback.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function captureTools(registerFn) {
  const map = {};
  registerFn({ registerTools(arr) { for (const t of arr) map[t.definition.name] = t; }, registerTool(d, h) { map[d.name] = { definition: d, handler: h }; } });
  return map;
}

const tool = captureTools(require('../../server/mcp/tools/source'))['get_source_context'];

describe('15.2 get_source_context', () => {
  it('is registered', () => {
    assert.ok(tool);
  });

  it('errors when no source has been uploaded', async () => {
    const res = await tool.handler({ file: 'x.js' }, {});
    assert.match(res.error, /no source uploaded|\/api\/source\/upload/i);
  });

  it('forwards the query to the source context resolver and returns its result', async () => {
    let got = null;
    const cb = { _sourceContext: async (q) => { got = q; return { file: q.file, excerpt: 'CODE', lines: [1, 3] }; } };
    const res = await tool.handler({ file: 'src/a.tsx', line: 10, around: 5 }, cb);
    assert.strictEqual(got.file, 'src/a.tsx');
    assert.strictEqual(got.line, 10);
    assert.strictEqual(res.excerpt, 'CODE');
  });

  it('surfaces a resolver error as { error }', async () => {
    const cb = { _sourceContext: async () => { throw new Error('boom'); } };
    const res = await tool.handler({ file: 'x' }, cb);
    assert.match(res.error, /boom/);
  });
});
