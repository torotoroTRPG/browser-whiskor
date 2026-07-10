/**
 * tests/unit/network-header-redaction.test.js
 *
 * Credential-bearing HTTP header VALUES must be redacted at collection time
 * (before emit), on by default, so a raw Authorization/Cookie never reaches
 * the cache, dashboard, /export, or an agent — independently of the opt-in
 * server-side secret-guard.
 *
 * The analyzer is a MAIN-world IIFE (needs window/registry), so this exercises
 * the redaction LOGIC by evaluating the file's redactHeaders in a minimal
 * sandbox, plus wiring pins: every emit site is wrapped, the config default is
 * true in the committed config.json, and index.js forwards it to the SW.
 *
 * @allow-no-prod-import: the analyzer is page-injected (no CommonJS export);
 * we load its source and evaluate the pure helper, and statically pin wiring.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CHROME = 'extension/injected/analyzers/network.js';
const FIREFOX = 'firefox-mv2/injected/analyzers/network.js';

/** Pull `redactHeaders` + its SENSITIVE_HEADER_RE out of the IIFE source and
 *  return the callable — the exact bytes that ship, no reimplementation. */
function loadRedactHeaders(rel) {
  const src = read(rel);
  const reMatch = src.match(/const SENSITIVE_HEADER_RE = [^\n]+/);
  const fnMatch = src.match(/function redactHeaders\(headers, cfg\) \{[\s\S]*?\n {2}\}/);
  assert.ok(reMatch, `${rel}: SENSITIVE_HEADER_RE not found`);
  assert.ok(fnMatch, `${rel}: redactHeaders not found`);
  const ctx = {};
  vm.runInNewContext(`${reMatch[0]};\n${fnMatch[0]};\nthis.redactHeaders = redactHeaders;`, ctx);
  return ctx.redactHeaders;
}

for (const rel of [CHROME, FIREFOX]) {
  describe(`redactHeaders — ${rel}`, () => {
    const redactHeaders = loadRedactHeaders(rel);

    it('redacts credential headers by default, keeping length only', () => {
      const auth = 'Bearer abcdef123456';
      const cookie = 'session=deadbeef; theme=dark';
      const out = redactHeaders({
        'Authorization': auth,
        'Cookie': cookie,
        'Content-Type': 'application/json',
      }, {});
      assert.strictEqual(out['Authorization'], `[redacted len=${auth.length}]`);
      assert.strictEqual(out['Cookie'], `[redacted len=${cookie.length}]`);
      assert.ok(!out['Authorization'].includes('abcdef'), 'no credential bytes survive');
      assert.strictEqual(out['Content-Type'], 'application/json', 'non-secret headers pass through');
    });

    it('is case-insensitive and covers the documented set', () => {
      for (const h of ['authorization', 'SET-COOKIE', 'X-Api-Key', 'x-csrf-token', 'proxy-authorization']) {
        const out = redactHeaders({ [h]: 'secret-value' }, {});
        assert.match(out[h], /^\[redacted len=\d+\]$/, `${h} must be redacted`);
      }
    });

    it('opt-out only via explicit redactAuthHeaders:false (undefined still redacts)', () => {
      assert.strictEqual(redactHeaders({ Authorization: 'x' }, undefined).Authorization, '[redacted len=1]');
      assert.strictEqual(redactHeaders({ Authorization: 'x' }, {}).Authorization, '[redacted len=1]');
      assert.strictEqual(redactHeaders({ Authorization: 'x' }, { redactAuthHeaders: false }).Authorization, 'x');
    });
  });
}

describe('emit-site wiring', () => {
  for (const rel of [CHROME, FIREFOX]) {
    it(`${rel}: every headers emit is wrapped in redactHeaders`, () => {
      const src = read(rel);
      // No bare `headers: <var>,` at an emit — all must go through redactHeaders.
      const bare = [...src.matchAll(/headers: (?!redactHeaders)(\w+)[,)]/g)].map(m => m[0]);
      assert.deepStrictEqual(bare, [],
        `unwrapped headers emit(s) — a raw header would be cached: ${bare.join(' | ')}`);
      // And it is actually applied at least the expected number of times (2 req + 2 res).
      assert.ok((src.match(/redactHeaders\(/g) || []).length >= 5,
        'expected redactHeaders at the definition + 4 emit sites');
    });
  }
});

describe('config default + server wiring', () => {
  it('committed config.json keeps network.redactAuthHeaders = true', () => {
    const cfg = JSON.parse(read('config.json'));
    assert.strictEqual(cfg.network?.redactAuthHeaders, true);
  });

  it('the public-default guard pins it', () => {
    assert.match(read('scripts/_check-config-defaults.js'), /network\.redactAuthHeaders/);
  });

  it('index.js forwards redactAuthHeaders into the SW network options', () => {
    assert.match(read('server/index.js'), /redactAuthHeaders: _cfg\.network\?\.redactAuthHeaders !== false/);
  });
});
