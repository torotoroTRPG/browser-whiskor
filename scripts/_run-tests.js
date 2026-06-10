/**
 * scripts/_run-tests.js
 *
 * Cross-version test launcher.  `node --test <dir>` stopped accepting bare
 * directories on newer Node (24.x resolves the dir as an entry module and
 * crashes with MODULE_NOT_FOUND), while quoted glob patterns are only
 * understood from Node 21.  Expanding directories to an explicit *.test.js
 * file list works on every version, so the npm scripts go through here.
 *
 * Usage: node scripts/_run-tests.js [--coverage] <dir> [<dir> ...]
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const nodeArgs = ['--test'];
if (args[0] === '--coverage') {
  nodeArgs.push('--experimental-test-coverage');
  args.shift();
}

const files = [];
for (const dir of args) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    console.error(`[run-tests] cannot read directory: ${dir} (${err.code})`);
    process.exit(1);
  }
  for (const f of entries) {
    if (/\.test\.(js|mjs|cjs)$/.test(f)) files.push(path.join(dir, f));
  }
}

if (!files.length) {
  console.error(`[run-tests] no *.test.js files found under: ${args.join(', ')}`);
  process.exit(1);
}

const res = spawnSync(process.execPath, [...nodeArgs, ...files], { stdio: 'inherit' });
process.exit(res.status == null ? 1 : res.status);
