/**
 * tests/unit/screenshot-prune.test.js
 * Exercises the REAL screenshot-manager.pruneOldScreenshots — the disk-retention
 * fix for cache/screenshots growing without bound
 * (local_issues/2026-06-17_capture-image-cache-and-disk-leak.md).
 *
 * Uses a temp directory (injected via the dir argument) so no real cache is touched.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pruneOldScreenshots } = require('../../server/screenshot-manager');

let DIR;
function write(name, bytes, ageMs = 0) {
  const fp = path.join(DIR, name);
  fs.writeFileSync(fp, Buffer.alloc(bytes, 1));
  if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(fp, t, t); }
  return fp;
}

before(() => { DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'whk-shots-')); });
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe('pruneOldScreenshots — size cap', () => {
  it('evicts oldest files until under maxMB', () => {
    fs.readdirSync(DIR).forEach(f => fs.unlinkSync(path.join(DIR, f)));
    const MB = 1024 * 1024;
    write('old.png',  1 * MB, 30_000); // oldest
    write('mid.png',  1 * MB, 20_000);
    write('new.png',  1 * MB, 10_000); // newest
    // cap at ~2MB → the single oldest must go, two newest survive
    const res = pruneOldScreenshots(DIR, { maxMB: 2, maxAgeMs: 0 });
    assert.strictEqual(res.deleted, 1);
    const left = fs.readdirSync(DIR).sort();
    assert.deepStrictEqual(left, ['mid.png', 'new.png']);
    assert.ok(res.remainingMB <= 2);
  });
});

describe('pruneOldScreenshots — age cap', () => {
  it('deletes files older than maxAgeMs regardless of size', () => {
    fs.readdirSync(DIR).forEach(f => fs.unlinkSync(path.join(DIR, f)));
    write('ancient.png', 1024, 60 * 60 * 1000); // 1h old
    write('fresh.png',   1024, 1_000);
    const res = pruneOldScreenshots(DIR, { maxMB: 1000, maxAgeMs: 10 * 60 * 1000 }); // 10min
    assert.strictEqual(res.deleted, 1);
    assert.deepStrictEqual(fs.readdirSync(DIR), ['fresh.png']);
  });
});

describe('pruneOldScreenshots — robustness', () => {
  it('returns zeros for a missing directory (never throws)', () => {
    const res = pruneOldScreenshots(path.join(DIR, 'does-not-exist'), { maxMB: 1 });
    assert.deepStrictEqual(res, { deleted: 0, freedMB: 0, remainingMB: 0 });
  });

  it('keeps everything when under both caps', () => {
    fs.readdirSync(DIR).forEach(f => fs.unlinkSync(path.join(DIR, f)));
    write('a.png', 1024, 1_000);
    write('b.png', 1024, 2_000);
    const res = pruneOldScreenshots(DIR, { maxMB: 1000, maxAgeMs: 0 });
    assert.strictEqual(res.deleted, 0);
    assert.strictEqual(fs.readdirSync(DIR).length, 2);
  });
});
