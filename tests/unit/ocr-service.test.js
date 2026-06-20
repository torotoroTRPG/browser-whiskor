/**
 * tests/unit/ocr-service.test.js
 * Native OCR engine binding (server/services/ocr-service.js).
 *
 * Exercises the REAL service. The engine-dependent paths are driven without a
 * Tesseract binary installed (CI-safe): a bogus binPath resolves to no engine, so
 * recognize() returns the documented ocr_unavailable contract. The TSV parser is
 * tested directly with canonical Tesseract `tsv` output.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ocr = require('../../server/services/ocr-service');

afterEach(() => ocr._reset());

describe('ocr-service TSV parsing', () => {
  const TSV = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t200\t100\t-1\t',          // page (level 1) — ignored
    '5\t1\t1\t1\t1\t1\t10\t20\t50\t14\t96\tHello',
    '5\t1\t1\t1\t1\t2\t65\t20\t60\t14\t91\tWorld',
    '5\t1\t1\t1\t2\t1\t10\t40\t40\t14\t88\tNext',
    '5\t1\t1\t1\t2\t2\t55\t40\t30\t14\t12\t   ',        // whitespace-only — skipped
  ].join('\n');

  it('keeps only word-level rows with real text', () => {
    const r = ocr._parseTsv(TSV);
    assert.equal(r.wordCount, 3);
    assert.deepEqual(r.words.map(w => w.text), ['Hello', 'World', 'Next']);
  });

  it('assembles text per line (block.par.line bucket)', () => {
    const r = ocr._parseTsv(TSV);
    assert.equal(r.text, 'Hello World\nNext');
  });

  it('exposes both Tesseract fields and x/y/w/h aliases + confidence', () => {
    const { words } = ocr._parseTsv(TSV);
    const hello = words[0];
    assert.equal(hello.level, 5);
    assert.equal(hello.left, 10);
    assert.equal(hello.x, 10);
    assert.equal(hello.y, 20);
    assert.equal(hello.w, 50);
    assert.equal(hello.h, 14);
    assert.equal(hello.confidence, 96);
    assert.equal(hello.line_num, 1);
  });

  it('returns an empty result for blank/garbage input', () => {
    assert.deepEqual(ocr._parseTsv(''), { text: '', words: [], wordCount: 0 });
    assert.deepEqual(ocr._parseTsv('only-a-header-line'), { text: '', words: [], wordCount: 0 });
  });
});

describe('ocr-service engine resolution', () => {
  it('reports unavailable when explicitly disabled', () => {
    ocr.init({ intelligence: { ocr: { enabled: false } } });
    assert.equal(ocr.isAvailable(), false);
    assert.deepEqual(ocr.getStatus(), { available: false, reason: 'disabled' });
  });

  it('reports no_engine (with install hint) when the binary does not resolve', () => {
    ocr.init({ intelligence: { ocr: { enabled: true, binPath: '/nonexistent/whiskor-no-such-ocr-binary' } } });
    assert.equal(ocr.isAvailable(), false);
    const st = ocr.getStatus();
    assert.equal(st.available, false);
    assert.equal(st.reason, 'no_engine');
    assert.match(st.hint, /Tesseract/);
  });

  it('recognize() resolves (never rejects) with ocr_unavailable when no engine', async () => {
    ocr.init({ intelligence: { ocr: { enabled: true, binPath: '/nonexistent/whiskor-no-such-ocr-binary' } } });
    const r = await ocr.recognize(Buffer.from([1, 2, 3]));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ocr_unavailable');
    assert.match(r.hint, /WHISKOR_OCR_PATH/);
  });

  it('recognize() never rejects, even on an empty buffer', async () => {
    ocr.init({ intelligence: { ocr: { enabled: true, binPath: '/nonexistent/x' } } });
    const r = await ocr.recognize(Buffer.alloc(0));
    // No engine resolves here, so the ocr_unavailable guard runs before empty_image.
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ocr_unavailable');
  });
});
