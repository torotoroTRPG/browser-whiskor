/**
 * server/state-navigator.js
 *
 * BFS path finding + action replay for navigate_to_state.
 *
 * Flow:
 *   1. Get current state hash from browser
 *   2. BFS shortest path on state graph
 *   3. Replay actions step by step
 *   4. Verify each step with STATE_HASH_REPORT
 *   5. Return result with path details
 */
'use strict';

const stateStore = require('./state-store');
const semantic = require('./state-semantic');

// Pending hash requests: requestId → { resolve, reject, timer }
const pendingHashRequests = new Map();

// Navigate lock: tabId → Promise — prevents concurrent navigation on same tab
const navigating = new Map();

// ── Hash Report Handler ──────────────────────────────────────────────────────

function handleHashReport(msg) {
  const { requestId, payload } = msg;
  const p = pendingHashRequests.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pendingHashRequests.delete(requestId);
  p.resolve(payload);
}

// ── Request Current Hash from Browser ────────────────────────────────────────

function requestHash(tabId, broadcast, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => {
      pendingHashRequests.delete(requestId);
      reject(new Error('STATE_HASH_REPORT timeout (tabId=' + tabId + ')'));
    }, timeoutMs);
    pendingHashRequests.set(requestId, { resolve, reject, timer });
    broadcast({ type: 'REQUEST_STATE_HASH', tabId, requestId, watchMode: false });
  });
}

// ── BFS Shortest Path ────────────────────────────────────────────────────────

function findPath(graph, fromHash, toHash, minConfidence = 0.3) {
  if (fromHash === toHash) return [];

  const visited = new Set([fromHash]);
  const queue = [[fromHash, []]];

  while (queue.length > 0) {
    const [current, path] = queue.shift();
    const edges = graph.edges[current] || {};

    for (const edgeKey of Object.keys(edges)) {
      const edge = edges[edgeKey];
      if (!edge.to || visited.has(edge.to)) continue;
      if (edge.replayable === false) continue; // observation-only, nothing to execute
      if (edge.confidence < minConfidence) continue;

      const newPath = [...path, { ...edge, edgeKey }];

      if (edge.to === toHash) return newPath;

      visited.add(edge.to);
      queue.push([edge.to, newPath]);
    }
  }

  return null;
}

// ── Navigate to State ────────────────────────────────────────────────────────

