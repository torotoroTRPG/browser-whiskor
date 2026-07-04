/**
 * tests/unit/dev-exec.test.js
 *
 * Exercises the REAL dev-exec E1 modules — dev-gate (mode state machine + TTL +
 * origin check), dev-intake (artifact static gate + hash), dev-audit (audit
 * before ack), and the tool-manager absence principle for dev profiles. No inline
 * re-implementation. See docs/vision/whiskor-for-dev/dev-exec.md invariants.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// dev-audit reads WHISKOR_CACHE_DIR at load — point it at a throwaway dir first.
const TMP_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'whiskor-dev-audit-'));
process.env.WHISKOR_CACHE_DIR = TMP_CACHE;

const devGate     = require('../../server/dev-gate');
const devIntake   = require('../../server/dev-intake');
const devAudit    = require('../../server/dev-audit');
const devArtifacts = require('../../server/dev-artifacts');
const devVerdict  = require('../../server/dev-verdict');
const toolManager = require('../../server/tool-manager');

// ── dev-gate ──────────────────────────────────────────────────────────────────
describe('dev-gate: activation policy (I-2 operator-gated, D-3 not-config)', () => {
  beforeEach(() => devGate._resetForTest());

  test('activate is refused while policy is disabled (dev.exec.enabled=false)', () => {
    devGate.setPolicy({ exec: { enabled: false } });
    const r = devGate.activate({});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(devGate.isActive(), false);
  });

  test('activate works once policy is enabled, and status reflects it', () => {
    devGate.setPolicy({ exec: { enabled: true } });
    const r = devGate.activate({});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(devGate.isActive(), true);
    const s = devGate.status();
    assert.strictEqual(s.active, true);
    assert.ok(s.expiresAt > Date.now());
  });

  test('deactivate turns it off (idempotent)', () => {
    devGate.setPolicy({ exec: { enabled: true } });
    devGate.activate({});
    assert.strictEqual(devGate.deactivate('operator').wasActive, true);
    assert.strictEqual(devGate.isActive(), false);
    assert.strictEqual(devGate.deactivate('operator').wasActive, false);
  });
});

describe('dev-gate: TTL (一時 — auto-expire, I-7)', () => {
  beforeEach(() => devGate._resetForTest());

  test('requested TTL is clamped to maxTtlMs', () => {
    devGate.setPolicy({ exec: { enabled: true }, mode: { maxTtlMs: 1000 } });
    const r = devGate.activate({ ttlMs: 999999 });
    assert.ok(r.remainingMs <= 1000);
  });

  test('mode auto-expires after the TTL elapses', async () => {
    devGate.setPolicy({ exec: { enabled: true } });
    devGate.activate({ ttlMs: 25 });
    assert.strictEqual(devGate.isActive(), true);
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(devGate.isActive(), false, 'must be inactive after TTL');
  });
});

describe('dev-gate: origin allow-list (I-5 helper)', () => {
  beforeEach(() => {
    devGate._resetForTest();
    devGate.setPolicy({ exec: { enabled: true, allowedOrigins: ['http://localhost', 'http://127.0.0.1'] } });
  });

  test('localhost on any port is allowed', () => {
    assert.strictEqual(devGate.originAllowed('http://localhost:3000'), true);
    assert.strictEqual(devGate.originAllowed('http://127.0.0.1:8080'), true);
  });

  test('a foreign host is rejected', () => {
    assert.strictEqual(devGate.originAllowed('http://evil.example.com'), false);
  });

  test('protocol mismatch is rejected (http allow-list vs https origin)', () => {
    assert.strictEqual(devGate.originAllowed('https://localhost:3000'), false);
  });
});

describe('dev-gate: change listeners (可視 — badge broadcast)', () => {
  beforeEach(() => devGate._resetForTest());

  test('onChange fires on activate and deactivate', () => {
    devGate.setPolicy({ exec: { enabled: true } });
    const seen = [];
    const off = devGate.onChange((snap) => seen.push(snap.active));
    devGate.activate({});
    devGate.deactivate('operator');
    off();
    assert.deepStrictEqual(seen, [true, false]);
  });
});

// ── dev-intake ────────────────────────────────────────────────────────────────
describe('dev-intake: artifact static gate (D-1, SECTION 3.1)', () => {
  test('rejects a bare import specifier', () => {
    const r = devIntake.validateArtifact("import x from 'react';\nexport default 1;");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocked, 'unresolved_import');
  });

  test('rejects a relative import specifier', () => {
    const r = devIntake.validateArtifact("import { a } from './util.js';\nexport default a;");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocked, 'unresolved_import');
  });

  test('accepts a self-contained module and hashes it deterministically', () => {
    const code = 'const total = 1 + 2;\nexport default total;';
    const r = devIntake.validateArtifact(code);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.hash, devIntake.sha256(code));
    assert.strictEqual(r.bytes, Buffer.byteLength(code, 'utf8'));
  });

  test('rejects an oversize artifact', () => {
    const big = 'x'.repeat(50);
    const r = devIntake.validateArtifact(big, { maxBytes: 10 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocked, 'artifact_too_large');
  });

  test('rejects empty code', () => {
    assert.strictEqual(devIntake.validateArtifact('   ').blocked, 'empty_artifact');
  });

  test('a full-URL import is allowed (self-resolving), bare/relative are not', () => {
    assert.strictEqual(devIntake.classifySpecifier('https://cdn/x.js'), 'url');
    assert.strictEqual(devIntake.classifySpecifier('react'), 'bare');
    assert.strictEqual(devIntake.classifySpecifier('./x.js'), 'relative');
  });
});

// ── dev-audit ─────────────────────────────────────────────────────────────────
describe('dev-audit: audit-before-ack (I-3, I-4)', () => {
  test('appended record carries identity fields but never the artifact body', () => {
    const tabId = 4242;
    const ok = devAudit.appendAudit(tabId, {
      execId: 'e1', artifactHash: 'abc123', initiator: 'agent',
      backend: 'blob', mode: 'probe', bytes: 42, verdict: 'pending',
    });
    assert.strictEqual(ok, true);
    const recs = devAudit.readAudit(tabId);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].artifactHash, 'abc123');
    assert.strictEqual(recs[0].initiator, 'agent');
    assert.ok(recs[0].ts > 0);
    // I-4: no code/body field is ever written.
    assert.strictEqual(recs[0].code, undefined);
    assert.strictEqual(recs[0].value, undefined);
  });
});

// ── dev-intake: file confinement (E2, T-2/T-5) ────────────────────────────────
describe('dev-intake: file intake confinement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whiskor-dev-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whiskor-dev-out-'));
  const inFile = path.join(root, 'built.js');
  const outFile = path.join(outside, 'secret.js');
  fs.writeFileSync(inFile, 'export default 42;');
  fs.writeFileSync(outFile, 'export default 1;');

  test('empty fileRoots means file intake does not exist', () => {
    const r = devIntake.resolveFilePath(inFile, []);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocked, 'path_outside_roots');
  });

  test('a file inside a root resolves and is read', () => {
    const r = devIntake.resolveFilePath(inFile, [root]);
    assert.strictEqual(r.ok, true);
    assert.match(r.code, /export default 42/);
  });

  test('a file outside every root is blocked', () => {
    const r = devIntake.resolveFilePath(outFile, [root]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocked, 'path_outside_roots');
  });

  test('a missing file is reported, not silently allowed', () => {
    const r = devIntake.resolveFilePath(path.join(root, 'nope.js'), [root]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocked, 'file_not_found');
  });
});

// ── dev-artifacts: push LRU (E2, I-4) ─────────────────────────────────────────
describe('dev-artifacts: push-intake LRU store', () => {
  beforeEach(() => { devArtifacts.clear(); devArtifacts.setMax(32); });

  test('add returns a stable id for identical content and get round-trips', () => {
    const a = devArtifacts.add('probe.js', 'export default 1;');
    const b = devArtifacts.add('probe.js', 'export default 1;');
    assert.strictEqual(a.artifactId, b.artifactId, 'same bytes → same id');
    const got = devArtifacts.get(a.artifactId);
    assert.strictEqual(got.code, 'export default 1;');
    assert.strictEqual(got.name, 'probe.js');
  });

  test('LRU evicts the oldest past the cap', () => {
    devArtifacts.setMax(2);
    const a = devArtifacts.add('a', 'export default "a";');
    devArtifacts.add('b', 'export default "b";');
    devArtifacts.add('c', 'export default "c";'); // evicts a
    assert.strictEqual(devArtifacts.get(a.artifactId), null, 'oldest must be evicted');
    assert.strictEqual(devArtifacts.count(), 2);
  });
});

// ── dev-verdict: 5-value mapping + evidence (E3, SECTION 5.3) ──────────────────
describe('dev-verdict: buildVerdict mapping', () => {
  const H0 = 'aaaa1111', H1 = 'bbbb2222';

  test('clean: ran, no errors, nothing changed', () => {
    const r = devVerdict.buildVerdict({ outcome: 'ok',
      baseline: { stateHash: H0, url: 'http://x/' },
      observed: { stateHash: H0, url: 'http://x/', mutations: 0, uncaughtErrors: [], navigated: false },
      consoleLogs: [], mode: 'probe' });
    assert.strictEqual(r.verdict, 'clean');
    assert.strictEqual(r.evidence.stateTransition, null);
    assert.deepStrictEqual(r.evidence.flags, []);
  });

  test('effect: state hash moved with no errors', () => {
    const r = devVerdict.buildVerdict({ outcome: 'ok',
      baseline: { stateHash: H0, url: 'http://x/' },
      observed: { stateHash: H1, url: 'http://x/', mutations: 12, uncaughtErrors: [], navigated: false },
      consoleLogs: [], mode: 'probe' });
    assert.strictEqual(r.verdict, 'effect');
    assert.ok(r.evidence.stateTransition, 'transition recorded');
    assert.strictEqual(r.evidence.stateTransition.to, H1);
  });

  test('effect: DOM mutated even when hash unavailable', () => {
    const r = devVerdict.buildVerdict({ outcome: 'ok',
      baseline: { stateHash: null }, observed: { stateHash: null, mutations: 3, uncaughtErrors: [], navigated: false },
      consoleLogs: [], mode: 'probe' });
    assert.strictEqual(r.verdict, 'effect');
  });

  test('regressed: a new console error', () => {
    const r = devVerdict.buildVerdict({ outcome: 'ok',
      baseline: { stateHash: H0 }, observed: { stateHash: H0, mutations: 0, uncaughtErrors: [], navigated: false },
      consoleLogs: [{ level: 'error', args: ['boom'] }], mode: 'probe' });
    assert.strictEqual(r.verdict, 'regressed');
    assert.strictEqual(r.evidence.consoleNew.length, 1);
  });

  test('regressed: an uncaught exception during the window', () => {
    const r = devVerdict.buildVerdict({ outcome: 'ok',
      baseline: { stateHash: H0 },
      observed: { stateHash: H0, mutations: 0, uncaughtErrors: [{ kind: 'error', message: 'x' }], navigated: false },
      consoleLogs: [], mode: 'probe' });
    assert.strictEqual(r.verdict, 'regressed');
  });

  test('regressed: the module itself threw (outcome error)', () => {
    const r = devVerdict.buildVerdict({ outcome: 'error', consoleLogs: [], mode: 'probe' });
    assert.strictEqual(r.verdict, 'regressed');
  });

  test('regressed: a harness case failed', () => {
    const r = devVerdict.buildVerdict({ outcome: 'ok', mode: 'harness',
      baseline: { stateHash: H0 }, observed: { stateHash: H0, mutations: 0, uncaughtErrors: [], navigated: false },
      consoleLogs: [], value: { total: 2, passed: 1, failed: 1 } });
    assert.strictEqual(r.verdict, 'regressed');
  });

  test('blocked: page-side outcome blocked (csp/origin)', () => {
    const r = devVerdict.buildVerdict({ outcome: 'blocked', consoleLogs: [] });
    assert.strictEqual(r.verdict, 'blocked');
  });

  test('inconclusive: timeout', () => {
    const r = devVerdict.buildVerdict({ outcome: 'timeout', consoleLogs: [] });
    assert.strictEqual(r.verdict, 'inconclusive');
  });

  test('inconclusive: tab navigated mid-exec (even with no errors)', () => {
    const r = devVerdict.buildVerdict({ outcome: 'ok',
      baseline: { stateHash: H0, url: 'http://x/' },
      observed: { stateHash: H1, url: 'http://y/', mutations: 5, uncaughtErrors: [], navigated: true },
      consoleLogs: [], mode: 'probe' });
    assert.strictEqual(r.verdict, 'inconclusive');
    assert.ok(r.evidence.flags.includes('tab_navigated'));
  });

  test('settled_at_cap flag surfaces in evidence', () => {
    const r = devVerdict.buildVerdict({ outcome: 'ok',
      baseline: { stateHash: H0 }, observed: { stateHash: H0, mutations: 0, uncaughtErrors: [], navigated: false, settledAtCap: true },
      consoleLogs: [], mode: 'probe' });
    assert.ok(r.evidence.flags.includes('settled_at_cap'));
  });
});

describe('dev-verdict: persistence (5.5)', () => {
  test('appendVerdict writes a line and caps the file', () => {
    const tabId = 'vtest-' + Date.now();
    for (let i = 0; i < 30; i++) {
      devVerdict.appendVerdict(tabId, { execId: 'e' + i, verdict: 'clean', evidence: {} }, 10);
    }
    const rows = devVerdict.readVerdicts(tabId, 1000);
    assert.ok(rows.length <= 12, `cap ~10 (×1.2 slack) but got ${rows.length}`);
    assert.ok(rows.length >= 10, 'keeps at least the cap');
    assert.strictEqual(rows[rows.length - 1].execId, 'e29', 'newest retained');
  });
});

// ── tool-manager: dev profile absence principle (I-1, 7.3) ─────────────────────
describe('tool-manager: dev profile is absent unless dev mode is active (I-1)', () => {
  // Minimal allTools covering the names the profiles reference.
  const names = ['exec_module', 'dev_status', 'get_sessions', 'click', 'search_tools'];
  const allTools = names.map(n => ({ definition: { name: n } }));
  const cfg = {};

  beforeEach(() => {
    toolManager.resetAll();
    toolManager.initSession('s');
  });

  test('dev tools are hidden while dev mode is off', () => {
    toolManager.setDevModeChecker(() => false);
    const visible = toolManager.getVisibleTools('s', allTools, cfg).map(t => t.definition.name);
    assert.ok(!visible.includes('exec_module'), 'exec_module must be absent when dev mode off');
  });

  test('dev tools appear the moment dev mode is on', () => {
    toolManager.setDevModeChecker(() => true);
    const visible = toolManager.getVisibleTools('s', allTools, cfg).map(t => t.definition.name);
    assert.ok(visible.includes('exec_module'), 'exec_module must be visible when dev mode on');
    assert.ok(visible.includes('dev_status'));
  });

  test('the dev profile cannot be loaded via load_profile', () => {
    toolManager.setDevModeChecker(() => false);
    const r = toolManager.loadProfile('s', 'dev', allTools, cfg);
    assert.strictEqual(r.success, false);
  });

  test('ensureToolVisible reports dev_mode_inactive when off, visible when on', () => {
    toolManager.setDevModeChecker(() => false);
    const off = toolManager.ensureToolVisible('s', 'exec_module', allTools, cfg);
    assert.strictEqual(off.visible, false);
    assert.strictEqual(off.reason, 'dev_mode_inactive');

    toolManager.setDevModeChecker(() => true);
    const on = toolManager.ensureToolVisible('s', 'exec_module', allTools, cfg);
    assert.strictEqual(on.visible, true);
  });

  test('profile_status does not advertise the dev profile while inactive', () => {
    toolManager.setDevModeChecker(() => false);
    const st = toolManager.getProfileStatus('s');
    assert.ok(!st.available.some(p => p.name === 'dev'), 'dev must not appear in available when off');
  });
});
