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

// ── Speculative reverse edges (S1: history inverses) ─────────────────────────
// Recorded graphs are almost purely forward-directed — the control that leaves
// a state is rarely the one that led into it. For forward transitions that
// changed the URL, `go_back` is a cheap candidate inverse with a good prior.
// Candidates are derived at findPath time (the persisted graph stays a record
// of observations, never guesses), verified by the existing per-step hash
// check, persisted only on success (earned), and blacklisted in-process on
// failure. Design: docs/ideas/REVERSE_EDGE_NAVIGATION.md.

const SPECULATIVE_PRIORS = {
  goBack: 0.5,       // history inverts URL-changing transitions
  escape: 0.35,      // Escape dismisses the dialog a transition opened
  dismissLabel: 0.3, // a dismiss-looking control (閉じる/×/close/…) in the state
};

// siteVersion|from|to|action|trigger → ts of the failed verification. A wrong
// guess demotes itself on first use instead of being retried on every call.
// trigger is part of the key so one wrong close-label doesn't blacklist the
// pair's other candidates.
const speculativeBlacklist = new Map();

function blacklistKey(siteVersion, edge) {
  return `${siteVersion || '?'}|${edge.from}|${edge.to}|${edge.action}|${edge.trigger || ''}`;
}

// A transition that mutated data has no safe inverse — going "back" would not
// undo it, only mislead. Detectable submit shapes plus a conservative label
// net; a false positive here only costs a shortcut, a false negative fakes an
// undo.
const SUBMIT_LABEL_RE = /submit|送信|確定|購入|支払|保存|削除|delete|save|buy|checkout|register|登録/i;

function isSubmitShaped(edge) {
  if (!edge) return false;
  if (edge.action === 'type_text' || edge.action === 'submit') return true;
  const ra = edge.replayAction || {};
  if (ra.type === 'type_text' || ra.submit) return true;
  if (typeof ra.selector === 'string' && /submit/i.test(ra.selector)) return true;
  if (typeof edge.trigger === 'string' && SUBMIT_LABEL_RE.test(edge.trigger)) return true;
  return false;
}

/**
 * Derive reverse candidates for one traversal, from two bases:
 *   - history (go_back): forward a→b changed the URL — skipped for
 *     submit-shaped forwards (a data mutation has no safe inverse);
 *   - dismiss (Escape): forward a→b opened a dialog (edge.dialogAppeared,
 *     sampled at settle time by the passive emitter). Escape only dismisses
 *     UI, so it stays safe even when the opener looked submit-shaped.
 * Pairs already covered by a real reverse edge and blacklisted guesses are
 * skipped. Returns from-hash → [candidates], best prior first.
 */
function speculativeReverseEdges(graph, minConfidence) {
  const nodes = graph.nodes || {};
  const byFrom = {};

  const offer = (cand) => {
    if (cand.confidence < minConfidence) return;
    if (speculativeBlacklist.has(blacklistKey(graph.siteVersion, cand))) return;
    const list = (byFrom[cand.from] = byFrom[cand.from] || []);
    if (list.some(c => c.to === cand.to && c.action === cand.action)) return;
    list.push(cand);
    list.sort((a, b) => b.confidence - a.confidence);
  };

  for (const from of Object.keys(graph.edges || {})) {
    for (const edgeKey of Object.keys(graph.edges[from])) {
      const fwd = graph.edges[from][edgeKey];
      if (!fwd.to || fwd.to === from) continue;
      const hasRealReverse = Object.values(graph.edges[fwd.to] || {})
        .some(e => e.to === from && e.replayable !== false);
      if (hasRealReverse) continue;

      const fromUrl = nodes[from]?.url;
      const toUrl = nodes[fwd.to]?.url;
      if (fromUrl && toUrl && fromUrl !== toUrl && !isSubmitShaped(fwd)) {
        offer({
          from: fwd.to,
          to: from,
          action: 'go_back',
          trigger: null,
          confidence: SPECULATIVE_PRIORS.goBack,
          speculative: true,
          basis: 'speculative-history',
          replayAction: { type: 'go_back' },
        });
      }

      if (fwd.dialogAppeared === true) {
        offer({
          from: fwd.to,
          to: from,
          action: 'press_key',
          trigger: 'Escape',
          confidence: SPECULATIVE_PRIORS.escape,
          speculative: true,
          basis: 'speculative-dismiss',
          replayAction: { type: 'press_key', key: 'Escape' },
        });
      }

      // S4: a dismiss-looking control in the arrival state (from its recorded
      // uiSummary — explorer-visited nodes carry one). One label per pair is
      // guess enough; a wrong one blacklists only itself (trigger in the key).
      for (const label of nodes[fwd.to]?.uiSummary?.buttons || []) {
        if (!stateStore.isDismissLabel(label)) continue;
        offer({
          from: fwd.to,
          to: from,
          action: 'click',
          trigger: label,
          confidence: SPECULATIVE_PRIORS.dismissLabel,
          speculative: true,
          basis: 'speculative-dismiss',
          replayAction: { type: 'click', text: label },
        });
        break;
      }
    }
  }
  return byFrom;
}

