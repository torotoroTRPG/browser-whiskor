/**
 * tests/unit/tui-folders-logs.test.js
 *
 * Exercises the REAL folder-style navigation (server/tui/app.js), the live
 * tabId in-place rewrite (server/cli-shell.js expandCatalog), the transcript
 * formatter, and the server log ring buffer behind GET /api/logs (core.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseCatalog, expandCatalog } = require('../../server/cli-shell');
const { resolveCandidates, categoriesOf, formatTranscript } = require('../../server/tui/app');
const { WhiskorCore } = require('../../server/core');

describe('tui folders — categoriesOf', () => {
  it('derives one folder row per category with entry counts', () => {
    const cats = categoriesOf(baseCatalog());
    const action = cats.find(c => c.folder === 'action');
    assert.ok(action, 'action/ folder must exist');
    assert.strictEqual(action.text, 'action/');
    assert.match(action.desc, /\(\d+\)$/, 'desc carries the entry count');
    assert.ok(cats.find(c => c.folder === 'capture'));
    assert.ok(cats.find(c => c.folder === 'shell'));
  });
});

describe('tui folders — resolveCandidates', () => {
  const catalog = baseCatalog();
  const cats = categoriesOf(catalog);

  it('root + empty query shows the folders themselves', () => {
    const r = resolveCandidates(catalog, cats, null, '');
    assert.ok(r.length > 0);
    assert.ok(r.every(c => c.folder), 'root view is folders only');
  });

  it('root + query is a deep search (folders first, then commands)', () => {
    const r = resolveCandidates(catalog, cats, null, 'click');
    assert.ok(r.some(c => !c.folder && c.text.includes('"type":"click"')),
      'commands inside folders must still be findable from the root');
  });

  it('inside a folder: only that category, with ".." on top', () => {
    const r = resolveCandidates(catalog, cats, 'action', '');
    assert.strictEqual(r[0].text, '..');
    assert.ok(r[0].up);
    assert.ok(r.slice(1).every(c => c.cat === 'action'));
    assert.ok(r.slice(1).every(c => c.text.includes('/api/action')));
  });

  it('filtering inside a folder hides ".." and stays scoped', () => {
    const r = resolveCandidates(catalog, cats, 'action', 'press');
    assert.ok(r.length > 0);
    assert.ok(!r.some(c => c.up));
    assert.ok(r.every(c => c.cat === 'action'));
  });
});

describe('expandCatalog — live tabId rewrite for POST bodies', () => {
  it('rewrites "tabId":0 in place to the freshest session', () => {
    const cat = expandCatalog(baseCatalog(), [
      { tabId: 999, url: 'https://old.test/', updatedAt: 1 },
      { tabId: 777, url: 'https://fresh.test/page', updatedAt: 2 },
    ], []);
    const click = cat.find(c => c.text.includes('"type":"click","text"'));
    assert.ok(click.text.includes('"tabId":777'), 'freshest session id must be inlined');
    assert.ok(!click.text.includes('"tabId":0'));
    assert.ok(click.desc.includes('fresh.test'), 'desc names the target page');
    assert.strictEqual(click.cat, 'action', 'category survives the rewrite');
  });

  it('keeps the 0 placeholder when no session is live', () => {
    const cat = expandCatalog(baseCatalog(), [], []);
    assert.ok(cat.some(c => c.text.includes('"tabId":0')));
  });
});

describe('formatTranscript', () => {
  it('renders a header plus the plain scrollback lines', () => {
    const text = formatTranscript(
      [{ text: 'whiskor> GET /health', kind: 'cmd' }, { text: '{ "ok": true }', kind: 'json' }],
      { host: '127.0.0.1', port: 7892, version: '9.9.9' },
    );
    assert.match(text, /^# whiskor shell transcript/);
    assert.ok(text.includes('127.0.0.1:7892 (whiskor v9.9.9)'));
    assert.ok(text.includes('whiskor> GET /health'));
    assert.ok(text.endsWith('{ "ok": true }\n'));
  });
});

describe('GET /api/logs — server log ring buffer', () => {
  function makeCore() {
    const core = new WhiskorCore({});
    clearInterval(core._cleanupTimer);
    return core;
  }
  const get = (core, urlStr) =>
    core.handleHttpRequest({ method: 'GET', url: new URL(urlStr, 'http://x'), body: null });

  it('returns lines recorded via broadcastLog (newest last)', () => {
    const core = makeCore();
    core.broadcastLog('info', 'first');
    core.broadcastLog('warn', 'second', 'part');
    const res = get(core, '/api/logs');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 2);
    assert.strictEqual(res.body[1].message, 'second part');
    assert.strictEqual(res.body[1].level, 'warn');
    assert.ok(typeof res.body[0].ts === 'number');
  });

  it('?limit caps from the tail; ?level=warn filters to warn+error', () => {
    const core = makeCore();
    core.broadcastLog('info', 'a');
    core.broadcastLog('warn', 'b');
    core.broadcastLog('error', 'c');
    assert.deepStrictEqual(get(core, '/api/logs?limit=1').body.map(l => l.message), ['c']);
    assert.deepStrictEqual(get(core, '/api/logs?level=warn').body.map(l => l.message), ['b', 'c']);
    assert.deepStrictEqual(get(core, '/api/logs?level=error').body.map(l => l.message), ['c']);
  });

  it('ring buffer drops the oldest lines past the cap', () => {
    const core = makeCore();
    core._logBufferMax = 5;
    for (let i = 0; i < 12; i++) core.broadcastLog('info', `m${i}`);
    const res = get(core, '/api/logs');
    assert.strictEqual(res.body.length, 5);
    assert.strictEqual(res.body[0].message, 'm7');
    assert.strictEqual(res.body[4].message, 'm11');
  });
});
