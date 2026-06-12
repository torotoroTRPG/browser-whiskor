'use strict';
/**
 * server/tui/term.js — terminal primitives for the whk TUI (zero-dependency)
 *
 * ANSI escape helpers + display-width handling. Width awareness matters here:
 * session titles and URLs are routinely Japanese (CJK = 2 columns), and naive
 * `.length` truncation shears the layout apart.
 */

// ── ANSI ──────────────────────────────────────────────────────────────────────

const ESC = '\x1b[';

const ansi = {
  altScreenOn:  ESC + '?1049h',
  altScreenOff: ESC + '?1049l',
  // SGR mouse reporting (1000 = button presses, 1006 = SGR encoding). Needed
  // because the terminal's own wheel/scrollbar never scrolls an alt-screen
  // app — wheel events must be delivered to us instead. (Text selection then
  // needs Shift held — the standard TUI trade-off.)
  mouseOn:      ESC + '?1000h' + ESC + '?1006h',
  mouseOff:     ESC + '?1006l' + ESC + '?1000l',
  hideCursor:   ESC + '?25l',
  showCursor:   ESC + '?25h',
  clearScreen:  ESC + '2J',
  clearLine:    ESC + '2K',
  clearDown:    ESC + 'J',
  reset:        ESC + '0m',
  moveTo: (row, col) => `${ESC}${row};${col}H`, // 1-based
  // SGR shorthands
  bold:    (s) => `${ESC}1m${s}${ESC}22m`,
  dim:     (s) => `${ESC}2m${s}${ESC}22m`,
  inverse: (s) => `${ESC}7m${s}${ESC}27m`,
  fg: {
    red:     (s) => `${ESC}31m${s}${ESC}39m`,
    green:   (s) => `${ESC}32m${s}${ESC}39m`,
    yellow:  (s) => `${ESC}33m${s}${ESC}39m`,
    blue:    (s) => `${ESC}34m${s}${ESC}39m`,
    magenta: (s) => `${ESC}35m${s}${ESC}39m`,
    cyan:    (s) => `${ESC}36m${s}${ESC}39m`,
    gray:    (s) => `${ESC}90m${s}${ESC}39m`,
  },
};

const ANSI_RE = /\x1b\[[0-9;?<]*[a-zA-Z]/g;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

// ── SGR mouse event parsing ───────────────────────────────────────────────────

const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Remove every complete SGR mouse sequence from a chunk. */
function stripSgrMouse(data) {
  return String(data).replace(SGR_MOUSE_RE, '');
}

/**
 * Split a trailing partial escape sequence off a chunk so it can be glued to
 * the next chunk (sequences can split across stdin reads). `partial` is '' or
 * one of: '\x1b', '\x1b[', '\x1b[<digits;...' (an unterminated mouse prefix).
 */
function splitTrailingEscape(s) {
  const m = String(s).match(/\x1b(\[(<[0-9;]*)?)?$/);
  if (!m || !m[0]) return { body: String(s), partial: '' };
  return { body: String(s).slice(0, s.length - m[0].length), partial: m[0] };
}

/**
 * Extract SGR mouse events from a raw stdin chunk. Wheel events report as
 * button 64 (up) / 65 (down) on press. Coordinates are 1-based.
 */
function parseSgrMouse(data) {
  const events = [];
  for (const m of String(data).matchAll(SGR_MOUSE_RE)) {
    const button = parseInt(m[1], 10);
    events.push({
      button,
      col: parseInt(m[2], 10),
      row: parseInt(m[3], 10),
      press: m[4] === 'M',
      wheel: button === 64 ? 'up' : button === 65 ? 'down' : null,
    });
  }
  return events;
}

// ── Display width (wcwidth-lite) ──────────────────────────────────────────────

/** True if the code point renders 2 columns wide (East Asian Wide/Fullwidth). */
function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100  && cp <= 0x115F)  || // Hangul Jamo
    (cp >= 0x2E80  && cp <= 0x303E)  || // CJK radicals, punctuation
    (cp >= 0x3041  && cp <= 0x33FF)  || // Hiragana..CJK compat
    (cp >= 0x3400  && cp <= 0x4DBF)  || // CJK ext A
    (cp >= 0x4E00  && cp <= 0x9FFF)  || // CJK unified
    (cp >= 0xA000  && cp <= 0xA4CF)  || // Yi
    (cp >= 0xAC00  && cp <= 0xD7A3)  || // Hangul syllables
    (cp >= 0xF900  && cp <= 0xFAFF)  || // CJK compat ideographs
    (cp >= 0xFE30  && cp <= 0xFE4F)  || // CJK compat forms
    (cp >= 0xFF00  && cp <= 0xFF60)  || // Fullwidth forms
    (cp >= 0xFFE0  && cp <= 0xFFE6)  ||
    (cp >= 0x1F300 && cp <= 0x1FAFF) || // emoji & symbols
    (cp >= 0x20000 && cp <= 0x3FFFD)    // CJK ext B+
  );
}

/** True for zero-width code points (combining marks, ZWJ, variation selectors). */
function isZeroWidthCodePoint(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036F) ||
    (cp >= 0x200B && cp <= 0x200F) ||
    (cp >= 0xFE00 && cp <= 0xFE0F) ||
    cp === 0xFEFF
  );
}

function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp == null) return 0;
  if (isZeroWidthCodePoint(cp)) return 0;
  if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) return 0; // control
  return isWideCodePoint(cp) ? 2 : 1;
}

/** Display width of a string (ANSI sequences contribute 0). */
function strWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch);
  return w;
}

/**
 * Truncate plain text to a display width, appending `…` when cut.
 * Input must be ANSI-free (truncating through escape codes corrupts them).
 */
function truncateToWidth(s, maxWidth, ellipsis = '…') {
  if (maxWidth <= 0) return '';
  if (strWidth(s) <= maxWidth) return s;
  const ellW = strWidth(ellipsis);
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > maxWidth - ellW) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/** Pad plain text with spaces up to a display width (truncates if longer). */
function padToWidth(s, width) {
  const t = strWidth(s) > width ? truncateToWidth(s, width) : s;
  return t + ' '.repeat(Math.max(0, width - strWidth(t)));
}

/**
 * Wrap plain text into display-width-limited segments (for the scrollback
 * pane). ANSI-free input; colorize each returned segment independently.
 */
function wrapToWidth(s, width) {
  if (width <= 0) return [s];
  const out = [];
  let cur = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > width) { out.push(cur); cur = ch; w = cw; }
    else { cur += ch; w += cw; }
  }
  out.push(cur);
  return out;
}

module.exports = {
  ansi,
  stripAnsi,
  parseSgrMouse,
  stripSgrMouse,
  splitTrailingEscape,
  charWidth,
  strWidth,
  truncateToWidth,
  padToWidth,
  wrapToWidth,
  isWideCodePoint,
};
