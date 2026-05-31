/**
 * tests/unit/tool-manager.test.js
 *
 * Dynamic Tool Profile Manager tests.
 * Section 11.3 — Tool Manager
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const toolManager = require('../../server/tool-manager');

// Mock allTools for testing
const mockTools = [
  { definition: { name: 'get_sessions', description: 'List sessions' } },
  { definition: { name: 'get_console_logs', description: 'Get console logs' } },
  { definition: { name: 'get_state_map', description: 'State graph' } },
  { definition: { name: 'get_delta', description: 'UI changes' } },
  { definition: { name: 'click', description: 'Click element' } },
  { definition: { name: 'execute_js', description: 'Run JS' } },
];

const mockConfig = {
  security: { allowExecuteJs: false },
  agentControl: { allowAgentConfig: true },
};

describe('11.3 Tool Manager', () => {
  before(() => {
    toolManager.resetAll();
  });

  after(() => {
    toolManager.resetAll();
  });

  describe('Session Management', () => {
    it('initializes session with core profile', () => {
      toolManager.resetAll();
      toolManager.initSession('test-1');
      const visible = toolManager.getVisibleTools('test-1', mockTools, mockConfig);
      // Core tools include get_sessions and click
      assert.ok(visible.some(t => t.definition.name === 'get_sessions'));
      assert.ok(visible.some(t => t.definition.name === 'click'));
    });

    it('cleans up session', () => {
      toolManager.initSession('test-cleanup');
      toolManager.cleanupSession('test-cleanup');
      // Should recreate on next access
      toolManager.initSession('test-cleanup');
      const status = toolManager.getProfileStatus('test-cleanup');
      assert.equal(status.turnCount, 0);
    });
  });

  describe('Profile Loading', () => {
    it('loads debug profile', () => {
      toolManager.resetAll();
      toolManager.initSession('test-2');
      const result = toolManager.loadProfile('test-2', 'debug', mockTools, mockConfig);
      assert.ok(result.success);
      assert.ok(result.loadedTools.some(t => t.definition.name === 'get_console_logs'));
    });

    it('prevents unloading core', () => {
      toolManager.resetAll();
      toolManager.initSession('test-3');
      const result = toolManager.unloadProfile('test-3', 'core', mockTools);
      assert.equal(result.success, false);
    });

    it('blocks admin profile without config', () => {
      toolManager.resetAll();
      toolManager.initSession('test-4');
      const restrictedConfig = { agentControl: { allowAgentConfig: false } };
      const result = toolManager.loadProfile('test-4', 'admin', mockTools, restrictedConfig);
      assert.equal(result.success, false);
    });

    it('blocks power profile without allowExecuteJs', () => {
      toolManager.resetAll();
      toolManager.initSession('test-5');
      const result = toolManager.loadProfile('test-5', 'power', mockTools, mockConfig);
      assert.equal(result.success, false);
    });
  });

  describe('Auto-Detection', () => {
    it('auto-loads debug profile on console trigger', () => {
      toolManager.resetAll();
      toolManager.initSession('test-6');
      const result = toolManager.processTurn('test-6', { name: 'get_console_logs', args: {} }, mockTools, mockConfig);
      assert.ok(result.autoLoaded.includes('debug'));
    });

    it('auto-loads state-nav profile on state trigger', () => {
      toolManager.resetAll();
      toolManager.initSession('test-7');
      const result = toolManager.processTurn('test-7', { name: 'get_state_map', args: {} }, mockTools, mockConfig);
      assert.ok(result.autoLoaded.includes('state-nav'));
    });

    it('auto-loads delta profile on change trigger', () => {
      toolManager.resetAll();
      toolManager.initSession('test-8');
      const result = toolManager.processTurn('test-8', { name: 'get_delta', args: {} }, mockTools, mockConfig);
      assert.ok(result.autoLoaded.includes('delta'));
    });
  });

  describe('Auto-Detection from arguments', () => {
    it('loads debug profile when a trigger word appears in string args (not the tool name)', () => {
      toolManager.resetAll();
      toolManager.initSession('test-arg-1');
      // get_text_coords has no debug-trigger in its name, but the agent is
      // clearly debugging — the keyword is in the argument.
      const result = toolManager.processTurn(
        'test-arg-1',
        { name: 'get_text_coords', args: { match: 'console error banner' } },
        mockTools, mockConfig
      );
      assert.ok(result.autoLoaded.includes('debug'),
        'argument keyword "console"/"error" should auto-load debug');
    });

    it('uses whole-word matching to avoid false positives inside larger words', () => {
      toolManager.resetAll();
      toolManager.initSession('test-arg-2');
      // "errorBoundary" / "terror" must NOT match the "error" trigger.
      const result = toolManager.processTurn(
        'test-arg-2',
        { name: 'get_text_coords', args: { match: 'errorBoundary terror' } },
        mockTools, mockConfig
      );
      assert.ok(!result.autoLoaded.includes('debug'),
        'substring-only occurrences must not trigger the profile');
    });

    it('can be disabled via agentControl.argTriggerDetection=false', () => {
      toolManager.resetAll();
      toolManager.initSession('test-arg-3');
      const cfg = { ...mockConfig, agentControl: { ...mockConfig.agentControl, argTriggerDetection: false } };
      const result = toolManager.processTurn(
        'test-arg-3',
        { name: 'get_text_coords', args: { match: 'console error' } },
        mockTools, cfg
      );
      assert.ok(!result.autoLoaded.includes('debug'),
        'argument scanning disabled → no auto-load from args');
    });

    it('still auto-loads from the tool name when args scanning is disabled', () => {
      toolManager.resetAll();
      toolManager.initSession('test-arg-4');
      const cfg = { ...mockConfig, agentControl: { ...mockConfig.agentControl, argTriggerDetection: false } };
      const result = toolManager.processTurn(
        'test-arg-4',
        { name: 'get_console_logs', args: {} },
        mockTools, cfg
      );
      assert.ok(result.autoLoaded.includes('debug'),
        'name-based triggers remain active regardless of args scanning');
    });
  });

  describe('Idle Unload', () => {
    it('unloads idle profile after max turns', () => {
      toolManager.resetAll();
      toolManager.initSession('test-9');
      toolManager.loadProfile('test-9', 'debug', mockTools, mockConfig);

      // Simulate turns exceeding idle limit (debug idleTurns = 10)
      for (let i = 0; i < 12; i++) {
        toolManager.processTurn('test-9', null, mockTools, mockConfig);
      }

      const status = toolManager.getProfileStatus('test-9');
      assert.equal(status.profiles.debug, undefined, 'Debug should be unloaded');
    });
  });

  describe('Warnings', () => {
    it('issues warning after threshold turns', () => {
      toolManager.resetAll();
      toolManager.initSession('test-10');
      toolManager.loadProfile('test-10', 'debug', mockTools, mockConfig);

      // Simulate turns exceeding warning threshold (5)
      let warnings = [];
      for (let i = 0; i < 6; i++) {
        const result = toolManager.processTurn('test-10', null, mockTools, mockConfig);
        if (result.warnings?.length) warnings = result.warnings;
      }

      assert.ok(warnings.length > 0, 'Should issue warning');
      assert.equal(warnings[0].profile, 'debug');
    });
  });

  describe('Tool Search', () => {
    it('searches tools by query', () => {
      const results = toolManager.searchTools('console', mockTools);
      assert.equal(results.length, 1);
      assert.equal(results[0].name, 'get_console_logs');
    });

    it('returns all tools when query is empty', () => {
      const results = toolManager.searchTools('', mockTools);
      assert.equal(results.length, mockTools.length);
    });
  });

  describe('Profile Status', () => {
    it('returns active profiles with idle turns', () => {
      toolManager.resetAll();
      toolManager.initSession('test-11');
      toolManager.loadProfile('test-11', 'debug', mockTools, mockConfig);
      toolManager.processTurn('test-11', null, mockTools, mockConfig);
      toolManager.processTurn('test-11', null, mockTools, mockConfig);

      const status = toolManager.getProfileStatus('test-11');
      assert.ok(status.profiles.core);
      assert.ok(status.profiles.debug);
      assert.equal(status.profiles.debug.idleTurns, 2);
    });
  });
});
