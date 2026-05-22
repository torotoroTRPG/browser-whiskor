/**
 * server/state-persistence.js
 *
 * Disk I/O for state graphs: gzip persistence and snapshot storage.
 * Extracted from state-store.js to reduce file size.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Configuration ─────────────────────────────────────────────────────────────

const GRAPH_DIR = path.join(__dirname, '..', 'cache', 'graphs');
fs.mkdirSync(GRAPH_DIR, { recursive: true });

const SNAPSHOTS_DIR = path.join(GRAPH_DIR, 'snapshots');
fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

// ── Persistence (gzip) ───────────────────────────────────────────────────────

function persistGraph(siteVersion, graphs) {
  const g = graphs.get(siteVersion);
  if (!g) return;
  g.updatedAt = Date.now();
  const fp = path.join(GRAPH_DIR, `${siteVersion}.json.gz`);
  try {
    const data = JSON.stringify(g, null, 0);
    const compressed = zlib.gzipSync(Buffer.from(data, 'utf8'), { level: 6 });
    fs.writeFileSync(fp, compressed);
  } catch (_) {}
}

function loadGraph(siteVersion) {
  const fp = path.join(GRAPH_DIR, `${siteVersion}.json.gz`);
  if (!fs.existsSync(fp)) return null;
  try {
    const compressed = fs.readFileSync(fp);
    const data = zlib.gunzipSync(compressed).toString('utf8');
    return JSON.parse(data);
  } catch {
    // Fallback: try uncompressed
    const fp2 = path.join(GRAPH_DIR, `${siteVersion}.json`);
    if (fs.existsSync(fp2)) {
      try {
        return JSON.parse(fs.readFileSync(fp2, 'utf8'));
      } catch (_) {}
    }
    return null;
  }
}

// ── Snapshot Storage (L2) ────────────────────────────────────────────────────

function saveSnapshot(siteVersion, hash, snapshot) {
  const dir = path.join(SNAPSHOTS_DIR, siteVersion);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${hash}.snap.json.gz`);

  try {
    const data = JSON.stringify(snapshot, null, 0);
    const compressed = zlib.gzipSync(Buffer.from(data, 'utf8'), { level: 6 });
    fs.writeFileSync(fp, compressed);
    return `${siteVersion}/${hash}.snap.json.gz`;
  } catch {
    return null;
  }
}

function loadSnapshot(siteVersion, hash) {
  const fp = path.join(SNAPSHOTS_DIR, siteVersion, `${hash}.snap.json.gz`);
  if (!fs.existsSync(fp)) return null;
  try {
    const compressed = fs.readFileSync(fp);
    const data = zlib.gunzipSync(compressed).toString('utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

module.exports = {
  persistGraph,
  loadGraph,
  saveSnapshot,
  loadSnapshot,
  GRAPH_DIR,
  SNAPSHOTS_DIR,
};
