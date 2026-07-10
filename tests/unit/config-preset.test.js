/**
 * tests/unit/config-preset.test.js
 *
 * `whk config preset` — the enumerated developer-capability preset
 * (server/config-presets.js). The design promise under test:
 *   - operator values always win (preset only fills gaps; --force is explicit)
 *   - every preset path targets a REAL key of the committed config.json
 *     (a renamed config key must break here, not silently no-op at runtime)
 *   - the preset never touches protections (privacy.*) or exposure-shaped
 *     settings — capability unlocks only
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PRESETS, applyPreset, getPath } = require('../../server/config-presets');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const publicDefaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

describe('applyPreset semantics', () => {
  it('fills missing keys and reports them as set', () => {
    const { config, actions } = applyPreset({}, 'dev');
    assert.ok(actions.length >= 5);
    assert.ok(actions.every(a => a.action === 'set'));
    assert.strictEqual(getPath(config, 'security.allowExecuteJs'), true);
    assert.strictEqual(getPath(config, 'dev.exec.enabled'), true);
  });

  it('keeps operator values (theirs win), unless --force', () => {
    const mine = { agentControl: { input: { highFidelity: 'always' } } };
    const { config, actions } = applyPreset(mine, 'dev');
    assert.strictEqual(getPath(config, 'agentControl.input.highFidelity'), 'always');
    const kept = actions.find(a => a.path === 'agentControl.input.highFidelity');
    assert.strictEqual(kept.action, 'kept');
    assert.strictEqual(kept.current, 'always');

    const forced = applyPreset(mine, 'dev', { force: true });
    assert.strictEqual(getPath(forced.config, 'agentControl.input.highFidelity'), 'fallback');
  });

  it('does not mutate the input object and preserves unrelated keys', () => {
    const mine = { identity: { name: 'my-instance' } };
    const { config } = applyPreset(mine, 'dev');
    assert.strictEqual(getPath(config, 'identity.name'), 'my-instance');
    assert.strictEqual(getPath(mine, 'security.allowExecuteJs'), undefined, 'input must not be mutated');
  });

  it('rejects unknown preset names', () => {
    assert.throws(() => applyPreset({}, 'nope'), /unknown preset/);
  });
});

describe('dev preset contents', () => {
  it('every preset path exists in the committed config.json defaults', () => {
    const missing = PRESETS.dev
      .map(p => p.path)
      .filter(p => getPath(publicDefaults, p) === undefined);
    assert.deepStrictEqual(missing, [],
      `preset paths no longer exist in config.json (renamed key?): ${missing.join(', ')}`);
  });

  it('capability unlocks only — no protections, no exposure', () => {
    for (const { path: p } of PRESETS.dev) {
      assert.ok(!p.startsWith('privacy.'), `preset must not touch protections: ${p}`);
      assert.ok(!p.startsWith('appIsolation'), `preset must not touch isolation: ${p}`);
      assert.ok(!/port|host|listen/i.test(p), `preset must not touch network exposure: ${p}`);
    }
  });

  it('every entry carries a why (printed to the operator on apply)', () => {
    for (const e of PRESETS.dev) {
      assert.ok(typeof e.why === 'string' && e.why.length > 0, `${e.path}: missing why`);
    }
  });
});

describe('wiring pins', () => {
  it('cli.js dispatches whk config and documents the preset in help', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/cli.js'), 'utf8');
    assert.match(src, /command === 'CONFIG'/);
    assert.match(src, /config preset dev/);
  });

  it('config.local.json.example mirrors the dev preset keys', () => {
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json.example'), 'utf8'));
    const missing = PRESETS.dev
      .map(p => p.path)
      .filter(p => getPath(example, p) === undefined);
    assert.deepStrictEqual(missing, [],
      `example file drifted from the preset: ${missing.join(', ')}`);
  });
});
