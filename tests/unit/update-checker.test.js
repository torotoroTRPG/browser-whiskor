/**
 * tests/unit/update-checker.test.js
 * Exercises the REAL server/update-checker.js: semver compare + the best-effort
 * fetch/compare (via an injected fetchImpl, no network) + the orchestrator's
 * notify/autoSetup gating. Also guards docs/version.json ↔ package.json sync.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const uc = require('../../server/update-checker');
const ROOT = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

describe('compareSemver', () => {
  it('orders by major.minor.patch', () => {
    assert.equal(uc.compareSemver('0.11.0', '0.10.1'), 1);
    assert.equal(uc.compareSemver('0.10.1', '0.11.0'), -1);
    assert.equal(uc.compareSemver('0.10.1', '0.10.1'), 0);
    assert.equal(uc.compareSemver('1.0.0', '0.99.99'), 1);
  });
  it('tolerates a v prefix and prerelease suffix', () => {
    assert.equal(uc.compareSemver('v0.10.2', '0.10.1'), 1);
    assert.equal(uc.compareSemver('1.0.0-rc.1', '0.10.1'), 1);
    // prerelease suffix is dropped for the numeric compare
    assert.equal(uc.compareSemver('1.0.0-rc.1', '1.0.0'), 0);
  });
  it('treats malformed parts as 0', () => {
    assert.equal(uc.compareSemver('', '0.0.0'), 0);
    assert.equal(uc.compareSemver('0.1', '0.1.0'), 0);
  });
});

describe('checkForUpdate', () => {
  const fetchJson = (obj, ok = true, status = 200) => async () => ({ ok, status, json: async () => obj });

  it('flags an available update', async () => {
    const r = await uc.checkForUpdate({ url: 'x', currentVersion: '0.10.1', fetchImpl: fetchJson({ version: '0.11.0', tag: 'v0.11.0', releaseUrl: 'https://r' }) });
    assert.equal(r.ok, true);
    assert.equal(r.updateAvailable, true);
    assert.equal(r.latest, '0.11.0');
    assert.equal(r.url, 'https://r');
  });

  it('reports no update when equal', async () => {
    const r = await uc.checkForUpdate({ url: 'x', currentVersion: '0.11.0', fetchImpl: fetchJson({ version: '0.11.0' }) });
    assert.equal(r.ok, true);
    assert.equal(r.updateAvailable, false);
  });

  it('degrades (never throws) on HTTP error, bad payload, and missing url', async () => {
    const bad = await uc.checkForUpdate({ url: 'x', currentVersion: '0.10.1', fetchImpl: fetchJson({}, false, 404) });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /404/);

    const noVer = await uc.checkForUpdate({ url: 'x', currentVersion: '0.10.1', fetchImpl: fetchJson({ notversion: 1 }) });
    assert.equal(noVer.ok, false);

    const noUrl = await uc.checkForUpdate({ currentVersion: '0.10.1' });
    assert.equal(noUrl.ok, false);
  });

  it('swallows a throwing fetch', async () => {
    const r = await uc.checkForUpdate({ url: 'x', currentVersion: '0.10.1', fetchImpl: async () => { throw new Error('boom'); } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'boom');
  });
});

describe('runUpdateCheck orchestration', () => {
  it('is a no-op when disabled', async () => {
    const r = await uc.runUpdateCheck({ enabled: false }, '0.10.1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'disabled');
  });
});

describe('runNotifyCommand injection guard', () => {
  it('runs when substituted remote values are shell-safe', () => {
    const ok = uc.runNotifyCommand('true {latest} {tag} {url}', {
      latest: '0.12.0', tag: 'v0.12.0', url: 'https://github.com/o/r/releases/tag/v0.12.0',
    });
    assert.equal(ok, true);
  });

  it('refuses to run when a referenced placeholder value carries shell metacharacters', () => {
    const logs = [];
    const log = (level, msg) => logs.push(msg);
    // A compromised/MITM'd version.json feeds an injected releaseUrl.
    const ran = uc.runNotifyCommand('notify-send {url}', {
      url: 'https://x; rm -rf ~',
    }, log);
    assert.equal(ran, false, 'must not spawn a shell command containing injected metacharacters');
    assert.ok(logs.some(m => /shell metacharacters/.test(m)), 'should log the reason');
  });

  it('ignores unsafe values for placeholders the command does not reference', () => {
    // {url} is dangerous but unused → command still runs on the safe {latest}.
    const ran = uc.runNotifyCommand('true {latest}', {
      latest: '0.12.0', url: 'https://x && evil',
    });
    assert.equal(ran, true);
  });

  it('refuses on a bare backtick / $() substitution attempt', () => {
    assert.equal(uc.runNotifyCommand('echo {tag}', { tag: 'v1$(whoami)' }), false);
    assert.equal(uc.runNotifyCommand('echo {tag}', { tag: 'v1`id`' }), false);
  });
});

describe('docs/version.json sync', () => {
  it('matches package.json (kept in step by scripts/_check-version.js)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'version.json'), 'utf8'));
    assert.equal(ver.version, pkg.version, 'docs/version.json version must equal package.json — run `npm run sync-version`');
    assert.equal(ver.tag, `v${pkg.version}`);
  });
});
