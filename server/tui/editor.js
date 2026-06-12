'use strict';
/**
 * server/tui/editor.js — line editor state for the whk TUI (zero-dependency)
 *
 * A real single-line editor: mid-line insert/delete, cursor movement, word
 * jumps, kill commands. Pure state — rendering and key decoding live in the
 * app. Cursor is an index into the code-point array (CJK-safe; display width
 * is the renderer's concern).
 */

const WORD_RE = /[A-Za-z0-9_/.:-]/;

class LineEditor {
  constructor(text = '') {
    this.set(text);
  }

  set(text) {
    this.chars = Array.from(String(text)); // code points, not UTF-16 units
    this.cursor = this.chars.length;
  }

  get text() { return this.chars.join(''); }
  get length() { return this.chars.length; }

  insert(s) {
    const add = Array.from(String(s));
    this.chars.splice(this.cursor, 0, ...add);
    this.cursor += add.length;
  }

  backspace() {
    if (this.cursor === 0) return false;
    this.chars.splice(this.cursor - 1, 1);
    this.cursor--;
    return true;
  }

  del() {
    if (this.cursor >= this.chars.length) return false;
    this.chars.splice(this.cursor, 1);
    return true;
  }

  left()  { if (this.cursor > 0) this.cursor--; }
  right() { if (this.cursor < this.chars.length) this.cursor++; }
  home()  { this.cursor = 0; }
  end()   { this.cursor = this.chars.length; }

  wordLeft() {
    let i = this.cursor;
    while (i > 0 && !WORD_RE.test(this.chars[i - 1])) i--;
    while (i > 0 && WORD_RE.test(this.chars[i - 1])) i--;
    this.cursor = i;
  }

  wordRight() {
    let i = this.cursor;
    const n = this.chars.length;
    while (i < n && !WORD_RE.test(this.chars[i])) i++;
    while (i < n && WORD_RE.test(this.chars[i])) i++;
    this.cursor = i;
  }

  /** Ctrl+K — delete from cursor to end of line. */
  killToEnd() {
    this.chars.length = this.cursor;
  }

  /** Ctrl+U — clear the whole line. */
  killLine() {
    this.chars = [];
    this.cursor = 0;
  }

  /** Ctrl+W — delete the word before the cursor. */
  killWordLeft() {
    const from = this.cursor;
    this.wordLeft();
    this.chars.splice(this.cursor, from - this.cursor);
  }
}

module.exports = { LineEditor };
