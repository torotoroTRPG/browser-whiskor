'use strict';
// Public-default guard for config.json.
//
// config.json is the published baseline that ships to every user. A few keys are
// security-sensitive: if a personal/local value (e.g. allowExecuteJs:true) is
// accidentally committed, the shipped default silently weakens. Personal values
// belong in the git-ignored config.local.json (deep-merged at startup by
// server/config-loader.js), never in the committed config.json.
//
// This guard asserts the committed config.json still carries the safe public
// default for each listed path. It reads the file as text-stripped JSON (the
// _comment_* fields are valid JSON, so a plain parse is fine).
//
//   node scripts/_check-config-defaults.js   → verify (exit 1 on drift)
//
// Run from the repo root. CI runs this in ci.yml's verify-sync job.

const fs = require('fs');

// path → required public default. Keep this list to genuinely security-sensitive
// keys; it is not meant to pin every default.
const REQUIRED = [
  { path: 'security.allowExecuteJs', expected: false,
    why: 'arbitrary JS execution must be opt-in for shipped users' },
  { path: 'agentControl.screenshot.httpInlineImage', expected: true,
    why: 'HTTP screenshot inline-image default is the documented baseline' },
  { path: 'dev.exec.enabled', expected: false,
    why: 'dev-exec (live arbitrary code execution) must be opt-in — enable it in config.local.json' },
  { path: 'agentControl.console.captureAllWorlds', expected: false,
    why: 'all-worlds console capture reads OTHER extensions\' logs and holds a debugger attachment — must be opt-in' },
  { path: 'network.redactAuthHeaders', expected: true,
    why: 'credential header redaction must stay ON by default — turning it off leaks Authorization/Cookie into cache and /export' },
];

// Paths that must be an EMPTY array in the shipped config (a personal value here
// silently widens the shipped attack surface). Checked separately from scalars.
const REQUIRED_EMPTY_ARRAY = [
  { path: 'dev.exec.fileRoots',
    why: 'dev-exec file/watch roots are personal — a committed root exposes local files; put them in config.local.json' },
];

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

let config;
try {
  config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
} catch (e) {
  console.error('FAIL: cannot read/parse config.json:', e.message);
  process.exit(1);
}

const drift = [];
for (const { path: p, expected, why } of REQUIRED) {
  const actual = get(config, p);
  if (actual !== expected) {
    drift.push(`  ${p}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)} — ${why}`);
  }
}
for (const { path: p, why } of REQUIRED_EMPTY_ARRAY) {
  const actual = get(config, p);
  if (!Array.isArray(actual) || actual.length !== 0) {
    drift.push(`  ${p}: expected [] (empty), found ${JSON.stringify(actual)} — ${why}`);
  }
}

if (drift.length) {
  console.error('FAIL: config.json has drifted from its public defaults:');
  console.error(drift.join('\n'));
  console.error('\nPersonal overrides belong in the git-ignored config.local.json, not config.json.');
  process.exit(1);
}

console.log(`OK: config.json public defaults intact (${REQUIRED.length + REQUIRED_EMPTY_ARRAY.length} key(s) checked)`);
