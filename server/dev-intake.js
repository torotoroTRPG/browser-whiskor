/**
 * server/dev-intake.js
 *
 * Artifact intake: the static gate every exec must pass before injection.
 * (docs/vision/whiskor-for-dev/dev-exec.md SECTION 3.1 / 4.1, D-1)
 *
 * The execution unit is a self-contained ES module (dependencies already
 * bundled). Bare imports ("react") and relative imports ("./util.js") are
 * rejected here — a blob URL has no base URL, so relative resolution is
 * impossible, and bare specifiers need an import map. Owning either would mean
 * re-implementing a bundler (N-3). The boundary is cut at the *shape of the
 * artifact*: resolving imports is the job of whoever builds it (esbuild / vite /
 * tsc --bundle), which is why this is language/toolchain independent.
 *
 * E1 handles the `inline` intake path only. `file` (fileRoots) and `push`
 * (/api/dev/artifact + LRU) intake are E2 and layer on top of validate()/hash().
 */
'use strict';

const crypto = require('crypto');
const fs   = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB (dev.exec.maxArtifactBytes)

// Static import/export specifier extraction. We only need string-literal
// specifiers — a dynamic import() with a computed expression is the artifact's
// own runtime logic, not an unresolved build-time dependency, so it is left
// alone. Three shapes cover the literal cases:
//   import x from '...' / import '...' / export ... from '...'
//   import('...')
const RE_FROM        = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
const RE_SIDE_EFFECT = /\bimport\s*['"]([^'"]+)['"]/g;
const RE_DYNAMIC     = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const RE_SCHEME = /^[a-z][a-z0-9+.-]*:/i; // http: https: data: blob: node: …

/**
 * Classify a module specifier.
 *   'relative' — starts with ./ or ../   (no base URL under a blob → reject)
 *   'bare'     — no scheme, not absolute-URL (needs an import map → reject)
 *   'url'      — has a scheme (http:, data:, blob:, …) → allowed (self-resolving)
 */
function classifySpecifier(spec) {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') return 'relative';
  if (RE_SCHEME.test(spec)) return 'url';
  return 'bare'; // includes root-relative "/foo" which also has no blob base URL
}

function collectSpecifiers(code) {
  const found = [];
  for (const re of [RE_FROM, RE_SIDE_EFFECT, RE_DYNAMIC]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      if (m[1]) found.push(m[1]);
    }
  }
  return found;
}

/**
 * Validate an inline artifact and compute its identity.
 *
 * @returns on success { ok:true, hash, bytes }
 *          on rejection { ok:false, blocked:<code>, error, hint?, hash, bytes }
 *          where blocked ∈ 'unresolved_import' | 'artifact_too_large' | 'empty_artifact'
 */
function validateArtifact(code, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : DEFAULT_MAX_BYTES;

  if (typeof code !== 'string' || code.trim() === '') {
    return { ok: false, blocked: 'empty_artifact', error: 'Artifact code is empty.' };
  }

  const bytes = Buffer.byteLength(code, 'utf8');
  const hash = sha256(code);

  if (bytes > maxBytes) {
    return {
      ok: false, blocked: 'artifact_too_large', hash, bytes,
      error: `Artifact is ${bytes} bytes, over the ${maxBytes}-byte limit (dev.exec.maxArtifactBytes).`,
    };
  }

  const offenders = [];
  for (const spec of collectSpecifiers(code)) {
    const kind = classifySpecifier(spec);
    if (kind === 'relative' || kind === 'bare') offenders.push({ spec, kind });
  }
  if (offenders.length) {
    const list = offenders.map(o => `${o.spec} (${o.kind})`).join(', ');
    return {
      ok: false, blocked: 'unresolved_import', hash, bytes,
      error: `Artifact has unresolved import specifier(s): ${list}. dev-exec runs a self-contained ES module — it does not resolve imports.`,
      hint: 'Bundle first, e.g. `esbuild your.js --bundle --format=esm --outfile=dist/your.js`, then pass the built file.',
    };
  }

  return { ok: true, hash, bytes };
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// ── file intake (E2) ──────────────────────────────────────────────────────────
// Resolve a requested file path and confine it to the declared project roots.
// (dev-exec.md SECTION 4.1 file-path confinement, threat T-2/T-5)
//
// The path must land INSIDE one of fileRoots after realpath resolution — realpath
// on both sides defeats symlink escape ("root/link → /etc/passwd"). An empty
// fileRoots means the file path does not exist as a feature: without this, "run
// arbitrary JS" silently widens into "read any file, then run it".
//
// @returns { ok:true, absPath, code } | { ok:false, blocked, error }
function resolveFilePath(p, fileRoots) {
  if (typeof p !== 'string' || !p) {
    return { ok: false, blocked: 'path_outside_roots', error: 'No file path given.' };
  }
  const roots = Array.isArray(fileRoots) ? fileRoots.filter(r => typeof r === 'string' && r) : [];
  if (roots.length === 0) {
    return { ok: false, blocked: 'path_outside_roots',
      error: 'file intake is disabled: dev.exec.fileRoots is empty. Declare a project root in config.local.json to run files.' };
  }

  let real;
  try { real = fs.realpathSync(path.resolve(p)); }
  catch { return { ok: false, blocked: 'file_not_found', error: `File not found (or unreadable): ${p}` }; }

  const inside = roots.some(root => {
    let rr;
    try { rr = fs.realpathSync(path.resolve(root)); }
    catch { return false; } // a non-existent root can confine nothing
    const withSep = rr.endsWith(path.sep) ? rr : rr + path.sep;
    return real === rr || real.startsWith(withSep);
  });
  if (!inside) {
    return { ok: false, blocked: 'path_outside_roots',
      error: `Path is outside the allowed dev roots: ${p}` };
  }

  let code;
  try { code = fs.readFileSync(real, 'utf8'); }
  catch (e) { return { ok: false, blocked: 'file_not_found', error: `Cannot read file: ${e.message}` }; }
  return { ok: true, absPath: real, code };
}

module.exports = {
  validateArtifact,
  classifySpecifier,
  collectSpecifiers,
  resolveFilePath,
  sha256,
  DEFAULT_MAX_BYTES,
};
