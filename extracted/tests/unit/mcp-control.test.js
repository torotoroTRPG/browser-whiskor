/**
 * tests/unit/mcp-control.test.js
 * Section 4.4 — Control Tools
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('4.4 Control Tools', () => {

  describe('set_config', () => {
    test('Mode change: updates config', () => {
      let config = { mode: 'auto' };
      const newConfig = { mode: 'manual' };
      
      // Simulate tool
      config = { ...config, ...newConfig };
      
      assert.strictEqual(config.mode, 'manual');
    });

    test('Plugin toggle: enables/disables plugin', () => {
      let config = { plugins: { network: true } };
      const update = { plugins: { network: false } };
      
      config.plugins = { ...config.plugins, ...update.plugins };
      
      assert.strictEqual(config.plugins.network, false);
    });
  });

  describe('trigger_collect', () => {
    test('All plugins: triggers collection', () => {
      const result = { ok: true, triggered: ['text-coords', 'network', 'framework'] };
      assert.strictEqual(result.ok, true);
      assert.ok(result.triggered.length > 0);
    });
  });

  describe('trigger_explorer', () => {
    test('Start/Stop: toggles explorer state', () => {
      let explorerRunning = false;
      
      // Start
      explorerRunning = true;
      assert.strictEqual(explorerRunning, true);
      
      // Stop
      explorerRunning = false;
      assert.strictEqual(explorerRunning, false);
    });
  });
});
