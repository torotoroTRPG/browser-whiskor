#!/usr/bin/env node
/**
 * renumber-comments.js
 * Increments `// NN.` comment numbers in a file within a line range.
 *
 * Usage:
 *   node scripts/renumber-comments.js <file> <fromLine> <toLine> [increment]
 *
 * Example:
 *   node scripts/renumber-comments.js server/mcp/tools/write.js 62 408 1
 *     → Increments all "// NN." comments from line 62 to 408 by 1
 *
 * Pattern matched: lines starting with "// " followed by digits and a dot
 *   e.g. "// 20. click" → "// 21. click"
 */
'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const fromLine = parseInt(process.argv[3], 10);
const toLine = parseInt(process.argv[4], 10);
const increment = parseInt(process.argv[5], 10) || 1;

if (!file || isNaN(fromLine) || isNaN(toLine)) {
  console.error('Usage: node renumber-comments.js <file> <fromLine> <toLine> [increment]');
  process.exit(1);
}

const filePath = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);
const lines = fs.readFileSync(filePath, 'utf8').split('\n');

let count = 0;
for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
  lines[i] = lines[i].replace(/^(\s*\/\/\s*)(\d+)(\.\s)/, (match, prefix, num, suffix) => {
    count++;
    return prefix + (parseInt(num, 10) + increment) + suffix;
  });
}

fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
console.log(`Renumbered ${count} comments in ${file} (lines ${fromLine}-${toLine}, +${increment})`);
