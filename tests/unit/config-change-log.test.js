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

  test('ids never collide after pruning shrinks the array (max+1, not length+1)', () => {
    // Simulate the post-prune state: few entries, but with a high surviving id.
    // length+1 would mint an id that already exists, and markReverted would
    // then flip the wrong (old) entry.
    const all = log._getAll();
    const highId = all.reduce((m, c) => Math.max(m, c.id || 0), 0) + 1000;
    all.push({ id: highId, timestamp: Date.now(), reverted: true, patch: {}, warnings: [] });

    const marker = `__collide_${Date.now()}_${Math.random()}`;
    log.addChange({ patch: { server: { wsPort: 7891 } }, warnings: [], note: marker });

    const added = log.getActiveChanges().find(c => c.note === marker);
    assert.ok(added, 'change must be added');
    assert.strictEqual(added.id, highId + 1, 'new id must exceed every surviving id');
    assert.strictEqual(all.filter(c => c.id === added.id).length, 1, 'id must be unique');

    log.markReverted(added.id);
    assert.ok(!log.getActiveChanges().some(c => c.note === marker),
      'markReverted must hit the entry it minted, not an older one');
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

  test('reverts a number change by restoring its default value', () => {
    log.addChange({
      patch: { react: { maxDepth: 999 } },
      warnings: [{ severity: 'warning', message: 'bad depth' }],
    });

    const pushed = [];
    const report = log.autoRevertIfNeeded(
      { agentControl: { autoRevertConfig: true } },
      (patch) => pushed.push(patch),
    );

    assert.ok(report, 'should produce a revert report for number change');
    const rule = log.NON_RECOMMENDED_RULES.find(r => r.path === 'react.maxDepth');
    assert.ok(pushed.some(p => p.react && p.react.maxDepth === rule.defaultValue),
      `revert must restore maxDepth to default (${rule.defaultValue})`);
  });

  test('does not mark unrelated changes as reverted (no markAllReverted sweep)', () => {
    const safeMarker = `__safe_${Date.now()}_${Math.random()}`;
    log.addChange({
      patch: { server: { wsPort: 9999 } },
      warnings: [],
      note: safeMarker,
    });

    log.addChange({
      patch: { security: { allowExecuteJs: false } },
      warnings: [{ severity: 'danger', message: 'disabled js' }],
    });

    const report = log.autoRevertIfNeeded(
      { agentControl: { autoRevertConfig: true } },
      () => {},
    );

    assert.ok(report, 'dangerous change should be reverted');
    const safe = log._getAll().find(c => c.note === safeMarker);
    assert.ok(safe, 'safe change must still exist');
    assert.strictEqual(safe.reverted, false,
      'unrelated safe change must NOT be marked as reverted');
  });
});
