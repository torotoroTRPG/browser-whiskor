/**
 * server/source-correlation.js
 *
 * Runtime → source correlation for the source-upload feature (slice 2 — see
 * docs/ideas/SOURCE_UPLOAD_CORRELATION.md). Maps an observed framework component
 * to the uploaded source file that defines it, preferring an exact runtime
 * debug-source hint (React `_debugSource` fileName/lineNumber, available in dev
 * builds) over a heuristic symbol-name match. Records correlations so repeat
 * lookups are instant and so the agent can list what whiskor has pinned.
 *
 * Pure + injectable: operates on a source-index instance; no I/O of its own.
 */
'use strict';

function _normFile(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.?\//, ''); }

// Does an uploaded path correspond to a (possibly differently-rooted) hint path?
function _samePath(uploaded, hint) {
  const a = _normFile(uploaded), b = _normFile(hint);
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

function createCorrelations() {
  /** @type {Map<string, Map<string, object>>} projectId → (component → record) */
  const byProject = new Map();

  function _bucket(projectId) {
    let m = byProject.get(projectId);
    if (!m) { m = new Map(); byProject.set(projectId, m); }
    return m;
  }

  function record(projectId, component, info) {
    const m = _bucket(projectId);
    const prev = m.get(component);
    const rec = { component, file: info.file, line: info.line || null, confidence: info.confidence, count: (prev?.count || 0) + 1 };
    m.set(component, rec);
    return rec;
  }

  function lookup(projectId, component) {
    return byProject.get(projectId)?.get(component) || null;
  }

  function all(projectId) {
    return [...(byProject.get(projectId)?.values() || [])];
  }

  /**
   * Resolve a component to a source location and record it.
   *   hint: { file, line } from a runtime debug-source (exact when present).
   * Returns { component, file, line, confidence } | { component, matches, confidence:'ambiguous'|'none' }.
   */
  function correlate(projectId, component, sourceIndex, hint = {}) {
    if (!component) return null;

    const known = lookup(projectId, component);
    if (known) { known.count++; return known; }

    // 1) Exact runtime debug-source → match against the uploaded tree.
    if (hint.file && sourceIndex) {
      const match = sourceIndex.listFiles(projectId).map((f) => f.path).find((p) => _samePath(p, hint.file));
      if (match) return record(projectId, component, { file: match, line: hint.line, confidence: 'debug-source' });
    }

    // 2) Heuristic: a single file declares the symbol.
    if (sourceIndex) {
      const hits = sourceIndex.findSymbol(projectId, component);
      if (hits.length === 1) return record(projectId, component, { file: hits[0].path, line: hits[0].line, confidence: 'name-match' });
      if (hits.length > 1) return { component, matches: hits, confidence: 'ambiguous' };
    }
    return { component, matches: [], confidence: 'none' };
  }

  return { record, lookup, all, correlate };
}

module.exports = { createCorrelations };
