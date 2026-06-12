'use strict';
/**
 * server/tui/scrollback.js — output pane buffer for the whk TUI (zero-dependency)
 *
 * Holds plain-text logical lines, wraps them to the pane width on demand, and
 * tracks a scroll offset measured in wrapped rows from the bottom (0 = follow
 * tail). Lines are stored plain; the app colorizes each wrapped segment at
 * render time so ANSI codes never get sheared by wrapping.
 */

const { wrapToWidth } = require('./term');

class Scrollback {
  constructor(capacity = 5000) {
    this.capacity = capacity;
    this.lines = [];      // [{ text, kind }] — kind drives colorizing at render
    this.offset = 0;      // wrapped-row offset from the bottom; 0 = tail
  }

  /** Push text (may contain \n); kind: 'json' | 'info' | 'warn' | 'error' | 'cmd' | 'plain' */
  push(text, kind = 'plain') {
    for (const line of String(text).split('\n')) {
      this.lines.push({ text: line, kind });
    }
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity);
    }
    // New output snaps the view back to the tail — matches every terminal.
    this.offset = 0;
  }

  clear() {
    this.lines = [];
    this.offset = 0;
  }

  /** All wrapped rows for a width: [{ text, kind }] */
  wrappedRows(width) {
    const rows = [];
    for (const l of this.lines) {
      for (const seg of wrapToWidth(l.text, width)) {
        rows.push({ text: seg, kind: l.kind });
      }
    }
    return rows;
  }

  /**
   * The rows visible in a pane of height×width, honoring the scroll offset.
   * Returns { rows, atTail, total }.
   */
  view(height, width) {
    const all = this.wrappedRows(width);
    const maxOffset = Math.max(0, all.length - height);
    if (this.offset > maxOffset) this.offset = maxOffset;
    const end = all.length - this.offset;
    return {
      rows: all.slice(Math.max(0, end - height), end),
      atTail: this.offset === 0,
      total: all.length,
    };
  }

  scrollUp(n, height, width) {
    const max = Math.max(0, this.wrappedRows(width).length - height);
    this.offset = Math.min(max, this.offset + n);
  }

  scrollDown(n) {
    this.offset = Math.max(0, this.offset - n);
  }

  scrollToTail() { this.offset = 0; }
}

module.exports = { Scrollback };
