/**
 * tests/unit/cli-shell-escape.test.js
 *
 * The `!cmd` escape hatch (server/cli-shell.js): runShellEscape() runs a line in
 * the user's local host shell (pwsh on Windows, $SHELL on POSIX) and buffers the
 * output; shellOutputLines() normalises/caps it for display. Local-only — never
 * wired to HTTP/MCP, so this is just the runner contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runShellEscape, shellOutputLines } = require('../../server/cli-shell');

describe('runShellEscape', () => {
  it('runs a command and captures stdout with exit 0', async () => {
    const r = await runShellEscape('echo whiskor_escape_ok');
    assert.ok(!r.failed, `expected a shell to spawn: ${r.error || ''}`);
    assert.strictEqual(r.code, 0);
    assert.ok(String(r.out).includes('whiskor_escape_ok'), `stdout was: ${JSON.stringify(r.out)}`);
    assert.ok(r.shell, 'reports which shell ran');
  });

  it('reports a non-zero exit code without throwing', async () => {
    const r = await runShellEscape('exit 3');
    assert.ok(!r.failed);
    assert.strictEqual(r.code, 3);
  });
});

describe('shellOutputLines', () => {
  it('normalises CRLF/CR and drops a trailing blank line', () => {
    assert.deepStrictEqual(shellOutputLines('a\r\nb\rc\n'), { lines: ['a', 'b', 'c'], extra: 0 });
  });
  it('caps the line count and reports the remainder', () => {
    const text = Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n');
    const out = shellOutputLines(text, 4);
    assert.deepStrictEqual(out.lines, ['L0', 'L1', 'L2', 'L3']);
    assert.strictEqual(out.extra, 6);
  });
  it('returns nothing for empty/blank input', () => {
    assert.deepStrictEqual(shellOutputLines(''), { lines: [], extra: 0 });
  });
});
