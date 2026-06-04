/**
 * tests/unit/source-index.test.js
 * Section 15.1 — Source upload & slicing (slice 1)
 *
 * Exercises the REAL server/source-index.js with persist:false (no disk).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSourceIndex, queryContext, langOf } = require('../../server/source-index');

const idx = () => createSourceIndex({ persist: false });

const SAMPLE = {
  'src/auth/LoginForm.tsx': 'import React from "react";\nexport function LoginForm() {\n  return null;\n}\n',
  'src/util/helpers.js': Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'),
  'node_modules/dep/index.js': 'should be skipped',
  'assets/logo.png': 'binarybytes',
};

describe('15.1 addFiles / listFiles', () => {
  it('stores text files and skips node_modules + binaries', () => {
    const s = idx();
    const r = s.addFiles('proj', SAMPLE);
    assert.strictEqual(r.added, 2);
    assert.ok(r.skipped >= 2);
    const files = s.listFiles('proj').map((f) => f.path);
    assert.ok(files.includes('src/auth/LoginForm.tsx'));
    assert.ok(!files.some((p) => p.includes('node_modules')));
    assert.ok(!files.some((p) => p.endsWith('.png')));
  });

  it('reports language and line counts', () => {
    const s = idx();
    s.addFiles('proj', SAMPLE);
    const lf = s.listFiles('proj').find((f) => f.path.endsWith('.tsx'));
    assert.strictEqual(lf.language, 'typescript');
    assert.ok(lf.lines >= 4);
  });
});

describe('15.1 getSlice', () => {
  it('returns an excerpt around a line', () => {
    const s = idx();
    s.addFiles('proj', SAMPLE);
    const sl = s.getSlice('proj', 'src/util/helpers.js', { line: 25, around: 3 });
    assert.deepStrictEqual(sl.lines, [22, 28]);
    assert.ok(sl.excerpt.includes('line 25'));
    assert.strictEqual(sl.totalLines, 50);
    assert.strictEqual(sl.truncated, true);
  });

  it('honours an explicit from/to range', () => {
    const s = idx();
    s.addFiles('proj', SAMPLE);
    const sl = s.getSlice('proj', 'src/util/helpers.js', { from: 10, to: 12 });
    assert.deepStrictEqual(sl.lines, [10, 12]);
    assert.strictEqual(sl.excerpt, 'line 10\nline 11\nline 12');
  });

  it('caps a whole-file request at maxLines', () => {
    const s = idx();
    s.addFiles('proj', SAMPLE);
    const sl = s.getSlice('proj', 'src/util/helpers.js', { maxLines: 5 });
    assert.deepStrictEqual(sl.lines, [1, 5]);
    assert.strictEqual(sl.truncated, true);
  });

  it('returns null for an unknown file or project', () => {
    const s = idx();
    s.addFiles('proj', SAMPLE);
    assert.strictEqual(s.getSlice('proj', 'nope.js', {}), null);
    assert.strictEqual(s.getSlice('other', 'src/util/helpers.js', {}), null);
  });
});

describe('15.1 findSymbol (heuristic)', () => {
  it('finds the file that declares a symbol', () => {
    const s = idx();
    s.addFiles('proj', SAMPLE);
    const hits = s.findSymbol('proj', 'LoginForm');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].path, 'src/auth/LoginForm.tsx');
    assert.strictEqual(hits[0].line, 2);
  });

  it('returns nothing for an undeclared name', () => {
    const s = idx();
    s.addFiles('proj', SAMPLE);
    assert.deepStrictEqual(s.findSymbol('proj', 'NoSuchThing'), []);
  });
});

describe('15.1 queryContext', () => {
  const built = () => { const s = idx(); s.addFiles('proj', SAMPLE); return s; };

  it('lists files when no file/symbol is given', () => {
    const r = queryContext(built(), {});
    assert.strictEqual(r.projectId, 'proj');
    assert.ok(Array.isArray(r.files) && r.files.length === 2);
  });

  it('slices the single file declaring a symbol', () => {
    const r = queryContext(built(), { symbol: 'LoginForm', around: 1 });
    assert.strictEqual(r.matchedSymbol, 'LoginForm');
    assert.strictEqual(r.file, 'src/auth/LoginForm.tsx');
    assert.ok(r.excerpt.includes('LoginForm'));
  });

  it('slices an explicit file', () => {
    const r = queryContext(built(), { file: 'src/util/helpers.js', from: 1, to: 2 });
    assert.deepStrictEqual(r.lines, [1, 2]);
  });

  it('errors with no uploaded source', () => {
    assert.match(queryContext(idx(), {}).error, /No uploaded source/);
  });

  it('resolves a component to its source slice via correlations (slice 2)', () => {
    const { createCorrelations } = require('../../server/source-correlation');
    const r = queryContext(built(), { component: 'LoginForm', around: 1 }, createCorrelations());
    assert.strictEqual(r.component, 'LoginForm');
    assert.strictEqual(r.confidence, 'name-match');
    assert.ok(r.excerpt.includes('LoginForm'));
  });
});

describe('15.1 langOf', () => {
  it('maps extensions to languages', () => {
    assert.strictEqual(langOf('a/b.tsx'), 'typescript');
    assert.strictEqual(langOf('x.py'), 'python');
    assert.strictEqual(langOf('readme'), 'text');
  });
});
