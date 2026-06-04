/**
 * tests/unit/config-change-log.test.js
 * Section 8.2 — Config Change Log
 *
 * Exercises the REAL server/config-change-log.js: its non-recommended-change
 * validation rules, the change lifecycle (add → active → revert), and the
 * startup auto-revert path. No inline re-implementation.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const log = require('../../server/config-change-log');

describe('8.2 validateChange — non-recommended rules', () => {
  test('flags disabling execute_js as a danger', () => {
    const warnings = log.validateChange({ security: { allowExecuteJs: false } });
    const w = warnings.find(x => x.path === 'security.allowExecuteJs');
    assert.ok(w, 'must warn when allowExecuteJs is set to false');
    assert.strictEqual(w.severity, 'danger');
    assert.strictEqual(w.code, 'NON_RECOMMENDED_CHANGE');
  });

  test('does NOT flag enabling execute_js (rule fires only on false)', () => {
    const warnings = log.validateChange({ security: { allowExecuteJs: true } });
    assert.strictEqual(warnings.length, 0);
  });

  test('flags disabling a plugin (path-prefix match)', () => {
    const warnings = log.validateChange({ plugins: { 'react-fiber': false } });
    assert.ok(warnings.some(w => w.path.startsWith('plugins')));
  });

  test('flags an out-of-range react.maxDepth as info, leaves a sane one alone', () => {
    assert.ok(log.validateChange({ react: { maxDepth: 200 } })
      .some(w => w.path === 'react.maxDepth' && w.severity === 'info'));
    assert.strictEqual(log.validateChange({ react: { maxDepth: 50 } }).length, 0);
  });

  test('a benign patch produces no warnings', () => {
    assert.deepStrictEqual(log.validateChange({ server: { wsPort: 7891 } }), []);
  });
});

describe('8.2 change lifecycle', () => {
  test('addChange surfaces in getActiveChanges, markReverted hides it', () => {
    const marker = `__test_${Date.now()}_${Math.random()}`;
    log.addChange({ patch: { security: { allowActions: false } }, warnings: [], note: marker });

    const added = log.getActiveChanges().find(c => c.note === marker);
    assert.ok(added, 'newly added change must be active');
    assert.strictEqual(added.reverted, false);

    log.markReverted(added.id);
    assert.ok(!log.getActiveChanges().some(c => c.note === marker),
      'a reverted change must drop out of the active list');
  });
});

describe('8.2 autoRevertIfNeeded', () => {
  test('is a no-op when autoRevertConfig is disabled', () => {
    const result = log.autoRevertIfNeeded({ agentControl: { autoRevertConfig: false } }, () => {});
    assert.strictEqual(result, null);
  });

  test('reverts a danger change by flipping its boolean and reports it', () => {
    log.addChange({
      patch: { security: { allowActions: false } },
      warnings: [{ severity: 'danger', message: 'no actions' }],
    });

    const pushed = [];
    const report = log.autoRevertIfNeeded(
      { agentControl: { autoRevertConfig: true } },
      (patch) => pushed.push(patch),
    );

    assert.ok(report, 'should produce a revert report');
    assert.ok(report.count >= 1);
    // The revert patch must flip allowActions:false back to true.
    assert.ok(pushed.some(p => p.security && p.security.allowActions === true),
      'revert must push allowActions back to true');
  });
});