async function navigate(tabId, targetHash, options, executeAction, broadcast) {
  const start = Date.now();

  // Prevent concurrent navigation on same tab
  if (navigating.has(tabId)) {
    return { ok: false, error: 'CONCURRENT_NAVIGATION', message: 'Navigation already in progress for this tab. Wait for it to complete.' };
  }
  navigating.set(tabId, true);

  const {
    siteVersion,
    timeoutMs = 30000,
    maxSteps = 10,
    verifyEachStep = true,
    allowUrlFallback = true,
    stepTimeoutMs = 5000,
  } = options || {};

  try {
    // Step 1: Get current hash
    let currentState;
    try {
      currentState = await requestHash(tabId, broadcast, stepTimeoutMs);
    } catch (e) {
      return { ok: false, error: 'HASH_TIMEOUT', message: 'Could not get current state hash. Is the extension connected?' };
    }

    const startHash = currentState.compositeHash;

    if (startHash === targetHash) {
      return { ok: true, stepsExecuted: 0, exactMatch: true, durationMs: Date.now() - start, path: [] };
    }

    // Step 2: Find graph
    let graph = siteVersion ? stateStore.getGraph(siteVersion) : null;
    if (!graph) {
      graph = stateStore.findGraphContaining(targetHash);
    }
    if (!graph) {
      return { ok: false, error: 'NO_GRAPH', message: 'No state graph found. Run the explorer first.' };
    }

    // Step 3: BFS path finding
    let path = findPath(graph, startHash, targetHash);

    // Step 4: URL fallback
    if (!path && allowUrlFallback) {
      const targetNode = graph.nodes[targetHash];
      if (targetNode?.url) {
        try {
          await executeAction(tabId, { type: 'navigate', url: targetNode.url }, 10000);
          await new Promise(r => setTimeout(r, 2000)); // Wait for page load
          const finalState = await requestHash(tabId, broadcast, 8000);
          return {
            ok: finalState.compositeHash === targetHash,
            exactMatch: finalState.compositeHash === targetHash,
            finalHash: finalState.compositeHash,
            targetHash,
            usedUrlFallback: true,
            durationMs: Date.now() - start,
          };
        } catch (e) {
          return { ok: false, error: 'URL_FALLBACK_FAILED', message: e.message };
        }
      }
      return {
        ok: false,
        error: 'NO_PATH',
        message: 'No recorded path from current state to target. Graph may be incomplete.',
        suggestions: _findSimilarStates(graph, targetHash, 3),
      };
    }

    if (!path) {
      return {
        ok: false,
        error: 'NO_PATH',
        message: 'No path found from current state to target.',
        suggestions: _findSimilarStates(graph, targetHash, 3),
      };
    }

    if (path.length > maxSteps) {
      return {
        ok: false,
        error: 'PATH_TOO_LONG',
        message: 'Path requires ' + path.length + ' steps, max is ' + maxSteps + '.',
        pathLength: path.length,
      };
    }

    // Step 5: Action replay
    const executedPath = [];
    for (let i = 0; i < path.length; i++) {
      const edge = path[i];
      const action = edge.replayAction || { type: edge.action, text: edge.trigger, selector: edge.selector };

      let actionResult;
      try {
        actionResult = await executeAction(tabId, action, stepTimeoutMs);
      } catch (e) {
        return {
          ok: false,
          error: 'ACTION_FAILED',
          message: e.message,
          step: i + 1,
          edge: { action: edge.action, trigger: edge.trigger },
          path: executedPath,
        };
      }

      if (!actionResult?.ok) {
        return {
          ok: false,
          error: 'ACTION_FAILED',
          message: actionResult?.error || 'Action failed',
          step: i + 1,
          edge: { action: edge.action, trigger: edge.trigger },
          path: executedPath,
        };
      }

      // Verify step
      if (verifyEachStep) {
        try {
          const state = await requestHash(tabId, broadcast, stepTimeoutMs);
          executedPath.push({
            step: i + 1,
            action: edge.action,
            trigger: edge.trigger,
            fromHash: edge.from,
            expectedTo: edge.to,
            actualTo: state.compositeHash,
            ok: state.compositeHash === edge.to,
          });

          if (state.compositeHash !== edge.to) {
            // Unexpected transition — record it but continue
            stateStore.addEdge(graph.siteVersion, {
              from: edge.from,
              to: state.compositeHash,
              action: edge.action,
              trigger: edge.trigger,
            });
          }
        } catch (e) {
          executedPath.push({
            step: i + 1,
            action: edge.action,
            trigger: edge.trigger,
            fromHash: edge.from,
            expectedTo: edge.to,
            actualTo: null,
            ok: false,
            error: 'Hash verification timeout',
          });
        }
      } else {
        executedPath.push({
          step: i + 1,
          action: edge.action,
          trigger: edge.trigger,
          fromHash: edge.from,
          expectedTo: edge.to,
          ok: true,
        });
      }
    }

    // Step 6: Final verification
    let finalHash = null;
    let exactMatch = false;
    try {
      const finalState = await requestHash(tabId, broadcast, stepTimeoutMs);
      finalHash = finalState.compositeHash;
      exactMatch = finalHash === targetHash;
    } catch (_) {
      // Can't verify, but actions completed
    }

    return {
      ok: true,
      stepsExecuted: path.length,
      finalHash,
      targetHash,
      exactMatch,
      durationMs: Date.now() - start,
      path: executedPath,
    };

  } catch (e) {
    return {
      ok: false,
      error: 'NAVIGATION_ERROR',
      message: e.message,
      durationMs: Date.now() - start,
    };
  } finally {
    navigating.delete(tabId);
  }
}

