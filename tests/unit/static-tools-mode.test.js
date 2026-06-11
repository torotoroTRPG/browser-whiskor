/**
 * tests/unit/static-tools-mode.test.js
 *
 * Static tools mode (mcpServer.staticTools / --static-tools): every profile is
 * permanently visible over MCP, nothing loads or unloads. Security gates
 * (requiresConfig) must still apply — static mode widens visibility, never
 * permissions.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const toolManager = require('../../server/tool-manager');

const mockTools = [
  { definition: { name: 'get_sessions', description: 'List sessions' } },
  { definition: { name: 'get_console_logs', description: 'Get console logs' } },
  { definition: { name: 'get_delta', description: 'UI changes' } },
  { definition: { name: 'click', description: 'Click element' } },
  { definition: { name: 'execute_js', description: 'Run JS' } },
  { definition: { name: 'search_tools', description: 'Meta: search' } },
];

const lockedConfig = { security: { allowExecuteJs: false }, agentControl: {} };
const openConfig   = { security: { allowExecuteJs: true },  agentControl: {} };

describe('Static tools mode', () => {
  beforeEach(() => {
    toolManager.resetAll();
    toolManager.setStaticMode(true);
    toolManager.initSession('static-1');
  });

  after(() => {
    toolManager.resetAll();
  });

  it('exposes tools from every profile without loading anything', () => {
    const visible = toolManager.getVisibleTools('static-1', mockTools, lockedConfig);
    const names = visible.map(t => t.definition.name);
    assert.ok(names.includes('get_sessions'));      // core
    assert.ok(names.includes('get_console_logs'));  // debug — never loaded explicitly
    assert.ok(names.includes('get_delta'));         // delta
    assert.ok(names.includes('search_tools'));      // meta
  });

  it('still hides tools behind unsatisfied requiresConfig gates', () => {
    const visible = toolManager.getVisibleTools('static-1', mockTools, lockedConfig);
    assert.ok(!visible.some(t => t.definition.name === 'execute_js'));
  });

  it('shows gated tools once their config gate is satisfied', () => {
    const visible = toolManager.getVisibleTools('static-1', mockTools, openConfig);
    assert.ok(visible.some(t => t.definition.name === 'execute_js'));
  });

  it('load_profile is a friendly no-op', () => {
    const result = toolManager.loadProfile('static-1', 'debug', mockTools, lockedConfig);
    assert.equal(result.success, true);
    assert.match(result.note || '', /[Ss]tatic/);
  });

  it('unload_profile is rejected with an explanation', () => {
    const result = toolManager.unloadProfile('static-1', 'debug', mockTools);
    assert.equal(result.success, false);
    assert.match(result.error || '', /[Ss]tatic/);
  });

  it('processTurn never auto-loads or unloads, but still detects duplicates', () => {
    let last = null;
    // "console error" would auto-load the debug profile in dynamic mode.
    for (let i = 0; i < 4; i++) {
      last = toolManager.processTurn(
        'static-1',
        { name: 'get_text_coords', args: { match: 'console error' } },
        mockTools, lockedConfig
      );
      assert.deepEqual(last.autoLoaded, []);
      assert.deepEqual(last.unloaded, []);
    }
    assert.ok(last.warnings.some(w => w.code === 'DUPLICATE_OPERATION'));
  });

  it('profile_status reports static mode', () => {
    const status = toolManager.getProfileStatus('static-1');
    assert.equal(status.staticMode, true);
    assert.ok(Object.keys(status.profiles).length > 1); // every profile listed active
    assert.deepEqual(status.available, []);
  });

  it('resetAll returns to dynamic mode', () => {
    toolManager.resetAll();
    assert.equal(toolManager.isStaticMode(), false);
    toolManager.initSession('dyn-1');
    const visible = toolManager.getVisibleTools('dyn-1', mockTools, lockedConfig);
    // debug profile is not loaded in a fresh dynamic session
    assert.ok(!visible.some(t => t.definition.name === 'get_console_logs'));
  });
});
