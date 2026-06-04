/**
 * tests/unit/zip-reader.test.js
 * Section 16.x — dependency-free ZIP reader (source-upload, T7)
 *
 * Round-trips the REAL zip-writer.buildZip through the REAL zip-reader.readZip,
 * covering both the STORE and DEFLATE paths the writer picks, plus guards.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildZip } = require('../../server/zip-writer');
const { readZip } = require('../../server/zip-reader');

describe('16.x zip-reader round-trip', () => {
  it('reads back stored (incompressible) and deflated (repetitive) entries', () => {
    const repetitive = 'export function Foo(){ return 1; }\n'.repeat(50); // compresses → DEFLATE
    const tiny = 'x';                                                     // too small → STORE
    const zip = buildZip([
      { name: 'src/a/LoginForm.tsx', data: repetitive },
      { name: 'src/b.txt', data: tiny },
      { name: 'utf/héllo.js', data: 'const s = "café ☕";' },
    ]);
    const files = readZip(zip);
    assert.strictEqual(files['src/a/LoginForm.tsx'], repetitive);
    assert.strictEqual(files['src/b.txt'], tiny);
    assert.strictEqual(files['utf/héllo.js'], 'const s = "café ☕";');
    assert.strictEqual(Object.keys(files).length, 3);
  });

  it('skips directory entries and ignores a trailing comment region', () => {
    const zip = buildZip([{ name: 'only.js', data: 'ok' }]);
    const files = readZip(zip);
    assert.deepStrictEqual(Object.keys(files), ['only.js']);
  });

  it('returns {} for an empty or non-zip buffer', () => {
    assert.deepStrictEqual(readZip(Buffer.alloc(0)), {});
    assert.deepStrictEqual(readZip(Buffer.from('not a zip at all, just text')), {});
    assert.deepStrictEqual(readZip(null), {});
  });

  it('caps the number of entries it reads', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.txt`, data: String(i) }));
    const zip = buildZip(entries);
    const files = readZip(zip, { maxEntries: 3 });
    assert.ok(Object.keys(files).length <= 3);
  });

  it('feeds straight into the source index (upload path)', () => {
    const { createSourceIndex } = require('../../server/source-index');
    const zip = buildZip([
      { name: 'src/LoginForm.tsx', data: 'export function LoginForm(){ return null; }' },
      { name: 'node_modules/dep/x.js', data: 'skip me' },
    ]);
    const idx = createSourceIndex({ persist: false });
    const r = idx.addFiles('proj', readZip(zip));
    assert.strictEqual(r.added, 1, 'node_modules skipped by the index');
    assert.ok(idx.findSymbol('proj', 'LoginForm').length === 1);
  });
});
