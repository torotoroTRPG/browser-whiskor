/**
 * tests/unit/tui-field-edit.test.js
 *
 * Exercises the field-edit overlay's pure helpers (server/tui/app.js):
 * detectFields() locates the `""` / `"https://"` placeholders inside a real
 * action-catalog command template, and substituteFields() splices typed
 * values back in. The interactive parts (→/← triggers, Tab/Enter stepping
 * through fields) live in the raw-mode key loop and aren't unit-tested here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseCatalog, expandCatalog } = require('../../server/cli-shell');
const { detectFields, substituteFields } = require('../../server/tui/app');

function actionEntry(typeName) {
  const cat = expandCatalog(baseCatalog(), [], []);
  const entry = cat.find(c => c.cat === 'action' && c.text.includes(`"type":"${typeName}"`));
  assert.ok(entry, `expected an action entry for type "${typeName}"`);
  return entry;
}

describe('detectFields', () => {
  it('finds one empty-string placeholder (click by selector)', () => {
    const click = expandCatalog(baseCatalog(), [], [])
      .filter(c => c.cat === 'action' && c.text.includes('"type":"click"'))
      .find(c => c.text.includes('"selector"'));
    const fields = detectFields(click.text);
    assert.deepStrictEqual(fields.map(f => f.key), ['selector']);
    assert.strictEqual(click.text.slice(fields[0].start, fields[0].end), '');
  });

  it('finds multiple placeholders in order (type into an input)', () => {
    const entry = actionEntry('type');
    const fields = detectFields(entry.text);
    assert.deepStrictEqual(fields.map(f => f.key), ['selector', 'text']);
    for (const f of fields) assert.strictEqual(entry.text.slice(f.start, f.end), '');
  });

  it('treats "https://" as a placeholder (navigate url)', () => {
    const entry = actionEntry('navigate');
    const fields = detectFields(entry.text);
    assert.deepStrictEqual(fields.map(f => f.key), ['url']);
    assert.strictEqual(entry.text.slice(fields[0].start, fields[0].end), 'https://');
    assert.strictEqual(fields[0].placeholder, 'https://');
  });

  it('does not flag a real default value (press_key key=Enter)', () => {
    const entry = actionEntry('press_key');
    assert.deepStrictEqual(detectFields(entry.text), []);
  });

  it('returns nothing for commands with no string placeholders', () => {
    const entry = actionEntry('go_back');
    assert.deepStrictEqual(detectFields(entry.text), []);
  });
});

describe('substituteFields', () => {
  it('splices values into multiple placeholders left-to-right', () => {
    const entry = actionEntry('type');
    const fields = detectFields(entry.text);
    const out = substituteFields(entry.text, fields, ['#email', 'me@example.com']);
    assert.ok(out.includes('"selector":"#email"'));
    assert.ok(out.includes('"text":"me@example.com"'));
    assert.ok(out.includes('"clear":true'), 'rest of the template is untouched');
  });

  it('leaves a blank value as the original placeholder', () => {
    const entry = actionEntry('type');
    const fields = detectFields(entry.text);
    const out = substituteFields(entry.text, fields, ['#email', '']);
    assert.ok(out.includes('"selector":"#email"'));
    assert.ok(out.includes('"text":""'), 'blank field keeps its empty placeholder');
  });

  it('replaces the "https://" placeholder with a full URL', () => {
    const entry = actionEntry('navigate');
    const fields = detectFields(entry.text);
    const out = substituteFields(entry.text, fields, ['https://example.com/login']);
    assert.ok(out.includes('"url":"https://example.com/login"'));
  });

  it('JSON-escapes quotes and backslashes in typed values', () => {
    const entry = actionEntry('click');
    const click = expandCatalog(baseCatalog(), [], [])
      .filter(c => c.cat === 'action' && c.text.includes('"type":"click"'))
      .find(c => c.text.includes('"selector"'));
    const fields = detectFields(click.text);
    const out = substituteFields(click.text, fields, ['div[data-x="a\\b"]']);
    assert.ok(out.includes('"selector":"div[data-x=\\"a\\\\b\\"]"'));
    assert.ok(JSON.parse(out.replace(/^POST \/api\/action /, '')), 'result stays valid JSON');
  });
});
