/**
 * server/state-store.js
 *
 * Replaces state-machine.js with enhanced state graph management.
 * Backward-compatible: state-machine.js re-exports this module.
 *
 * Features:
 *   - Unified composite hash (React-priority + DOM fallback)
 *   - Semantic labels, tags, keyState
 *   - Multi-layer storage (L1 in-memory, L2 disk gzip, L3 eviction)
 *   - Diff storage for repeated visits
 *   - LRU eviction with protected tags
 *   - Hash collision detection
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const fingerprint = require('./state-fingerprint');

const { persistGraph, loadGraph, saveSnapshot, loadSnapshot, GRAPH_DIR } = require('./state-persistence');

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  maxNodesInMemory: 500,
  maxMemoryMB: 50,
  maxDiskMB: 200,
  maxSiteVersions: 10,
  compression: 'gzip',
  useDiffStorage: true,
  diffThresholdBytes: 4096,
  labelMaxLength: 80,
  autoTagging: true,
  protectedTags: ['authenticated'],
  excludeKeys: [],
  excludePatterns: [],
};

// ── In-memory store ──────────────────────────────────────────────────────────

const graphs = new Map(); // siteVersion → StateGraph

/**
 * @typedef {Object} StateNode
 * @property {string} hash
 * @property {string|null} reactHash
 * @property {string} domHash
 * @property {string} hashSource
 * @property {string} url
 * @property {string} pathname
 * @property {string} title
 * @property {string} siteVersion
 * @property {string} label
 * @property {string[]} tags
 * @property {Object} keyState
 * @property {boolean} pinned
 * @property {string|null} pinnedLabel
 * @property {Object|null} uiSummary
 * @property {number} firstSeen
 * @property {number} lastSeen
 * @property {number} visitCount
 * @property {string|null} snapshotRef
 * @property {boolean} hasReactState
 * @property {string|null} routerPath
 * @property {string[]} storeKeys
 */

/**
 * @typedef {Object} StateEdge
 * @property {string} from
 * @property {string|null} to
 * @property {string} action
 * @property {string|null} trigger
 * @property {string|null} selector
 * @property {number} count
 * @property {number} confidence
 * @property {boolean} replayable   false = observation-only, findPath skips it
 * @property {number} firstSeen
 * @property {number} lastSeen
 * @property {Object} replayAction
 */

/**
 * @typedef {Object} StateGraph
 * @property {string} siteVersion
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {Object<string, StateNode>} nodes
 * @property {Object<string, Object<string, StateEdge>>} edges
 * @property {Object<string, string[]>} edgeIndex
 * @property {Object} stats
 */

// ── Graph Management ─────────────────────────────────────────────────────────

