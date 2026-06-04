/**
 * tests/integration/source-correlation-observe.test.js
 *
 * Slice 3 — passive correlation recording. Proves that when a real WhiskorCore
 * routes a FRAMEWORK_DOM_MAP message carrying a named component, the runtime→source
 * correlation is recorded against the uploaded source with no agent round-trip,
 * preferring the React debug-source hint over a symbol-name match.
 *
 * Wires the real WhiskorCore, source-index and source-correlation modules.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WhiskorCore } = require('../../server/core');
const { createSourceIndex } = require('../../server/source-index');
const { createCorrelations } = require('../../server/source-correlation');

function wire(files) {
  const sourceIndex = createSourceIndex({ persist: false });
  sourceIndex.addFiles('default', files);
  const sourceCorrelations = createCorrelations();
  const cache = { handleMessage: async () => {} };
  const core = new WhiskorCore({ cache, sourceIndex, sourceCorrelations });
  return { core, sourceCorrelations };
}

async function observe(core, component) {
  await core.routeMessage({ type: 'FRAMEWORK_DOM_MAP', tabId: 1, payload: { component } }, undefined);
}

describe('Slice 3 — passive correlation from FRAMEWORK_DOM_MAP', () => {
  it('records a name-match correlation from an observed component', async () => {
    const { core, sourceCorrelations } = wire({
      'src/auth/LoginForm.tsx': 'export function LoginForm() { return null; }',
    });
    await observe(core, { name: 'LoginForm', framework: 'react' });
    clearInterval(core._cleanupTimer);

    const rec = sourceCorrelations.lookup('default', 'LoginForm');
    assert.ok(rec, 'a correlation must have been recorded');
    assert.strictEqual(rec.file, 'src/auth/LoginForm.tsx');
    assert.strictEqual(rec.confidence, 'name-match');
  });

  it('prefers an exact debug-source hint over an ambiguous name match', async () => {
    const { core, sourceCorrelations } = wire({
      'src/a/Button.tsx': 'export const Button = () => null;',
      'src/b/Button.tsx': 'export const Button = () => null;',
    });
    await observe(core, { name: 'Button', sourceFile: '/abs/webpack/src/b/Button.tsx', sourceLine: 1 });
    clearInterval(core._cleanupTimer);

    const rec = sourceCorrelations.lookup('default', 'Button');
    assert.ok(rec, 'the hint must resolve the ambiguity');
    assert.strictEqual(rec.confidence, 'debug-source');
    assert.strictEqual(rec.file, 'src/b/Button.tsx');
    assert.strictEqual(rec.line, 1);
  });

  it('does nothing (no throw) when no source is uploaded or no component name', async () => {
    const cache = { handleMessage: async () => {} };
    const core = new WhiskorCore({ cache }); // no sourceIndex/sourceCorrelations
    await observe(core, { name: 'Whatever' });
    await core.routeMessage(
      { type: 'FRAMEWORK_DOM_MAP', tabId: 1, payload: { component: {} } }, undefined,
    );
    clearInterval(core._cleanupTimer);
    // Reaching here without throwing is the assertion.
    assert.ok(true);
  });

  it('counts repeat observations of the same component', async () => {
    const { core, sourceCorrelations } = wire({
      'Nav.tsx': 'export function Nav() {}',
    });
    await observe(core, { name: 'Nav' });
    await observe(core, { name: 'Nav' });
    await observe(core, { name: 'Nav' });
    clearInterval(core._cleanupTimer);

    assert.strictEqual(sourceCorrelations.lookup('default', 'Nav').count, 3);
  });
});
