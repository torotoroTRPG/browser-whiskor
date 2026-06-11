/**
 * tests/unit/embed-model-name-consistency.test.js
 *
 * The MiniLM embedding model id must include the `Xenova/` org prefix
 * everywhere it is referenced. @xenova/transformers does not auto-prepend
 * an org for bare model names — `paraphrase-multilingual-MiniLM-L12-v2`
 * (no org) resolves to a non-existent HF repo and fails with
 * "Unauthorized access". This test pins all defaults to one canonical
 * repo id so the prefix can't silently drop again, and so the 4 fallback
 * defaults can't drift apart from each other or from config.json.
 */
// @allow-no-prod-import: static contract checker — reads config.json and
// server source files with fs to compare embedded model-id string literals.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../..');

const CANONICAL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

function read(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

function extract(src, regex, file) {
  const m = src.match(regex);
  assert.ok(m, `expected pattern not found in ${file}: ${regex}`);
  return m;
}

describe('embed model name consistency (Xenova/ org prefix)', () => {
  it('server/index.js startup pre-download passes the prefixed repo id to pipeline()', () => {
    const src = read('server/index.js');
    const m = extract(src, /pipeline\('feature-extraction',\s*'([^']+)'/, 'server/index.js');
    assert.equal(m[1], CANONICAL);
  });

  it('server/index.js cache existence check matches the FileCache layout (cacheDir/Xenova/<model>)', () => {
    const src = read('server/index.js');
    const m = extract(
      src,
      /modelCached = fs\.existsSync\(path\.join\(cacheDir, '([^']+)', '([^']+)'\)\)/,
      'server/index.js'
    );
    assert.equal(`${m[1]}/${m[2]}`, CANONICAL);
  });

  it('embed-worker-pool.js default modelName matches the canonical repo id', () => {
    const src = read('server/services/embed-worker-pool.js');
    const m = extract(src, /modelName: _config\?\.modelName \|\| '([^']+)'/, 'embed-worker-pool.js');
    assert.equal(m[1], CANONICAL);
  });

  it('embed-store.js default model version matches the canonical repo id', () => {
    const src = read('server/services/embed-store.js');
    const m = extract(src, /let _modelVersion = '([^']+)'/, 'embed-store.js');
    assert.equal(m[1], CANONICAL);
  });

  it('embed-service.js default modelName matches the canonical repo id', () => {
    const src = read('server/services/embed-service.js');
    const m = extract(src, /const modelName = mlCfg\.model \|\| '([^']+)'/, 'embed-service.js');
    assert.equal(m[1], CANONICAL);
  });

  it('config.json intelligence.searchClassifier.miniLM.model matches the canonical repo id', () => {
    const config = JSON.parse(read('config.json'));
    assert.equal(config.intelligence.searchClassifier.miniLM.model, CANONICAL);
  });

  it('scripts/download-model.js resolves MODEL_NAME + Xenova/ template to the canonical repo id', () => {
    const src = read('scripts/download-model.js');
    const m = extract(src, /const MODEL_NAME = '([^']+)'/, 'download-model.js');
    assert.match(src, /const HF_REPO = `Xenova\/\$\{MODEL_NAME\}`/);
    assert.equal(`Xenova/${m[1]}`, CANONICAL);
  });
});