// ── BFS Shortest Path ────────────────────────────────────────────────────────

function findPath(graph, fromHash, toHash, minConfidence = 0.3, options = {}) {
  if (fromHash === toHash) return [];

  // Lazy reverse candidates ride along as extra edges. BFS itself is
  // untouched — real edges are expanded first at every node, so at equal
  // path length an observed route beats a speculative one.
  const speculative = options.speculative ? speculativeReverseEdges(graph, minConfidence) : null;

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

    for (const cand of (speculative && speculative[current]) || []) {
      if (visited.has(cand.to)) continue;

      const newPath = [...path, { ...cand, edgeKey: `${cand.action}:speculative` }];

      if (cand.to === toHash) return newPath;

      visited.add(cand.to);
      queue.push([cand.to, newPath]);
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
    // Target tolerance (S3). 'strict' = the exact hash or nothing.
    // 'auto' (default) = exact hash first; if it is unreachable, resolve to
    // the best reachable equivalent and SAY SO (matched:'fuzzy').
    // 'fuzzy' = additionally accept a final state merely similar to the
    // target. Never silently pretends exactness in any mode.
    mode = 'auto',
    // _findSimilarStates score floor for fuzzy resolution. Scale: same URL
    // alone = 1.5, same pathname 0.75, tag overlap up to 2.0, label up to 1.0.
    minSimilarity = 1.0,
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

    // Steps 3-5: plan → replay, with bounded replanning. A speculative edge
    // that fails hash verification blacklists itself and triggers a re-plan
    // from wherever we actually landed (next candidate, hub route, or —
    // when candidates run out — the URL fallback below). Speculative edges
    // are only generated when steps are verified: unverified guesses could
    // neither be earned nor caught.
    const MAX_REPLANS = 3;
    const executedPath = [];
    let replans = 0;
    let usedSpeculative = false;
    let currentHash = startHash;
    let path = null;
    let completed = false;
    let firstPlan = true;
    let effectiveTarget = targetHash;
    let resolution = null; // set when the target was fuzzy-resolved

    planning:
    while (!completed) {
      path = findPath(graph, currentHash, effectiveTarget, 0.3, { speculative: verifyEachStep });
      if (!path) {
        // Fuzzy target resolution: the exact hash is unreachable (drifted
        // content, stale graph). Resolve once to the best REACHABLE
        // equivalent — reported as matched:'fuzzy', never dressed up.
        if (mode !== 'strict' && !resolution) {
          const candidates = _findSimilarStates(graph, targetHash, 5)
            .filter(c => c.score >= minSimilarity && c.hash !== currentHash);
          for (const cand of candidates) {
            if (findPath(graph, currentHash, cand.hash, 0.3, { speculative: verifyEachStep })) {
              effectiveTarget = cand.hash;
              resolution = {
                matched: 'fuzzy',
                similarity: cand.score,
                resolvedTarget: cand.hash,
                label: cand.label,
                reason: cand.reason,
              };
              continue planning;
            }
          }
        }
        break;
      }

      if (executedPath.length + path.length > maxSteps) {
        if (firstPlan) {
          return {
            ok: false,
            error: 'PATH_TOO_LONG',
            message: 'Path requires ' + path.length + ' steps, max is ' + maxSteps + '.',
            pathLength: path.length,
          };
        }
        path = null; // replanned route exceeds the budget — fall to URL fallback
        break;
      }
      firstPlan = false;

      for (let i = 0; i < path.length; i++) {
        const edge = path[i];
        const stepNo = executedPath.length + 1;
        const action = edge.replayAction || { type: edge.action, text: edge.trigger, selector: edge.selector };
        if (edge.speculative) usedSpeculative = true;

        let actionResult, actionError = null;
        try {
          actionResult = await executeAction(tabId, action, stepTimeoutMs);
        } catch (e) {
          actionError = e.message;
        }
        if (!actionError && !actionResult?.ok) actionError = actionResult?.error || 'Action failed';

        if (actionError) {
          if (edge.speculative) {
            // A guess that cannot even execute is as wrong as a hash miss.
            speculativeBlacklist.set(blacklistKey(graph.siteVersion, edge), Date.now());
            if (replans++ < MAX_REPLANS) continue planning;
            path = null;
            break planning;
          }
          return {
            ok: false,
            error: 'ACTION_FAILED',
            message: actionError,
            step: stepNo,
            edge: { action: edge.action, trigger: edge.trigger },
            path: executedPath,
          };
        }

        // Verify step
        if (verifyEachStep) {
          let state = null;
          try {
            state = await requestHash(tabId, broadcast, stepTimeoutMs);
          } catch (e) {
            executedPath.push({
              step: stepNo,
              action: edge.action,
              trigger: edge.trigger,
              speculative: !!edge.speculative,
              fromHash: edge.from,
              expectedTo: edge.to,
              actualTo: null,
              ok: false,
              error: 'Hash verification timeout',
            });
            if (edge.speculative) { path = null; break planning; } // can't judge the guess — stop guessing
            continue;
          }

          const stepOk = state.compositeHash === edge.to;
          executedPath.push({
            step: stepNo,
            action: edge.action,
            trigger: edge.trigger,
            speculative: !!edge.speculative,
            fromHash: edge.from,
            expectedTo: edge.to,
            actualTo: state.compositeHash,
            ok: stepOk,
          });

          if (edge.speculative) {
            if (stepOk) {
              // Earned: the guess survived verification — persist it as a
              // normal transition with provenance. Repeat successes promote
              // confidence through the ordinary count lifecycle.
              stateStore.addEdge(graph.siteVersion, {
                from: edge.from,
                to: edge.to,
                action: edge.action,
                trigger: edge.trigger,
                replayAction: edge.replayAction,
                basis: edge.basis,
              });
            } else {
              speculativeBlacklist.set(blacklistKey(graph.siteVersion, edge), Date.now());
              if (replans++ < MAX_REPLANS && state.compositeHash) {
                currentHash = state.compositeHash;
                continue planning;
              }
              path = null;
              break planning;
            }
          } else if (!stepOk) {
            // Unexpected transition on an observed edge — record it but continue
            stateStore.addEdge(graph.siteVersion, {
              from: edge.from,
              to: state.compositeHash,
              action: edge.action,
              trigger: edge.trigger,
            });
          }
        } else {
          executedPath.push({
            step: stepNo,
            action: edge.action,
            trigger: edge.trigger,
            speculative: false,
            fromHash: edge.from,
            expectedTo: edge.to,
            ok: true,
          });
        }
      }
      completed = true;
    }

    // URL fallback — last resort, and honest about what it is: navigate()
    // resets SPA state, so reaching the URL is NOT reaching the recorded state.
    if (!completed) {
      if (allowUrlFallback) {
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
              fallback: 'url',
              note: 'SPA state was reset — reached the URL, not the recorded state',
              path: executedPath,
              durationMs: Date.now() - start,
            };
          } catch (e) {
            return { ok: false, error: 'URL_FALLBACK_FAILED', message: e.message, path: executedPath };
          }
        }
      }
      return {
        ok: false,
        error: 'NO_PATH',
        message: executedPath.length
          ? 'No remaining path to target after speculative steps failed.'
          : 'No recorded path from current state to target. Graph may be incomplete.',
        suggestions: _findSimilarStates(graph, targetHash, 3),
        path: executedPath,
      };
    }

    // Step 6: Final verification. matched reports what actually happened:
    // 'exact' — arrived at the requested hash; 'fuzzy' — arrived at a
    // resolved/similar state (similarity attached); null — neither.
    let finalHash = null;
    let exactMatch = false;
    let matched = null;
    let similarity = null;
    try {
      const finalState = await requestHash(tabId, broadcast, stepTimeoutMs);
      finalHash = finalState.compositeHash;
      exactMatch = finalHash === targetHash;
      if (exactMatch) {
        matched = 'exact';
      } else if (resolution && finalHash === effectiveTarget) {
        matched = 'fuzzy';
        similarity = resolution.similarity;
      } else if (mode === 'fuzzy' && finalHash && graph.nodes[finalHash]) {
        // Final-state tolerance: the hash drifted but we may still be at the
        // "same place" — score where we landed against the requested target.
        const found = _findSimilarStates(graph, targetHash, 50).find(c => c.hash === finalHash);
        if (found && found.score >= minSimilarity) {
          matched = 'fuzzy';
          similarity = found.score;
        }
      }
    } catch (_) {
      // Can't verify, but actions completed
    }

    return {
      ok: true,
      stepsExecuted: executedPath.length,
      finalHash,
      targetHash,
      exactMatch,
      matched,
      ...(similarity != null ? { similarity } : {}),
      ...(resolution ? { requestedTarget: targetHash, resolution } : {}),
      usedSpeculative,
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

  // The dry-run mirrors what navigate() would actually try, speculative
  // reverse edges included — reported as such, never dressed up as observed.
  const path = findPath(graph, fromHash, toHash, 0.3, { speculative: true });
  if (!path) return { reachable: false, error: 'No path found' };

  const warnings = [];
  let totalConfidence = 1;
  for (const edge of path) {
    totalConfidence *= edge.confidence || 0.5;
    if (edge.speculative) {
      warnings.push('Step "' + edge.action + '" is a speculative reverse edge (basis: ' + edge.basis + ') — verified on first use');
    } else if ((edge.confidence || 0) < 0.5) {
      warnings.push('Step "' + edge.action + ':' + edge.trigger + '" confidence is low (' + (edge.confidence || 0).toFixed(2) + ')');
    }
  }

  return {
    reachable: true,
    steps: path.length,
    confidence: Math.round(totalConfidence * 100) / 100,
    speculativeSteps: path.filter(e => e.speculative).length,
    path: path.map((e, i) => ({
      step: i + 1,
      action: e.action,
      trigger: e.trigger,
      fromHash: e.from,
      toHash: e.to,
      confidence: e.confidence,
      speculative: !!e.speculative,
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
  _speculativeReverseEdges: speculativeReverseEdges,
  _clearSpeculativeBlacklist: () => speculativeBlacklist.clear(),
};
