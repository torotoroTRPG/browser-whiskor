/**
 * tests/unit/tui-modules.test.js
 *
 * Exercises the REAL whk-shell TUI building blocks (server/tui/*): East-Asian
 * display width, the line editor, the wrapping scrollback, JSON highlighting,
 * and input-line windowing. These are the pure parts — the raw-mode key loop
 * is interactive and covered by the non-TTY REPL smoke instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const term = require('../../server/tui/term');
const { LineEditor } = require('../../server/tui/editor');
const { Scrollback } = require('../../server/tui/scrollback');
const { highlightJsonLine } = require('../../server/tui/highlight');
const { visibleSlice } = require('../../server/tui/app');

describe('tui/term — display width (CJK-aware)', () => {
  it('counts CJK as 2 columns, ASCII as 1, ANSI as 0', () => {
    assert.strictEqual(term.strWidth('abc'), 3);
    assert.strictEqual(term.strWidth('セッション'), 10);
    assert.strictEqual(term.strWidth('WHISKOR — ツール'), 7 + 1 + 1 + 1 + 6); // ascii7 + sp + emdash + sp + CJK6
    assert.strictEqual(term.strWidth('\x1b[32mok\x1b[0m'), 2);
  });

  it('truncates by display width, not code units', () => {
    // 'ツール' is 6 columns; cutting at 5 must not produce a 6-column result
    const t = term.truncateToWidth('ツール', 5);
    assert.ok(term.strWidth(t) <= 5);
    assert.ok(t.endsWith('…'));
    assert.strictEqual(term.truncateToWidth('abc', 10), 'abc');
  });

  it('pads to an exact display width', () => {
    assert.strictEqual(term.strWidth(term.padToWidth('日本語', 10)), 10);
    assert.strictEqual(term.padToWidth('ab', 4), 'ab  ');
  });

  it('wraps mixed-width text without overflowing any segment', () => {
    const segs = term.wrapToWidth('aあbいcうdえeお', 4);
    assert.ok(segs.every(s => term.strWidth(s) <= 4));
    assert.strictEqual(segs.join(''), 'aあbいcうdえeお');
  });

  it('stripAnsi removes escape sequences', () => {
    assert.strictEqual(term.stripAnsi('\x1b[7m sel \x1b[0m'), ' sel ');
  });
});

describe('tui/term — SGR mouse parsing', () => {
  it('decodes wheel events (buttons 64/65) with coordinates', () => {
    const ev = term.parseSgrMouse('\x1b[<64;10;5M');
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].wheel, 'up');
    assert.deepStrictEqual([ev[0].col, ev[0].row, ev[0].press], [10, 5, true]);
    assert.strictEqual(term.parseSgrMouse('\x1b[<65;1;1M')[0].wheel, 'down');
  });

  it('handles bursts (multiple events per chunk) and ignores non-mouse data', () => {
    const ev = term.parseSgrMouse('\x1b[<64;1;1M\x1b[<64;1;1Mplain\x1b[<0;3;4m');
    assert.strictEqual(ev.length, 3);
    assert.strictEqual(ev[2].wheel, null, 'button 0 is a click, not a wheel');
    assert.strictEqual(ev[2].press, false, "trailing 'm' is a release");
    assert.deepStrictEqual(term.parseSgrMouse('just text'), []);
  });
});

describe('tui/term — mouse input filtering (the "wheel types garbage" bug)', () => {
  it('stripSgrMouse removes mouse sequences entirely, keeping real input', () => {
    // readline cannot parse these; unfiltered, "64;12;5M" lands in the editor.
    assert.strictEqual(term.stripSgrMouse('\x1b[<64;12;5M'), '');
    assert.strictEqual(term.stripSgrMouse('ab\x1b[<65;1;1Mcd\x1b[<0;3;4m'), 'abcd');
    assert.strictEqual(term.stripSgrMouse('\x1b[A'), '\x1b[A', 'arrow keys must pass through');
  });

  it('splitTrailingEscape holds back partial sequences at a chunk boundary', () => {
    assert.deepStrictEqual(term.splitTrailingEscape('abc\x1b[<64;1'),
      { body: 'abc', partial: '\x1b[<64;1' });
    assert.deepStrictEqual(term.splitTrailingEscape('x\x1b'),
      { body: 'x', partial: '\x1b' });
    assert.deepStrictEqual(term.splitTrailingEscape('\x1b['),
      { body: '', partial: '\x1b[' });
  });

  it('complete sequences and plain text are not held back', () => {
    assert.deepStrictEqual(term.splitTrailingEscape('\x1b[<64;12;5M'),
      { body: '\x1b[<64;12;5M', partial: '' });
    assert.deepStrictEqual(term.splitTrailingEscape('\x1b[A'),
      { body: '\x1b[A', partial: '' });
    assert.deepStrictEqual(term.splitTrailingEscape('hello'),
      { body: 'hello', partial: '' });
  });

  it('rejoined chunks reconstruct the original event', () => {
    const a = term.splitTrailingEscape('GET \x1b[<64;1');
    const rejoined = a.partial + ';5M';
    assert.strictEqual(a.body, 'GET ');
    assert.strictEqual(term.parseSgrMouse(rejoined)[0].wheel, 'up');
    assert.strictEqual(term.stripSgrMouse(rejoined), '');
  });
});

describe('tui/editor — line editing', () => {
  it('inserts mid-line at the cursor', () => {
    const e = new LineEditor('GET /helth');
    e.left(); e.left(); e.left();   // cursor before 'l'... position between 'he' and 'lth'
    e.insert('a');
    assert.strictEqual(e.text, 'GET /health');
  });

  it('backspace/del respect the cursor and report success', () => {
    const e = new LineEditor('abc');
    e.home();
    assert.strictEqual(e.backspace(), false, 'backspace at column 0 is a no-op');
    assert.strictEqual(e.del(), true);
    assert.strictEqual(e.text, 'bc');
  });

  it('word jumps treat URL path characters as word characters', () => {
    const e = new LineEditor('GET /api/sessions');
    e.wordLeft();
    assert.strictEqual(e.cursor, 4, 'jump to the start of the path token');
    e.wordLeft();
    assert.strictEqual(e.cursor, 0);
    e.wordRight();
    assert.strictEqual(e.cursor, 3);
  });

  it('kill commands: to-end, word-left, whole line', () => {
    const e = new LineEditor('POST /api/collect body');
    e.wordLeft(); e.killToEnd();
    assert.strictEqual(e.text, 'POST /api/collect ');
    e.killWordLeft();
    assert.strictEqual(e.text, 'POST ');
    e.killLine();
    assert.strictEqual(e.text, '');
    assert.strictEqual(e.cursor, 0);
  });

  it('handles astral/CJK code points as single characters', () => {
    const e = new LineEditor('日本語');
    e.left();
    e.backspace();
    assert.strictEqual(e.text, '日語');
  });
});

describe('tui/scrollback — wrapping + scrolling', () => {
  it('splits multi-line pushes and wraps to width', () => {
    const sb = new Scrollback();
    sb.push('line1\nline2-which-is-long', 'plain');
    const v = sb.view(10, 10);
    assert.ok(v.rows.length >= 3, 'long line must wrap into extra rows');
    assert.ok(v.rows.every(r => term.strWidth(r.text) <= 10));
  });

  it('view shows the tail by default; scrollUp moves back; new output snaps to tail', () => {
    const sb = new Scrollback();
    for (let i = 1; i <= 20; i++) sb.push(`row${i}`);
    let v = sb.view(5, 80);
    assert.strictEqual(v.rows[4].text, 'row20');
    assert.ok(v.atTail);

    sb.scrollUp(5, 5, 80);
    v = sb.view(5, 80);
    assert.strictEqual(v.rows[4].text, 'row15');
    assert.ok(!v.atTail);

    sb.push('row21');
    v = sb.view(5, 80);
    assert.strictEqual(v.rows[4].text, 'row21', 'new output must snap back to tail');
  });

  it('caps the buffer at capacity', () => {
    const sb = new Scrollback(10);
    for (let i = 0; i < 50; i++) sb.push(`x${i}`);
    assert.strictEqual(sb.lines.length, 10);
    assert.strictEqual(sb.lines[9].text, 'x49');
  });

  it('scroll offset clamps to the available rows', () => {
    const sb = new Scrollback();
    sb.push('only');
    sb.scrollUp(99, 5, 80);
    assert.strictEqual(sb.view(5, 80).rows[0].text, 'only');
  });
});

describe('tui/highlight — JSON coloring', () => {
  it('colors keys, strings, numbers, literals; text survives stripping', () => {
    const line = '  "ok": true, "n": 42, "s": "hi",';
    const colored = highlightJsonLine(line);
    assert.notStrictEqual(colored, line, 'something must be colored');
    assert.strictEqual(term.stripAnsi(colored), line, 'coloring must not alter the text');
  });

  it('emits no ANSI that spans beyond the line (always reset-safe)', () => {
    const colored = highlightJsonLine('{"a": 1}');
    assert.ok(!colored.endsWith('\x1b['), 'no dangling escape');
  });
});

describe('tui/app — input-line windowing', () => {
  it('keeps the cursor visible when the line exceeds the available width', () => {
    const chars = Array.from('GET /api/sessions/1666857199/raw/delta/smart.json');
    const { text, cursorCol } = visibleSlice(chars, chars.length, 20);
    assert.ok(term.strWidth(text) <= 20);
    assert.ok(cursorCol <= 20);
    assert.ok(text.endsWith('smart.json'), 'window must follow the cursor at end-of-line');
  });

  it('windows around a mid-line cursor with CJK content', () => {
    const chars = Array.from('あいうえおかきくけこさしすせそ');
    const { text, cursorCol } = visibleSlice(chars, 7, 10);
    assert.ok(term.strWidth(text) <= 10);
    assert.ok(cursorCol < 10);
  });

  it('zero width never throws', () => {
    assert.deepStrictEqual(visibleSlice(['a'], 0, 0), { text: '', cursorCol: 0 });
  });
});
