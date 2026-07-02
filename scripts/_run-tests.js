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
const os = require('os');
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

// Redirect disk-writing modules to a throwaway temp dir so tests never litter
// the developer's real cache/. screenshot-manager.handleResult writes every
// capture (including the placeholder data URLs unit tests feed it) to disk;
// without this it dumped 1-byte junk into cache/screenshots. Only set it when
// the caller hasn't already chosen a location.
if (!process.env.WHISKOR_SCREENSHOT_DIR) {
  const testShots = path.join(os.tmpdir(), 'whiskor-test-screenshots');
  fs.mkdirSync(testShots, { recursive: true });
  process.env.WHISKOR_SCREENSHOT_DIR = testShots;
}
if (!process.env.WHISKOR_GRAPH_DIR) {
  // state-persistence writes graphs on every addNode/addEdge — keep test
  // graphs out of the developer's cache/graphs for the same reason.
  const testGraphs = path.join(os.tmpdir(), 'whiskor-test-graphs');
  fs.mkdirSync(testGraphs, { recursive: true });
  process.env.WHISKOR_GRAPH_DIR = testGraphs;
}

const res = spawnSync(process.execPath, [...nodeArgs, ...files], { stdio: 'inherit' });
process.exit(res.status == null ? 1 : res.status);
