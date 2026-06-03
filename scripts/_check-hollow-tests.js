'use strict';
// Hollow-test guard.
//
// A unit test under tests/unit/ is only worth running if it actually loads the
// production code it claims to cover. Several suites here used to assert on
// inline re-implementations ("toy" classes/functions) or literal mocks and never
// imported anything from server/ — so they stayed green no matter how broken the
// real code was, and one even masked a live bug (config-change-log recursion).
//
// This guard fails CI if a tests/unit/*.test.js file does not reach real code,
// either by importing it directly (../../server, ../../shared, ../../extension,
// ../../firefox-mv2) or through a helper that boots it (helpers/server-fixture,
// which runs the real WhiskorCore).
//
//   node scripts/_check-hollow-tests.js     → verify (exit 1 on violation)
//
// Escape hatch: a genuinely self-contained test (e.g. one that exercises a pure
// in-file utility on purpose) may opt out with a comment naming the reason:
//   // @allow-no-prod-import: <why this test needs no production import>
//
// Run from the repo root.

const fs   = require('fs');
const path = require('path');

const DIR = path.join('tests', 'unit');

// Importing one of these means the test reaches real, shippable code.
const REACHES_PROD = [
  /\.\.\/\.\.\/server\b/,
  /\.\.\/\.\.\/shared\b/,
  /\.\.\/\.\.\/extension\b/,
  /\.\.\/\.\.\/firefox-mv2\b/,
  // Helpers that themselves boot/import production code:
  /helpers\/server-fixture/,
];
const OPT_OUT = /@allow-no-prod-import\s*:/;

let files;
try {
  files = fs.readdirSync(DIR).filter(f => f.endsWith('.test.js'));
} catch (e) {
  console.error(`FAIL: cannot read ${DIR}: ${e.message}`);
  process.exit(1);
}

const hollow = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  if (OPT_OUT.test(src)) continue;
  if (!REACHES_PROD.some(re => re.test(src))) hollow.push(f);
}

if (hollow.length) {
  console.error(`FAIL: ${hollow.length} unit test(s) never import production code (hollow):`);
  for (const f of hollow) console.error(`  - tests/unit/${f}`);
  console.error('');
  console.error('A unit test must load the real module it covers (../../server/...) or a');
  console.error('helper that boots it (helpers/server-fixture). If a test is intentionally');
  console.error('self-contained, annotate it: // @allow-no-prod-import: <reason>.');
  process.exit(1);
}

console.log(`ok  ${files.length} unit test file(s) reach production code`);
