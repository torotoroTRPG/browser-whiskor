/**
 * tests/unit/source-correlation.test.js
 * Section 15.3 — Runtime→source correlation (slice 2)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSourceIndex } = require('../../server/source-index');
const { createCorrelations } = require('../../server/source-correlation');

function indexWith(files) {
  const s = createSourceIndex({ persist: false });
  s.addFiles('proj', files);
  return s;
}

describe('15.3 correlate', () => {
  it('maps a component to the single file declaring it (name match)', () => {
    const idx = indexWith({ 'src/auth/LoginForm.tsx': 'export function LoginForm() { return null; }' });
    const c = createCorrelations();
    const r = c.correlate('proj', 'LoginForm', idx);
    assert.strictEqual(r.file, 'src/auth/LoginForm.tsx');
    assert.strictEqual(r.confidence, 'name-match');
  });

  it('prefers an exact runtime debug-source hint over name matching', () => {
    const idx = indexWith({
      'src/a/Button.tsx': 'export const Button = () => null;',
      'src/b/Button.tsx': 'export const Button = () => null;',
    });
    const c = createCorrelations();
    const r = c.correlate('proj', 'Button', idx, { file: 'src/b/Button.tsx', line: 1 });
    assert.strictEqual(r.confidence, 'debug-source');
    assert.strictEqual(r.file, 'src/b/Button.tsx');
    assert.strictEqual(r.line, 1);
  });

  it('matches a differently-rooted debug-source path', () => {
    const idx = indexWith({ 'src/auth/LoginForm.tsx': 'export function LoginForm() {}' });
    const c = createCorrelations();
    const r = c.correlate('proj', 'LoginForm', idx, { file: '/abs/webpack/src/auth/LoginForm.tsx', line: 9 });
    assert.strictEqual(r.confidence, 'debug-source');
    assert.strictEqual(r.file, 'src/auth/LoginForm.tsx');
  });

  it('reports ambiguity when several files declare the name and no hint resolves it', () => {
    const idx = indexWith({
      'src/a/Button.tsx': 'export const Button = () => null;',
      'src/b/Button.tsx': 'export const Button = () => null;',
    });
    const r = createCorrelations().correlate('proj', 'Button', idx);
    assert.strictEqual(r.confidence, 'ambiguous');
    assert.strictEqual(r.matches.length, 2);
  });

  it('reports none when nothing declares the component', () => {
    const r = createCorrelations().correlate('proj', 'Ghost', indexWith({ 'a.js': 'x' }));
    assert.strictEqual(r.confidence, 'none');
  });
});

describe('15.3 record / lookup / all', () => {
  it('reuses a recorded correlation (no re-search; count grows)', () => {
    const idx = indexWith({ 'LoginForm.tsx': 'export function LoginForm() {}' });
    const c = createCorrelations();
    const first = c.correlate('proj', 'LoginForm', idx);
    assert.strictEqual(first.count, 1);
    const second = c.correlate('proj', 'LoginForm', idx);
    assert.strictEqual(second.count, 2);
    assert.strictEqual(c.lookup('proj', 'LoginForm').file, 'LoginForm.tsx');
    assert.strictEqual(c.all('proj').length, 1);
  });
});
