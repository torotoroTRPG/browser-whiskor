/**
 * tests/unit/extension-installer.test.js
 *
 * Exercises the REAL server/extension-installer.js: managed-directory sync
 * (staged swap), first-run detection, stale-file removal, source-less layout
 * skip, and the WHISKOR_MANAGED_DIR override.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { syncExtensions, getManagedRoot, readManifestVersion } =
  require('../../server/extension-installer');

let tmpRoot;        // fake package root (bundled sources)
let tmpManaged;     // fake managed root (install target)

function writeManifest(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version }), 'utf8');
}

beforeEach(() => {
  tmpRoot    = fs.mkdtempSync(path.join(os.tmpdir(), 'whk-inst-src-'));
  tmpManaged = fs.mkdtempSync(path.join(os.tmpdir(), 'whk-inst-dst-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot,    { recursive: true, force: true });
  fs.rmSync(tmpManaged, { recursive: true, force: true });
  delete process.env.WHISKOR_MANAGED_DIR;
});

describe('extension-installer — managed directory sync', () => {
  test('first run installs bundled sources and reports firstRun + version', () => {
    writeManifest(path.join(tmpRoot, 'extension'), '1.2.3');
    fs.mkdirSync(path.join(tmpRoot, 'extension', 'injected'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'extension', 'injected', 'a.js'), '// a', 'utf8');

    const { results } = syncExtensions(tmpRoot, tmpManaged);
    const chrome = results.find(r => r.browser === 'chrome');

    assert.strictEqual(chrome.skipped, false);
    assert.strictEqual(chrome.firstRun, true);
    assert.strictEqual(chrome.version, '1.2.3');
    assert.ok(fs.existsSync(path.join(tmpManaged, 'extension', 'injected', 'a.js')),
      'nested files must be copied');
  });

  test('re-sync is not firstRun and replaces stale files (swap, not merge)', () => {
    writeManifest(path.join(tmpRoot, 'extension'), '1.0.0');
    fs.writeFileSync(path.join(tmpRoot, 'extension', 'old.js'), 'old', 'utf8');
    syncExtensions(tmpRoot, tmpManaged);

    // Upstream: old.js removed, new.js added, version bumped
    fs.rmSync(path.join(tmpRoot, 'extension', 'old.js'));
    fs.writeFileSync(path.join(tmpRoot, 'extension', 'new.js'), 'new', 'utf8');
    writeManifest(path.join(tmpRoot, 'extension'), '1.0.1');

    const { results } = syncExtensions(tmpRoot, tmpManaged);
    const chrome = results.find(r => r.browser === 'chrome');

    assert.strictEqual(chrome.firstRun, false);
    assert.strictEqual(chrome.version, '1.0.1');
    assert.ok(fs.existsSync(path.join(tmpManaged, 'extension', 'new.js')));
    assert.ok(!fs.existsSync(path.join(tmpManaged, 'extension', 'old.js')),
      'stale files must not survive a sync (whole-directory swap)');
  });

  test('source-less layout is reported as skipped, never an error', () => {
    // No extension/ or firefox-mv2/ under tmpRoot at all
    const { results } = syncExtensions(tmpRoot, tmpManaged);
    assert.ok(results.every(r => r.skipped === true));
    assert.ok(results.every(r => typeof r.reason === 'string'));
  });

  test('both browsers sync independently (firefox present, chrome absent)', () => {
    writeManifest(path.join(tmpRoot, 'firefox-mv2'), '2.0.0');
    const { results } = syncExtensions(tmpRoot, tmpManaged);

    assert.strictEqual(results.find(r => r.browser === 'chrome').skipped, true);
    const ff = results.find(r => r.browser === 'firefox');
    assert.strictEqual(ff.skipped, false);
    assert.strictEqual(ff.version, '2.0.0');
  });

  test('no staging leftovers remain after a successful sync', () => {
    writeManifest(path.join(tmpRoot, 'extension'), '1.0.0');
    syncExtensions(tmpRoot, tmpManaged);
    const leftovers = fs.readdirSync(tmpManaged).filter(n => n.includes('.tmp-'));
    assert.deepStrictEqual(leftovers, []);
  });

  test('WHISKOR_MANAGED_DIR overrides the default managed root', () => {
    process.env.WHISKOR_MANAGED_DIR = tmpManaged;
    assert.strictEqual(getManagedRoot(), tmpManaged);
  });

  test('readManifestVersion returns null for a missing manifest', () => {
    assert.strictEqual(readManifestVersion(path.join(tmpRoot, 'nope')), null);
  });
});