function getConfig() {
  try {
    const cfg = require('./config-loader').loadConfig();
    return { ...DEFAULT_CONFIG, ...(cfg.stateGraph || {}) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function getOrCreate(siteVersion) {
  if (!graphs.has(siteVersion)) {
    const g = loadGraph(siteVersion) || {
      siteVersion,
      nodes: {},
      edges: {},
      edgeIndex: {},
      stats: { totalNodes: 0, totalEdges: 0, totalVisits: 0, uniquePaths: 0, snapshotBytes: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    graphs.set(siteVersion, g);
  }
  return graphs.get(siteVersion);
}

function getGraph(siteVersion) {
  return graphs.get(siteVersion) || null;
}

function getAllGraphs() {
  const result = [];
  try {
    for (const f of fs.readdirSync(GRAPH_DIR)) {
      if (f.endsWith('.json') || f.endsWith('.json.gz')) {
        const baseName = f.replace(/\.gz$/, '');
        const sv = baseName.replace('.json', '');
        if (sv === 'index') continue;
        const g = graphs.get(sv) || loadGraph(sv);
        if (g) {
          result.push({
            siteVersion: g.siteVersion,
            nodeCount: Object.keys(g.nodes || {}).length,
            edgeCount: countEdges(g),
            createdAt: g.createdAt,
            updatedAt: g.updatedAt,
          });
        }
      }
    }
  } catch (_) {}
  return result;
}

function countEdges(g) {
  let c = 0;
  for (const from of Object.keys(g.edges || {})) {
    c += Object.keys(g.edges[from]).length;
  }
  return c;
}

/**
 * Startup sweep: drop on-disk graphs whose node table is empty. Before S0
 * (docs/ideas/REVERSE_EDGE_NAVIGATION.md) REACT_TRANSITION wrote edges keyed
 * by react hashes into graphs whose nodes are keyed by composite hashes, so
 * long-running instances accumulated node-less edge skeletons that render
 * nothing and can never be navigated.
 */
function sweepEmptyGraphs() {
  let swept = 0;
  try {
    for (const f of fs.readdirSync(GRAPH_DIR)) {
      if (!f.endsWith('.json') && !f.endsWith('.json.gz')) continue;
      const sv = f.replace(/\.gz$/, '').replace(/\.json$/, '');
      if (sv === 'index') continue;
      const g = graphs.get(sv) || loadGraph(sv);
      if (g && Object.keys(g.nodes || {}).length === 0) {
        try {
          fs.unlinkSync(path.join(GRAPH_DIR, f));
          graphs.delete(sv);
          swept++;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return swept;
}

// ── Origin binding ────────────────────────────────────────────────────────────
// siteVersion is a CLIENT-computed fingerprint carried in the (page-influenced)
// message envelope, so a hostile page could claim ANOTHER site's siteVersion and
// write forged nodes/edges into that site's graph — which navigate_to_state
// would later replay. The one identity a page cannot forge is its own URL: the
// bridge (ISOLATED world) stamps tabUrl on every relayed message. So each graph
// is bound to the origin that first wrote to it; a write claiming the same
// siteVersion from a different origin is rejected. Writers without an origin
// (tests, direct WS clients — nothing page-forged arrives without a bridge
// tabUrl) skip the check and never claim the binding.
function originAllowed(g, origin) {
  if (!origin) return true;
  if (!g.origin) { g.origin = origin; return true; }
  return g.origin === origin;
}

// ── Add Node ─────────────────────────────────────────────────────────────────

function addNode(siteVersion, data) {
  const g = getOrCreate(siteVersion);
  if (!originAllowed(g, data.origin)) {
    console.warn(`[state-store] Rejected node write to graph "${siteVersion}": origin ${data.origin} does not match graph owner ${g.origin}`);
    return null;
  }
  const config = getConfig();
  // NOTE: `hash`/`reactHash` are the CLIENT-computed identity (injected react.js
  // `_hash` + composite, reported via EXPLORER_STATE_UPDATE). They are adopted
  // verbatim as the node key — the server never re-derives a react hash from the
  // raw component tree here. server/state-fingerprint.js (FNV) is a DIFFERENT hash
  // used only for auxiliary fingerprints (store keys, semantic labels), NOT for
  // node identity. Do not start keying nodes with the server FNV: it would not
  // match the client hash and would split one state into duplicate nodes.
  const { hash, reactHash, domHash, url, title, uiCatalog, reactState, domSnapshot } = data;

  // Normalize
  const pathname = url ? new URL(url, 'http://x').pathname : '/';

  // Check for existing node
  if (g.nodes[hash]) {
    const node = g.nodes[hash];
    node.visitCount++;
    node.lastSeen = Date.now();
    if (url && !node.url) node.url = url;
    if (title && !node.title) node.title = title;
    if (reactHash && !node.reactHash) {
      node.reactHash = reactHash;
      node.hashSource = 'react';
    }
    if (uiCatalog && !node.uiSummary) {
      node.uiSummary = buildUiSummary(uiCatalog);
    }
    if (reactState) {
      node.hasReactState = true;
      node.storeKeys = fingerprint.getStoreKeys(reactState);
      node.routerPath = reactState?.router?.location?.pathname || null;
    }
    // Re-evaluate label and tags
    const semantic = require('./state-semantic');
    const labelData = { url: node.url, title: node.title, uiSummary: node.uiSummary, reactState, keyState: node.keyState };
    node.label = semantic.generateLabel(labelData, config);
    node.tags = semantic.extractTags(labelData, config);

    g.stats.totalVisits++;
    persistGraph(siteVersion, graphs);
    return node;
  }

  // Hash collision detection — find unique suffix
  if (g.nodes[hash] && g.nodes[hash].url !== url) {
    let suffix = 2;
    let candidate = `${hash}_${suffix}`;
    while (g.nodes[candidate] && g.nodes[candidate].url !== url) {
      suffix++;
      candidate = `${hash}_${suffix}`;
    }
    console.warn(`[state-store] Hash collision: ${hash} → ${candidate} (url=${url})`);
    return addNode(siteVersion, { ...data, hash: candidate });
  }

  // New node — generate semantic metadata
  const semantic = require('./state-semantic');
  const keyState = reactState ? semantic.extractKeyState(reactState, config) : {};
  const labelData = { url, title, uiSummary: uiCatalog ? buildUiSummary(uiCatalog) : null, reactState, keyState };
  const label = semantic.generateLabel(labelData, config);
  const tags = semantic.extractTags(labelData, config);

  const storeKeys = reactState ? fingerprint.getStoreKeys(reactState) : [];
  const routerPath = reactState?.router?.location?.pathname || null;

  const node = {
    hash,
    reactHash: reactHash || null,
    domHash: domHash || hash,
    hashSource: reactHash ? 'react' : 'dom',
    url: url || null,
    pathname,
    title: title || null,
    siteVersion,
    label,
    tags,
    keyState,
    pinned: false,
    pinnedLabel: null,
    uiSummary: uiCatalog ? buildUiSummary(uiCatalog) : null,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    visitCount: 1,
    snapshotRef: null,
    hasReactState: !!reactState,
    routerPath,
    storeKeys,
  };

  g.nodes[hash] = node;
  g.stats.totalNodes++;
  g.stats.totalVisits++;

  // Save snapshot (L2)
  if (reactState || domSnapshot) {
    node.snapshotRef = saveSnapshot(siteVersion, hash, { reactState, domSnapshot });
  }

  // LRU check
  checkLRU(siteVersion);

  persistGraph(siteVersion, graphs);
  return node;
}

// ── Add Edge ─────────────────────────────────────────────────────────────────

function addEdge(siteVersion, data) {
  const g = getOrCreate(siteVersion);
  if (!originAllowed(g, data.origin)) {
    console.warn(`[state-store] Rejected edge write to graph "${siteVersion}": origin ${data.origin} does not match graph owner ${g.origin}`);
    return null;
  }
  const { from, to, action, trigger, selector, replayAction, replayable } = data;

  if (!g.edges[from]) g.edges[from] = {};
  if (!g.edgeIndex[to]) g.edgeIndex[to] = [];

  const edgeKey = `${action}:${trigger || '?'}`;

  let edge;
  if (g.edges[from][edgeKey]) {
    edge = g.edges[from][edgeKey];
    edge.count++;
    edge.lastSeen = Date.now();
    if (to && edge.to !== to) {
      // Multi-target tracking
      if (!edge.multiTo) edge.multiTo = {};
      const oldTo = edge.to;
      if (oldTo) {
        edge.multiTo[oldTo] = (edge.multiTo[oldTo] || 0) + edge.count - 1;
      }
      edge.multiTo[to] = (edge.multiTo[to] || 0) + 1;
      edge.to = to;
    }
    edge.confidence = computeConfidence(edge);
  } else {
    edge = {
      from,
      to: to || null,
      action,
      trigger: trigger || null,
      selector: selector || null,
      count: 1,
      confidence: 0.4,
      // replayable:false marks observation-only edges (passive transitions
      // with no attributable action) — findPath must skip them. Absent on
      // older persisted edges, so only an explicit false opts out.
      replayable: replayable !== false,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      replayAction: replayAction || { type: action, selector, text: trigger, x: null, y: null, value: null },
    };
    g.edges[from][edgeKey] = edge;
    g.edgeIndex[to]?.push(edgeKey);
    g.stats.totalEdges++;
  }

  persistGraph(siteVersion, graphs);
  return edge;
}

function computeConfidence(edge) {
  const count = edge.count;
  let base = count >= 10 ? 0.95 : count >= 3 ? 0.8 : count >= 2 ? 0.6 : 0.4;

  // Recency
  const ageMs = Date.now() - edge.lastSeen;
  const recency = ageMs < 3600000 ? 1.0 : ageMs < 86400000 ? 0.9 : ageMs < 604800000 ? 0.7 : 0.5;

  // Consistency
  let consistency = 1.0;
  if (edge.multiTo) {
    const total = Object.values(edge.multiTo).reduce((s, v) => s + v, 0);
    const maxCount = Math.max(...Object.values(edge.multiTo));
    consistency = maxCount / total;
  }

  return Math.round(base * recency * consistency * 100) / 100;
}

// ── UI Summary Builder ───────────────────────────────────────────────────────

function buildUiSummary(uiCatalog) {
  if (!uiCatalog) return null;
  return {
    buttonCount: (uiCatalog.buttons || []).length,
    linkCount:   (uiCatalog.links   || []).length,
    inputCount:  (uiCatalog.inputs  || []).length,
    buttons:     (uiCatalog.buttons || []).slice(0, 20).map(b => b.text),
    links:       (uiCatalog.links   || []).slice(0, 20).map(l => l.text),
    inputs:      (uiCatalog.inputs  || []).slice(0, 10).map(i => ({
      name: i.name || i.placeholder || i.label || '',
      type: i.type || 'text',
      required: !!i.required,
    })),
  };
}

// ── LRU Eviction ─────────────────────────────────────────────────────────────

function checkLRU(siteVersion) {
  const config = getConfig();
  const g = graphs.get(siteVersion);
  if (!g) return;

  const nodeCount = Object.keys(g.nodes).length;
  if (nodeCount <= config.maxNodesInMemory) return;

  const protectedTags = new Set(config.protectedTags || []);

  // Sort by lastSeen, excluding pinned and protected
  const candidates = Object.values(g.nodes)
    .filter(n => !n.pinned && !n.tags?.some(t => protectedTags.has(t)))
    .sort((a, b) => a.lastSeen - b.lastSeen);

  const toEvict = candidates.slice(0, Math.ceil(nodeCount * 0.2));

  for (const node of toEvict) {
    // Move to stub
    g.nodes[node.hash] = {
      hash: node.hash,
      label: node.label,
      url: node.url,
      tags: node.tags,
      visitCount: node.visitCount,
      lastSeen: node.lastSeen,
      evicted: true,
    };
  }
}

function restoreEvicted(siteVersion, hash) {
  const g = graphs.get(siteVersion);
  if (!g) return null;
  const node = g.nodes[hash];
  if (!node?.evicted) return node;

  // Full node is in snapshot
  const snapshot = loadSnapshot(siteVersion, hash);
  if (snapshot) {
    // Merge snapshot data back
    g.nodes[hash] = {
      ...node,
      evicted: false,
      hasReactState: !!snapshot.reactState,
      keyState: snapshot.reactState ? require('./state-semantic').extractKeyState(snapshot.reactState, getConfig()) : {},
    };
  }
  return g.nodes[hash];
}

// ── Query Methods ─────────────────────────────────────────────────────────────

function getNodeByHash(siteVersion, hash) {
  const g = getOrCreate(siteVersion);
  let node = g.nodes[hash];
  if (node?.evicted) {
    node = restoreEvicted(siteVersion, hash);
  }
  return node || null;
}

function findGraphContaining(hash) {
  for (const [sv, g] of graphs) {
    if (g.nodes[hash]) return g;
  }
  // Check disk
  try {
    for (const f of fs.readdirSync(GRAPH_DIR)) {
      if (!f.endsWith('.json.gz')) continue;
      const sv = f.replace('.json.gz', '');
      const g = loadGraph(sv);
      if (g?.nodes[hash]) {
        graphs.set(sv, g);
        return g;
      }
    }
  } catch (_) {}
  return null;
}

function getAllNodesFlat(options = {}) {
  const { siteVersion, filter, tags, sortBy = 'lastSeen', limit = 50 } = options;

  const versions = siteVersion ? [siteVersion] : [...graphs.keys()];
  const allNodes = [];

  for (const sv of versions) {
    const g = graphs.get(sv);
    if (!g) continue;
    for (const node of Object.values(g.nodes)) {
      if (node.evicted) continue;
      if (filter && !node.url?.includes(filter)) continue;
      if (tags?.length && !tags.some(t => node.tags?.includes(t))) continue;

      const edges = g.edges[node.hash] || {};
      const inEdges = g.edgeIndex[node.hash] || [];

      allNodes.push({
        hash: node.hash,
        label: node.label,
        url: node.url,
        tags: node.tags || [],
        visitCount: node.visitCount,
        lastSeen: node.lastSeen,
        firstSeen: node.firstSeen,
        hasFullSnapshot: !!node.snapshotRef,
        pinned: node.pinned,
        pinnedLabel: node.pinnedLabel,
        edgeCount: { in: inEdges.length, out: Object.keys(edges).length },
        siteVersion: sv,
      });
    }
  }

  // Sort: pinned first, then by sortBy
  allNodes.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b[sortBy] || 0) - (a[sortBy] || 0);
  });

  return allNodes.slice(0, limit);
}

function getUnvisitedActions(siteVersion, fromHash, uiCatalog) {
  const g = getOrCreate(siteVersion);
  const visited = g.edges[fromHash] || {};
  const visitedTriggers = new Set(Object.values(visited).map(e => e.trigger));

  const candidates = [];
  for (const btn of (uiCatalog?.buttons || [])) {
    if (!btn.disabled && btn.text && !visitedTriggers.has(btn.text)) {
      candidates.push({ type: 'click', text: btn.text, elementType: 'button', rect: btn.rect });
    }
  }
  for (const link of (uiCatalog?.links || [])) {
    if (link.text && !visitedTriggers.has(link.text) && !link.href?.startsWith('mailto:')) {
      candidates.push({ type: 'click', text: link.text, elementType: 'link', href: link.href, rect: link.rect });
    }
  }
  return candidates;
}

function pinNode(siteVersion, hash, label, tags) {
  const g = getOrCreate(siteVersion);
  const node = g.nodes[hash];
  if (!node) return { ok: false, error: 'Node not found' };

  node.pinned = true;
  if (label) node.pinnedLabel = label;
  if (tags?.length) {
    node.tags = [...new Set([...(node.tags || []), ...tags])];
  }
  persistGraph(siteVersion, graphs);
  return { ok: true, hash, label: node.pinnedLabel || node.label, tags: node.tags };
}

// ── Backward Compatibility (state-machine.js API) ────────────────────────────

function addNodeLegacy(siteVersion, data) {
  // Old API: { hash, url, title, uiCatalog, reactState, domSnapshot }
  // New API expects reactHash/domHash — compute from data if missing
  if (!data.reactHash && !data.domHash) {
    data.domHash = data.hash;
  }
  return addNode(siteVersion, data);
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Core
  addNode: addNodeLegacy,
  addNodeV2: addNode,
  addEdge,
  getGraph,
  getOrCreate,
  getAllGraphs,
  getUnvisitedActions,
  sweepEmptyGraphs,

  // Query
  getNodeByHash,
  findGraphContaining,
  getAllNodesFlat,
  pinNode,

  // LRU
  checkLRU,
  restoreEvicted,

  // Fingerprint (re-export for convenience)
  fingerprint,

  // Re-export persistence for backward compatibility
  persistGraph,
  loadGraph,
  saveSnapshot,
  loadSnapshot,
};
