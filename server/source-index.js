/**
 * server/source-index.js
 *
 * Source upload & on-demand slicing (slice 1 of the source-upload feature — see
 * docs/ideas/SOURCE_UPLOAD_CORRELATION.md). Stores user-uploaded source per
 * project and serves only the *relevant slice* on request, so the agent gets lean
 * context instead of whole files.
 *
 * Slice 1 is correlation-free: store files + list them + return a focused excerpt
 * (around a line, an explicit range, or a capped whole file). Symbol search is a
 * cheap heuristic here; real component↔source correlation is slice 2.
 *
 * Node-light by design: plain text in memory, optional JSON-ish persistence.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_DIR        = path.join(__dirname, '..', 'cache', 'uploaded-source');
const MAX_FILE_BYTES     = 256 * 1024;      // skip a single huge file
const MAX_TOTAL_BYTES    = 32 * 1024 * 1024; // per-project cap
const DEFAULT_SLICE_LINES = 400;            // keep served context lean
const SKIP_RE = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage)(\/|$)|\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|mp4|zip|gz|pdf|lock)$/i;

const LANG_BY_EXT = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', vue: 'vue', svelte: 'svelte',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', php: 'php',
  css: 'css', scss: 'scss', html: 'html', json: 'json', md: 'markdown',
};

function langOf(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  return LANG_BY_EXT[ext] || 'text';
}

function createSourceIndex(opts = {}) {
  const dir     = opts.dir || DEFAULT_DIR;
  const persist = opts.persist !== false;

  /** @type {Map<string, Map<string, string>>} projectId → (relPath → content) */
  const projects = new Map();

  function _projDir(projectId) {
    return path.join(dir, String(projectId).replace(/[^A-Za-z0-9_.-]/g, '_'));
  }

  /**
   * Add/replace a project's files. `files` is { relPath: content }. Skips
   * binaries / node_modules / oversize, enforces a per-project byte cap.
   * Returns { projectId, added, skipped, totalBytes }.
   */
  function addFiles(projectId, files) {
    const map = projects.get(projectId) || new Map();
    let added = 0, skipped = 0, totalBytes = [...map.values()].reduce((s, c) => s + c.length, 0);

    for (const [rawPath, content] of Object.entries(files || {})) {
      const rel = String(rawPath).replace(/\\/g, '/').replace(/^\.?\//, '');
      if (typeof content !== 'string' || SKIP_RE.test(rel)) { skipped++; continue; }
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_FILE_BYTES || totalBytes + bytes > MAX_TOTAL_BYTES) { skipped++; continue; }
      map.set(rel, content);
      added++; totalBytes += bytes;
    }
    projects.set(projectId, map);
    if (persist) _save(projectId, map);
    return { projectId, added, skipped, files: map.size, totalBytes };
  }

  function _save(projectId, map) {
    try {
      const pdir = _projDir(projectId);
      for (const [rel, content] of map) {
        const fp = path.join(pdir, rel);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content);
      }
    } catch (_) { /* best-effort persistence */ }
  }

  function listProjects() { return [...projects.keys()]; }

  function listFiles(projectId) {
    const map = projects.get(projectId);
    if (!map) return [];
    return [...map.entries()].map(([p, c]) => ({
      path: p, language: langOf(p), bytes: Buffer.byteLength(c, 'utf8'), lines: c.split('\n').length,
    })).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Return a focused slice of a file. opts: { line, around } (excerpt around a
   * line), or { from, to } (1-based inclusive range), or neither (capped whole
   * file). Caps at maxLines. Returns null if the file is unknown.
   */
  function getSlice(projectId, file, opts = {}) {
    const map = projects.get(projectId);
    if (!map) return null;
    const rel = String(file).replace(/\\/g, '/').replace(/^\.?\//, '');
    const content = map.get(rel);
    if (content == null) return null;

    const allLines = content.split('\n');
    const total = allLines.length;
    const maxLines = opts.maxLines || DEFAULT_SLICE_LINES;

    let from, to;
    if (typeof opts.line === 'number') {
      const around = opts.around != null ? opts.around : 30;
      from = Math.max(1, opts.line - around);
      to   = Math.min(total, opts.line + around);
    } else if (typeof opts.from === 'number' || typeof opts.to === 'number') {
      from = Math.max(1, opts.from || 1);
      to   = Math.min(total, opts.to || total);
    } else {
      from = 1; to = Math.min(total, maxLines);
    }
    if (to - from + 1 > maxLines) to = from + maxLines - 1;

    return {
      file: rel,
      language: langOf(rel),
      lines: [from, to],
      totalLines: total,
      truncated: to < total || from > 1,
      excerpt: allLines.slice(from - 1, to).join('\n'),
    };
  }

  /**
   * Cheap symbol search (slice-1 heuristic): files whose text declares `name`
   * (export/function/class/const). Real resolution is slice 2.
   */
  function findSymbol(projectId, name) {
    const map = projects.get(projectId);
    if (!map || !name) return [];
    const safe = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b(function|class|const|let|var|def|interface|type|export\\s+default)\\b[^\\n]*\\b' + safe + '\\b');
    const hits = [];
    for (const [p, c] of map) {
      const lines = c.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { hits.push({ path: p, line: i + 1, language: langOf(p) }); break; }
      }
    }
    return hits;
  }

  return { addFiles, listProjects, listFiles, getSlice, findSymbol, _dir: dir };
}

/**
 * Resolve a source-context query against an index. Shared by the MCP tool
 * (standalone) and the /api/source/context endpoint (proxy mode).
 *   { symbol }        → slice the single declaring file, or the list of matches
 *   { file, line/... }→ slice that file
 *   (neither)         → list the project's files
 */
function queryContext(index, q = {}) {
  const projectId = q.projectId || index.listProjects()[0];
  if (!projectId) return { error: 'No uploaded source. POST files to /api/source/upload first.' };

  if (q.symbol) {
    const hits = index.findSymbol(projectId, q.symbol);
    if (hits.length === 1) {
      const sl = index.getSlice(projectId, hits[0].path, { line: hits[0].line, around: q.around });
      return { projectId, matchedSymbol: q.symbol, ...sl };
    }
    return {
      projectId, symbol: q.symbol, matches: hits,
      _note: hits.length ? 'Multiple declarations — pass one as `file` to slice it.' : 'No declaration found in the uploaded source.',
    };
  }
  if (q.file) {
    const sl = index.getSlice(projectId, q.file, q);
    return sl || { error: `No file "${q.file}" in project "${projectId}".` };
  }
  return { projectId, files: index.listFiles(projectId) };
}

module.exports = { createSourceIndex, queryContext, langOf };
