'use strict';
// Version consistency guard.
//
// package.json is the single source of truth for the project version. The two
// extension manifests (Chrome MV3 / Firefox MV2) must carry the same version,
// because the release workflow derives the release version from the git tag and
// only *warns* on manifest drift — a silent mismatch ships a mislabelled build.
//
//   node scripts/_check-version.js          → verify (exit 1 on mismatch)
//   node scripts/_check-version.js --fix     → rewrite manifests to match
//
// Only the manifest's own "version" field is touched (the first "version":"…"
// occurrence; "manifest_version" is a distinct key and is left alone). package-
// lock.json is intentionally out of scope — it is owned by npm and stays in sync
// via `npm version`. Run this from the repo root.

const fs = require('fs');

const FIX = process.argv.includes('--fix');
const TARGETS = ['extension/manifest.json', 'firefox-mv2/manifest.json'];
const VERSION_RE = /("version"\s*:\s*")[^"]+(")/;
// docs/version.json is what GitHub Pages serves (main:/docs) and what the
// server's update-checker compares against. Kept in the same guard as the
// manifests so it can never silently drift from package.json.
const PAGES_VERSION_FILE = 'docs/version.json';

const expected = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
if (!expected) {
  console.error('FAIL: package.json has no "version" field');
  process.exit(1);
}

let mismatches = 0;
const fixed = [];

for (const file of TARGETS) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(VERSION_RE);
  if (!m) {
    console.error('FAIL: no "version" field in ' + file);
    process.exit(1);
  }
  const actual = m[0].match(/"([^"]+)"\s*$/)[1];
  if (actual === expected) continue;

  if (FIX) {
    fs.writeFileSync(file, raw.replace(VERSION_RE, `$1${expected}$2`));
    fixed.push(`${file}: ${actual} -> ${expected}`);
  } else {
    console.error(`FAIL: ${file} version "${actual}" != package.json "${expected}"`);
    mismatches++;
  }
}

// Pages version.json — object payload (not a bare string), so update the fields
// rather than a regex replace. Preserves the _comment and any extra keys.
if (fs.existsSync(PAGES_VERSION_FILE)) {
  const raw = fs.readFileSync(PAGES_VERSION_FILE, 'utf8');
  let obj;
  try { obj = JSON.parse(raw); } catch (e) {
    console.error(`FAIL: ${PAGES_VERSION_FILE} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  if (obj.version !== expected || obj.tag !== `v${expected}`) {
    if (FIX) {
      const before = obj.version;
      obj.version = expected;
      obj.tag = `v${expected}`;
      fs.writeFileSync(PAGES_VERSION_FILE, JSON.stringify(obj, null, 2) + '\n');
      fixed.push(`${PAGES_VERSION_FILE}: ${before} -> ${expected}`);
    } else {
      console.error(`FAIL: ${PAGES_VERSION_FILE} version "${obj.version}" != package.json "${expected}"`);
      mismatches++;
    }
  }
}

if (FIX) {
  console.log(fixed.length ? 'fixed  ' + fixed.join('; ') : 'ok  manifests already at ' + expected);
  process.exit(0);
}

if (mismatches > 0) {
  console.error('Run "npm run sync-version" to align manifests with package.json.');
  process.exit(1);
}

console.log('ok  version=' + expected + '  (chrome + firefox manifests match)');
