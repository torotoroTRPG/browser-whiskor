/**
 * tests/unit/framework-state-http.test.js
 * Framework-state shared read module + HTTP wiring.
 *
 * The MCP get_framework_state tool and GET /api/sessions/:tabId/framework-state
 * must share ONE implementation (server/framework-state.js) — the field report
 * that motivated this found 156K lines of React/Redux state sitting in the
 * cache with no HTTP way to read it. Real-import tests for the logic, pin
 * tests for the two consumers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../..');
const require_ = createRequire(import.meta.url);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const { readFrameworkState, FW_PRIORITY } = require_('../../server/framework-state.js');

function mockCache(files, blobs) {
  return {
    async getSessionData(tabId) { return tabId === 42 ? { tabId, files: { raw: files } } : null; },
    async readSessionFile(tabId, rel) { return blobs[rel] || null; },
    freshnessInfo() { return null; },
  };
}

describe('framework-state — shared read logic (real import)', () => {
  it('auto picks a real framework over the generic DOM snapshot', async () => {
    const cache = mockCache(
      { react_snapshot: 'raw/fw/react.json', dom_generic: 'raw/fw/dom.json' },
      { 'raw/fw/react.json': { framework: 'react', tree: [] }, 'raw/fw/dom.json': { framework: 'dom' } },
    );
    const out = await readFrameworkState(cache, 42, 'auto');
    assert.equal(out.framework, 'react');
  });

  it('explicit framework selects that file, not the priority winner', async () => {
    const cache = mockCache(
      { react_snapshot: 'raw/fw/react.json', dom_generic: 'raw/fw/dom.json' },
      { 'raw/fw/react.json': { framework: 'react' }, 'raw/fw/dom.json': { framework: 'dom' } },
    );
    const out = await readFrameworkState(cache, 42, 'dom');
    assert.equal(out.framework, 'dom');
  });

  it('reports available frameworks when the requested one is missing', async () => {
    const cache = mockCache({ vue_snapshot: 'raw/fw/vue3.json' }, { 'raw/fw/vue3.json': {} });
    const out = await readFrameworkState(cache, 42, 'react');
    assert.match(out.error, /not detected/);
    assert.match(out.error, /vue3/);
  });

  it('no session → error, not a throw', async () => {
    const cache = mockCache({}, {});
    const out = await readFrameworkState(cache, 999, 'auto');
    assert.match(out.error, /No session/);
  });

  it('priority order starts with react and ends with dom', () => {
    assert.equal(FW_PRIORITY[0], 'react');
    assert.equal(FW_PRIORITY[FW_PRIORITY.length - 1], 'dom');
  });
});

describe('framework-state — both surfaces consume the shared module', () => {
  it('MCP get_framework_state delegates to server/framework-state.js', () => {
    const src = read('server/mcp/tools/read-basic.js');
    assert.match(src, /require\('\.\.\/\.\.\/framework-state'\)/);
    // The old inline fwFileMap must be gone from the tool (single source of truth).
    assert.ok(!/fwFileMap = \{/.test(src), 'read-basic.js no longer holds its own file map');
  });

  it('HTTP endpoint /api/sessions/:tabId/framework-state is wired in index.js', () => {
    const src = read('server/index.js');
    assert.match(src, /\/api\\\/sessions\\\/\(\\d\+\)\\\/framework-state/);
    assert.match(src, /readFrameworkState\(cache, tabId/);
  });
});
