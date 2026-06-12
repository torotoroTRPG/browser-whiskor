'use strict';
/**
 * extension-installer.js — managed extension directory sync
 *
 * EN: Copies the bundled extension sources (extension/, firefox-mv2/) into a
 *     whiskor-managed directory (~/.whiskor/ by default). The user loads the
 *     unpacked extension from there ONCE; afterwards `whk setup` can refresh
 *     the files in place and the server can ask the extension to reload over
 *     the existing WebSocket — no filesystem path ever crosses the network
 *     (extensions cannot read their own install path by design, and we never
 *     expose the managed path via HTTP/MCP).
 * JA: 同梱の拡張ソース (extension/, firefox-mv2/) を whiskor 管理ディレクトリ
 *     (既定 ~/.whiskor/) へコピーする。ユーザーはそこから一度だけ unpacked で
 *     読み込めばよく、以後 `whk setup` がファイルを更新し、サーバーが既存の
 *     WebSocket 経由でリロードを依頼できる。パスがネットワークを越えることは
 *     ない（拡張は自分のインストールパスを取得できない設計だし、管理パスを
 *     HTTP/MCP で公開することもしない）。
 *
 * Zero-dependency CommonJS, mirrors the atomic-write spirit of cache-writer.js:
 * copy into a staging dir, then swap — a crash mid-copy never leaves a
 * half-written extension where the browser loads from.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BROWSER_DIRS = [
  { dir: 'extension',   browser: 'chrome',  label: 'Chrome/Edge (MV3)' },
  { dir: 'firefox-mv2', browser: 'firefox', label: 'Firefox (MV2)' },
];

/** Managed root. Overridable for tests / embedders via WHISKOR_MANAGED_DIR. */
function getManagedRoot() {
  return process.env.WHISKOR_MANAGED_DIR || path.join(os.homedir(), '.whiskor');
}

function readManifestVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/**
 * Sync bundled extension sources into the managed directory.
 * Returns { managedRoot, results: [{ browser, label, dir, skipped, reason?,
 * firstRun?, dest?, version? }] }. A missing source (e.g. a source-less
 * release layout) is reported as skipped, never an error — mirrors
 * restart.ps1's "no extension source found — skipping rebuild" behaviour.
 */
function syncExtensions(packageRoot, managedRoot = getManagedRoot()) {
  const results = [];
  for (const { dir, browser, label } of BROWSER_DIRS) {
    const src  = path.join(packageRoot, dir);
    const dest = path.join(managedRoot, dir);

    if (!fs.existsSync(path.join(src, 'manifest.json'))) {
      results.push({ browser, label, dir, skipped: true, reason: 'extension source not bundled in this layout' });
      continue;
    }

    const firstRun = !fs.existsSync(path.join(dest, 'manifest.json'));
    const staging  = dest + '.tmp-' + process.pid;

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, staging, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);

    results.push({
      browser, label, dir,
      skipped: false,
      firstRun,
      dest,
      version: readManifestVersion(dest),
    });
  }
  return { managedRoot, results };
}

module.exports = { getManagedRoot, syncExtensions, readManifestVersion, BROWSER_DIRS };
