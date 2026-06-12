/**
 * tests/unit/cli-shell.test.js
 *
 * Exercises the REAL server/cli-shell.js pure parts: catalog expansion with
 * live ids, incremental filtering/ranking, and command parsing. The raw-mode
 * key loop is interactive and is covered by the non-TTY REPL smoke instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseCatalog, expandCatalog, filterCandidates, parseCommand } =
  require('../../server/cli-shell');

describe('cli-shell — catalog expansion', () => {
  it('expands :tabId templates into concrete commands for live sessions', () => {
    const cat = expandCatalog(baseCatalog(), [
      { tabId: 111, url: 'https://app.test/x', title: 'X', updatedAt: 2 },
      { tabId: 222, url: 'https://app.test/y', title: 'Y', updatedAt: 1 },
    ], []);
    const concrete = cat.filter(c => c.concrete && c.text.includes('/api/sessions/111'));
    assert.ok(concrete.length > 0, 'must add concrete tabId variants');
    assert.ok(concrete[0].desc.includes('app.test'));
    // The freshest session sorts first within a template's variants
    const states = cat.filter(c => c.text.endsWith('/states') && c.concrete);
    assert.ok(states[0].text.includes('111'));
  });

  it('expands :siteVersion templates from graphs', () => {
    const cat = expandCatalog(baseCatalog(), [], [{ siteVersion: 'v1', nodeCount: 5, edgeCount: 4 }]);
    const hit = cat.find(c => c.text === 'GET /api/graphs/v1/states');
    assert.ok(hit, 'graph siteVersion must become a runnable command');
    assert.ok(hit.desc.includes('5 nodes'));
  });

  it('templates stay in the catalog even with no live data', () => {
    const cat = expandCatalog(baseCatalog(), [], []);
    assert.ok(cat.some(c => c.text.includes(':tabId')));
  });
});

describe('cli-shell — filtering', () => {
  const cat = expandCatalog(baseCatalog(), [{ tabId: 42, url: 'https://shop.test/', updatedAt: 1 }], []);

  it('empty query returns everything', () => {
    assert.strictEqual(filterCandidates(cat, '').length, cat.length);
  });

  it('every token must match somewhere (text or description)', () => {
    const hits = filterCandidates(cat, 'get states 42');
    assert.ok(hits.length > 0);
    assert.ok(hits.every(c => c.text.includes('42') && c.text.includes('states')));
  });

  it('description words find commands too (search by intent)', () => {
    const hits = filterCandidates(cat, 'screenshot');
    assert.ok(hits.some(c => c.text.includes('/api/screenshot')));
  });

  it('prefix matches rank above substring matches', () => {
    const hits = filterCandidates(cat, 'get /api/se');
    assert.ok(hits[0].text.startsWith('GET /api/se'));
  });

  it('no match returns empty, never throws', () => {
    assert.deepStrictEqual(filterCandidates(cat, 'zzz_nothing_zzz'), []);
  });
});

describe('cli-shell — command parsing', () => {
  it('parses HTTP commands with optional JSON body', () => {
    assert.deepStrictEqual(parseCommand('GET /health'),
      { kind: 'http', method: 'GET', path: '/health', body: null });
    const p = parseCommand('post /api/collect {"tabId": 1}');
    assert.strictEqual(p.method, 'POST');
    assert.strictEqual(p.body, '{"tabId": 1}');
  });

  it('recognizes builtins and aliases', () => {
    assert.strictEqual(parseCommand('exit').name, 'exit');
    assert.strictEqual(parseCommand('q').name, 'exit');
    assert.strictEqual(parseCommand('?').name, 'help');
    assert.strictEqual(parseCommand('refresh').name, 'refresh');
  });

  it('classifies empty and unknown input', () => {
    assert.strictEqual(parseCommand('   ').kind, 'empty');
    assert.strictEqual(parseCommand('frobnicate the things').kind, 'unknown');
  });
});
