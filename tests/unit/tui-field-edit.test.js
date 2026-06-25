/**
 * tests/unit/tui-field-edit.test.js
 *
 * Exercises the field-edit overlay's pure helpers (server/tui/app.js):
 * detectFields() locates the editable JSON values (empty placeholders AND
 * already-filled string/number values, minus the structural type/tabId keys)
 * inside a real action-catalog command template, substituteFields() splices
 * typed values back in, and stepNumber() does the numeric ±step (G). The
 * interactive parts (→/← triggers, Tab/Enter/Ctrl-Alt+↑↓ stepping through
 * fields) live in the raw-mode key loop and aren't unit-tested here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseCatalog, expandCatalog } = require('../../server/cli-shell');
const { detectFields, substituteFields, stepNumber } = require('../../server/tui/app');

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
    assert.strictEqual(fields[0].value, 'https://');
    assert.strictEqual(fields[0].type, 'string');
  });

  it('prefills an already-filled string value (press_key key=Enter)', () => {
    const entry = actionEntry('press_key');
    const fields = detectFields(entry.text);
    assert.deepStrictEqual(fields.map(f => f.key), ['key']);
    assert.strictEqual(fields[0].value, 'Enter');
    assert.strictEqual(entry.text.slice(fields[0].start, fields[0].end), 'Enter');
  });

  it('detects a numeric value with type=number (scroll deltaY)', () => {
    const entry = actionEntry('scroll');
    const fields = detectFields(entry.text);
    assert.deepStrictEqual(fields.map(f => f.key), ['deltaY']);
    assert.strictEqual(fields[0].type, 'number');
    assert.strictEqual(fields[0].value, '500');
    assert.strictEqual(entry.text.slice(fields[0].start, fields[0].end), '500');
  });

  it('skips the structural type/tabId keys (go_back has neither param)', () => {
    const entry = actionEntry('go_back');
    assert.deepStrictEqual(detectFields(entry.text), []);
  });
});

describe('substituteFields (numbers)', () => {
  it('splices a numeric value back unquoted', () => {
    const entry = actionEntry('scroll');
    const fields = detectFields(entry.text);
    const out = substituteFields(entry.text, fields, ['-250']);
    assert.ok(out.includes('"deltaY":-250'), out);
    assert.ok(JSON.parse(out.replace(/^POST \/api\/action /, '')), 'result stays valid JSON');
  });

  it('keeps the original number when the field is left blank', () => {
    const entry = actionEntry('scroll');
    const fields = detectFields(entry.text);
    const out = substituteFields(entry.text, fields, ['']);
    assert.ok(out.includes('"deltaY":500'));
  });
});

describe('stepNumber', () => {
  it('steps integers up and down', () => {
    assert.strictEqual(stepNumber('500', 10), '510');
    assert.strictEqual(stepNumber('500', -1), '499');
  });
  it('can cross zero into negatives', () => {
    assert.strictEqual(stepNumber('5', -10), '-5');
  });
  it('avoids float drift on decimal steps', () => {
    assert.strictEqual(stepNumber('0.2', 0.1), '0.3');
  });
  it('leaves a non-numeric value untouched', () => {
    assert.strictEqual(stepNumber('abc', 1), 'abc');
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
