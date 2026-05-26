/**
 * tests/unit/cache-integrity.test.js
 *
 * Tests for cache-integrity.js
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { checkAndRepair, validateJsonFile, validateIndexStructure, repairIndex } from '../../server/cache-integrity.js';

const TEST_CACHE_DIR = path.join('tests', 'tmp', 'cache-integrity-test');

function createTestSession(cacheDir, tabId, indexOverrides = {}) {
  const sessionDir = path.join(cacheDir, 'test-site', `${tabId}-12345`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'raw/visual'), { recursive: true });

  const index = {
    tabId,
    sessionId: 12345,
    siteVersion: 'test-site',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    url: 'http://example.com',
    title: 'Test',
    summary: { detectedFrameworks: [], textWordCount: 10, networkRequests: 0, consoleLogs: 0 },
    dataFreshness: { 'text-coords': Date.now() },
    files: { raw: {} },
    ...indexOverrides,
  };

  fs.writeFileSync(path.join(sessionDir, '_index.json'), JSON.stringify(index, null, 2));
  return sessionDir;
}

describe('Cache Integrity', () => {

  beforeEach(() => {
    if (fs.existsSync(TEST_CACHE_DIR)) {
      fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_CACHE_DIR)) {
      fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
  });

  test('validateJsonFile returns valid for good JSON', () => {
    const testFile = path.join(TEST_CACHE_DIR, 'good.json');
    fs.writeFileSync(testFile, '{"ok": true}');
    const result = validateJsonFile(testFile);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.data.ok, true);
  });

  test('validateJsonFile returns invalid for bad JSON', () => {
    const testFile = path.join(TEST_CACHE_DIR, 'bad.json');
    fs.writeFileSync(testFile, '{not json}');
    const result = validateJsonFile(testFile);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
  });

  test('validateJsonFile returns invalid for missing file', () => {
    const result = validateJsonFile(path.join(TEST_CACHE_DIR, 'nonexistent.json'));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, 'File not found');
  });

  test('validateIndexStructure detects missing fields', () => {
    const result = validateIndexStructure({ tabId: 1 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.some(i => i.includes('sessionId')));
  });

  test('validateIndexStructure passes for complete index', () => {
    const index = {
      tabId: 1, sessionId: 123, siteVersion: 'v1',
      createdAt: Date.now(), updatedAt: Date.now(), url: null,
      summary: {}, dataFreshness: {}, files: { raw: {} },
    };
    const result = validateIndexStructure(index);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.issues.length, 0);
  });

  test('checkAndRepair detects and repairs corrupted index', () => {
    const sessionDir = createTestSession(TEST_CACHE_DIR, 1);
    // Corrupt the index
    fs.writeFileSync(path.join(sessionDir, '_index.json'), '{bad json');

    const result = checkAndRepair(TEST_CACHE_DIR, { autoRepair: true, verbose: false });
    assert.strictEqual(result.sessions, 1);
    assert.strictEqual(result.repaired, 1);
  });

  test('checkAndRepair removes references to missing files', () => {
    const sessionDir = createTestSession(TEST_CACHE_DIR, 1, {
      files: { raw: { text_coords: 'raw/visual/text-coords.json' } },
    });

    const result = checkAndRepair(TEST_CACHE_DIR, { autoRepair: true, verbose: false });
    assert.strictEqual(result.sessions, 1);
    assert.strictEqual(result.repaired, 1);
  });

  test('checkAndRepair reports healthy sessions', () => {
    createTestSession(TEST_CACHE_DIR, 1);
    createTestSession(TEST_CACHE_DIR, 2);

    const result = checkAndRepair(TEST_CACHE_DIR, { autoRepair: false, verbose: false });
    assert.strictEqual(result.sessions, 2);
    assert.strictEqual(result.healthy, 2);
    assert.strictEqual(result.repaired, 0);
  });

  test('repairIndex creates minimal index for missing file', () => {
    const sessionDir = path.join(TEST_CACHE_DIR, 'test-site', '999-12345');
    fs.mkdirSync(sessionDir, { recursive: true });

    const repair = repairIndex(sessionDir);
    assert.strictEqual(repair.repaired, true);
    assert.ok(repair.index);
    assert.strictEqual(repair.index.tabId, 999);
  });
});