// ── Get Navigation Path (dry-run) ────────────────────────────────────────────

function getNavigationPath(fromHash, toHash, siteVersion) {
  let graph = siteVersion ? stateStore.getGraph(siteVersion) : null;
  if (!graph) graph = stateStore.findGraphContaining(toHash);
  if (!graph) return { reachable: false, error: 'No graph found' };

  const path = findPath(graph, fromHash, toHash);
  if (!path) return { reachable: false, error: 'No path found' };

  const warnings = [];
  let totalConfidence = 1;
  for (const edge of path) {
    totalConfidence *= edge.confidence || 0.5;
    if ((edge.confidence || 0) < 0.5) {
      warnings.push('Step "' + edge.action + ':' + edge.trigger + '" confidence is low (' + (edge.confidence || 0).toFixed(2) + ')');
    }
  }

  return {
    reachable: true,
    steps: path.length,
    confidence: Math.round(totalConfidence * 100) / 100,
    path: path.map((e, i) => ({
      step: i + 1,
      action: e.action,
      trigger: e.trigger,
      fromHash: e.from,
      toHash: e.to,
      confidence: e.confidence,
    })),
    warnings,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Rank states by semantic + structural similarity to a target node.
 *
 * Used to give the agent actionable alternatives when no replayable path to the
 * requested state exists. Combines three independent signals so a useful
 * suggestion surfaces even when any single one is weak:
 *   1. Tag overlap (Jaccard)      — the strongest semantic fingerprint
 *   2. Label similarity (bigram)  — reuses state-semantic's bigram engine
 *   3. URL / pathname proximity   — structural locality on the graph
 */
function _findSimilarStates(graph, targetHash, limit) {
  const target = graph.nodes[targetHash];
  if (!target) return [];

  const targetTags  = new Set(target.tags || []);
  const targetLabel = (target.label || '').toLowerCase();
  let targetPath = null;
  if (target.url) {
    try { targetPath = new URL(target.url, 'http://x').pathname; } catch (_) {}
  }

  const scored = [];

  for (const [hash, node] of Object.entries(graph.nodes)) {
    if (hash === targetHash || node.evicted) continue;

    let score = 0;
    const reasons = [];

    // 1. Tag overlap (Jaccard) — weighted highest.
    const nodeTags = new Set(node.tags || []);
    if (targetTags.size && nodeTags.size) {
      let inter = 0;
      for (const t of targetTags) if (nodeTags.has(t)) inter++;
      if (inter > 0) {
        const union = targetTags.size + nodeTags.size - inter;
        score += (inter / union) * 2.0;
        reasons.push(`${inter} shared tag${inter > 1 ? 's' : ''}`);
      }
    }

    // 2. Label similarity (bigram) — semantic closeness of generated labels.
    if (targetLabel && node.label) {
      const labelSim = semantic.computeBigramSimilarity(targetLabel, node.label.toLowerCase());
      if (labelSim > 0.3) {
        score += labelSim;
        reasons.push('similar label');
      }
    }

    // 3. URL proximity — exact URL is a strong structural signal; same pathname
    //    (ignoring query string) is a softer one.
    if (target.url && node.url === target.url) {
      score += 1.5;
      reasons.push('same URL');
    } else if (targetPath && node.url) {
      try {
        if (new URL(node.url, 'http://x').pathname === targetPath) {
          score += 0.75;
          reasons.push('same path');
        }
      } catch (_) {}
    }

    if (score > 0) {
      scored.push({
        hash,
        label: node.label,
        url: node.url,
        tags: node.tags || [],
        score: Math.round(score * 100) / 100,
        reason: reasons.join(', '),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  navigate,
  findPath,
  getNavigationPath,
  handleHashReport,
  requestHash,
  _findSimilarStates,
};
