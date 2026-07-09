/**
 * tests/unit/release-contents.test.js
 *
 * Pins the two release surfaces where paths silently drift:
 *
 * 1. npm package contents — package.json has no `files` field and there is no
 *    .npmignore, so `npm pack` follows .gitignore. That is currently correct
 *    by accident. `whk setup` treats a missing bundled extension/ as a benign
 *    "source-less layout" (skipped, not an error), so if the package ever
 *    stops shipping a runtime piece, a global install breaks SILENTLY. This
 *    test asserts the pack manifest still carries everything `whk` needs.
 *
 * 2. release.yml full-bundle ZIP — the zip line enumerates top-level paths
 *    explicitly. Directory entries pick up new files inside automatically,
 *    but a NEW runtime top-level must be added to the list by hand. This test
 *    keeps the list honest in both directions: every required runtime path is
 *    listed, and every listed path actually exists in the repo.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// What a global `npm i -g` install needs to serve + `whk setup` (bundled
// extension sources, server, CLI, public config, tool profiles, skills).
const REQUIRED_PACK_PATHS = [
  'package.json',
  'config.json',
  'server/cli.js',
  'server/index.js',
  'server/core.js',
  'server/extension-installer.js',
  'server/configs/tool-profiles.json',
  'server/configs/mcp-tools.json',
  'extension/manifest.json',
  'extension/injected/bridge.js',        // sentinel: non-shared injected file
  'extension/injected/state-reporter.js',// sentinel: shared-synced injected file
  'extension/background/sw.js',
  'firefox-mv2/manifest.json',
  'firefox-mv2/background/background.js',
  'skills/README.md',
];

// What the release full bundle must carry (matrix target "full" in
// .github/workflows/release.yml). Directories cover their contents.
const REQUIRED_BUNDLE_PATHS = [
  'server/', 'extension/', 'firefox-mv2/', 'shared/', 'scripts/', 'skills/',
  'docs/', 'start.ps1', 'start.sh', 'start.bat',
  'README.md', 'config.json', 'package.json', 'package-lock.json',
];

describe('npm package contents (whk global install)', () => {
  test('npm pack ships every runtime path whk setup depends on', () => {
    const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT, shell: true, encoding: 'utf8', timeout: 120_000,
    });
    assert.strictEqual(res.status, 0, `npm pack --dry-run failed: ${res.stderr}`);

    // Output is a JSON array with one entry per package; `files` lists paths.
    const parsed = JSON.parse(res.stdout);
    const files = new Set((parsed[0]?.files || []).map(f => f.path.replace(/\\/g, '/')));
    assert.ok(files.size > 0, 'pack manifest is empty');

    const missing = REQUIRED_PACK_PATHS.filter(p => !files.has(p));
    assert.deepStrictEqual(missing, [],
      `npm package no longer ships: ${missing.join(', ')} — a global install's whk setup ` +
      `would degrade to "source-less layout" (skipped) without any error`);
  });
});

describe('release.yml full-bundle enumeration', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');

  /** The path tokens of the full-bundle `zip -r` invocation. */
  function bundleEntries() {
    const start = yml.indexOf('zip -r "${FILENAME}"');
    assert.ok(start > 0, 'full-bundle zip invocation not found in release.yml');
    // The invocation is a backslash-continued line list ending at the -x excludes.
    const section = yml.slice(start, yml.indexOf('-x', start));
    return section
      .split(/\s+/)
      .map(t => t.replace(/\\$/, ''))
      .filter(t => t && !t.startsWith('-') && !t.startsWith('zip') && !t.startsWith('"'));
  }

  test('every required runtime path is in the bundle list', () => {
    const entries = new Set(bundleEntries());
    const missing = REQUIRED_BUNDLE_PATHS.filter(p => !entries.has(p));
    assert.deepStrictEqual(missing, [],
      `release full bundle would ship without: ${missing.join(', ')} — add them to the ` +
      `zip line in .github/workflows/release.yml`);
  });

  test('every listed bundle path exists in the repo (zip errors on missing names)', () => {
    const gone = bundleEntries().filter(p => !fs.existsSync(path.join(ROOT, p)));
    assert.deepStrictEqual(gone, [],
      `release.yml lists paths that no longer exist: ${gone.join(', ')}`);
  });
});
