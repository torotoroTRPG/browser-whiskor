'use strict';
/**
 * server/tui/highlight.js — JSON line colorizer for the whk TUI (zero-dependency)
 *
 * Token-level regex coloring applied to ONE wrapped segment at a time, so the
 * emitted ANSI never spans rows. A token split across a wrap boundary simply
 * loses its color for that fragment — cosmetic, never corrupting.
 */

const ESC = '\x1b[';
const C = {
  key:    (s) => `${ESC}36m${s}${ESC}39m`, // cyan
  str:    (s) => `${ESC}32m${s}${ESC}39m`, // green
  num:    (s) => `${ESC}33m${s}${ESC}39m`, // yellow
  lit:    (s) => `${ESC}35m${s}${ESC}39m`, // magenta (true/false/null)
  punct:  (s) => `${ESC}90m${s}${ESC}39m`, // gray
};

// "key": | "string" | number | true/false/null | punctuation
const TOKEN_RE = /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

function highlightJsonLine(line) {
  return String(line).replace(TOKEN_RE, (m, key, colon, str, num, lit, punct) => {
    if (key)   return C.key(key) + C.punct(colon);
    if (str)   return C.str(str);
    if (num)   return C.num(num);
    if (lit)   return C.lit(lit);
    if (punct) return C.punct(punct);
    return m;
  });
}

module.exports = { highlightJsonLine };
