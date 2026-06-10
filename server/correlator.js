/**
 * server/correlator.js
 *
 * Time-series correlator.
 *
 * Builds deterministic, bounded causal CANDIDATES from timestamped browser
 * events.  Temporal proximity is correlation, not proven causation — chains
 * are hypotheses ranked by evidence strength, and each chain records both the
 * rule that produced it and an `evidence` object explaining its confidence
 * (so the number is auditable rather than asserted).  It is intentionally
 * conservative: chains below the confidence floor are discarded.
 *
 * CORRELATION WINDOWS:
 *
 * The correlator uses time-based windows to establish causality between events:
 *
 * 1. Network → DOM: 500ms default window (scoreNetworkToDom function)
 *    - ≤50ms:  0.85 confidence (very likely causal)
 *    - ≤500ms: 0.70-0.85 confidence (likely causal, linear decay)
 *    - ≤5000ms: 0.50-0.70 confidence (possible causal, linear decay)
 *    - >5000ms: 0.00 confidence (too distant, rejected)
 *
 *    When a framework transition is detected between network response and DOM
 *    change, confidence is raised to 0.95 (strongest tier; never 1.0 — the
 *    chain is still an inference, not an observation).
 *
 *    On top of the temporal base, per-response evidence shifts the score
 *    (see scoreChainEvidence): mutating HTTP methods (+), static-asset
 *    responses like images/fonts (−), and many candidate responses competing
 *    for the same DOM change (− per-candidate ambiguity).  Without this the
 *    score collapsed to a uniform ~0.66 across all chains (review #4).
 *
 * 2. Framework → DOM: 100ms default window (_correlateFrameworkEvent)
 *    - Base confidence: 0.85
 *    - Decays by 0.10 over the 100ms window
 *    - Minimum: confidenceFloor (default 0.50)
 *
 * ADJUSTING FOR HEAVY SPAs OR SLOW NETWORKS:
 *
 * If you observe false negatives (missing causal chains) in heavy SPAs or
 * slow network environments, you can adjust these windows via configuration:
 *
 *   const correlator = new TimeSeriesCorrelator({
 *     retentionMs: 10000,        // Increase from 5000ms to 10000ms
 *     confidenceFloor: 0.40,     // Lower from 0.50 to 0.40 to accept weaker signals
 *   });
 *
 * Or modify the scoring function directly:
 *   - Increase the 500ms threshold in scoreNetworkToDom for slower DOM updates
 *   - Increase the 100ms window in _correlateFrameworkEvent for slower framework rendering
 *
 * PRIORITY RULES (Proposal A):
 *
 * When multiple DOM change signals are available for the same time window:
 *   1. Prefer dom_mutation (MutationObserver) over visual_delta (TEXT_COORD_DELTA)
 *   2. MutationObserver provides higher precision (exact DOM nodes changed)
 *   3. TEXT_COORD_DELTA is a fallback proxy for visual changes
 *
 * The _hasDomMutationCoverage method implements this priority by suppressing
 * visual_delta correlations when a dom_mutation event exists within ±500ms.
 */
'use strict';

const DEFAULTS = {
  bufferCapacityPerTab: 200,
  retentionMs: 5000,
  confidenceFloor: 0.5,
  maxChainsPerSession: 500,
};

class CorrelationBuffer {
  constructor(opts = {}) {
    this.capacity = opts.capacity || DEFAULTS.bufferCapacityPerTab;
    this.retentionMs = opts.retentionMs || DEFAULTS.retentionMs;
    this.events = [];
  }

  add(event) {
    this.events.push(event);
    this.prune(event.timestamp);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
  }

  prune(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    while (this.events.length && this.events[0].timestamp < cutoff) {
      this.events.shift();
    }
  }

  before(timestamp, type, windowMs = this.retentionMs) {
    const cutoff = timestamp - windowMs;
    return this.events.filter(e => e.type === type && e.timestamp <= timestamp && e.timestamp >= cutoff);
  }

  between(start, end, type) {
    return this.events.filter(e => e.type === type && e.timestamp >= start && e.timestamp <= end);
  }
}

class TimeSeriesCorrelator {
  constructor(opts = {}) {
    this.options = { ...DEFAULTS, ...opts };
    this.buffers = new Map();
    this.chains = new Map();
  }

  configure(opts = {}) {
    this.options = { ...this.options, ...opts };
    for (const buffer of this.buffers.values()) {
      buffer.capacity = this.options.bufferCapacityPerTab;
      buffer.retentionMs = this.options.retentionMs;
      buffer.prune();
    }
  }

  addMessage(msg) {
    const event = normalizeMessage(msg);
    if (!event || event.tabId == null) return [];

    const buffer = this._bufferFor(event.tabId);
    const newChains = [];

    if (event.type === 'dom_mutation') {
      // High-precision MutationObserver signal — always correlate.
      newChains.push(...this._correlateDomEvent(buffer, event));
    } else if (event.type === 'visual_delta') {
      // TEXT_COORD_DELTA is the fallback proxy.  When a dom_mutation already
      // covers the same time window, skip the lower-precision visual_delta so
      // the resulting chain records "mutation_observer" rather than
      // "text_coord_delta" as the dom.signal.  (Proposal A priority rule.)
      if (!this._hasDomMutationCoverage(buffer, event.timestamp)) {
        newChains.push(...this._correlateDomEvent(buffer, event));
      }
    }

    if (event.type === 'framework_snapshot') {
      newChains.push(...this._correlateFrameworkEvent(buffer, event));
    }

    buffer.add(event);

    if (newChains.length) {
      const stored = this._chainListFor(event.tabId);
      for (const chain of newChains) {
        if (chain.confidence < this.options.confidenceFloor) continue;
        stored.push(chain);
      }
      if (stored.length > this.options.maxChainsPerSession) {
        stored.splice(0, stored.length - this.options.maxChainsPerSession);
      }
    }

    return newChains;
  }

  getChains(tabId, opts = {}) {
    let chains = [...(this.chains.get(Number(tabId)) || [])];
    if (opts.sinceMs != null) {
      const cutoff = Date.now() - Number(opts.sinceMs);
      chains = chains.filter(c => c.timestamp >= cutoff);
    }
    if (opts.selector) {
      chains = chains.filter(c => selectorMatchesChain(opts.selector, c));
    }
    chains.sort((a, b) => b.confidence - a.confidence || b.timestamp - a.timestamp);
    if (opts.limit) chains = chains.slice(0, opts.limit);
    return chains;
  }

  clearTab(tabId) {
    const id = Number(tabId);
    this.buffers.delete(id);
    this.chains.delete(id);
  }

  _bufferFor(tabId) {
    const id = Number(tabId);
    if (!this.buffers.has(id)) {
      this.buffers.set(id, new CorrelationBuffer({
        capacity: this.options.bufferCapacityPerTab,
        retentionMs: this.options.retentionMs,
      }));
    }
    return this.buffers.get(id);
  }

  _chainListFor(tabId) {
    const id = Number(tabId);
    if (!this.chains.has(id)) this.chains.set(id, []);
    return this.chains.get(id);
  }

  _correlateDomEvent(buffer, domEvent) {
    const responses = buffer.before(domEvent.timestamp, 'network_response', this.options.retentionMs);
    if (!responses.length) return [];

    const chains = [];
    for (const response of responses) {
      const deltaMs = domEvent.timestamp - response.timestamp;
      const frameworkEvents = buffer.between(response.timestamp, domEvent.timestamp, 'framework_transition');
      const { confidence, evidence } =
        scoreChainEvidence(response, deltaMs, frameworkEvents.length > 0, responses.length);

      if (confidence < this.options.confidenceFloor) continue;

      const chain = {
        id: buildChainId(domEvent.tabId, response, domEvent),
        type: 'CAUSAL_CHAIN',
        tabId: domEvent.tabId,
        timestamp: domEvent.timestamp,
        confidence,
        evidence,
        rule: frameworkEvents.length > 0 ? 'network_framework_dom' : 'network_dom_temporal',
        deltaMs,
        network: {
          requestId: response.requestId,
          url: response.url,
          method: response.method || null,
          status: response.status || null,
          responseTimestamp: response.timestamp,
        },
        framework: frameworkEvents.length ? frameworkEvents[frameworkEvents.length - 1].summary : null,
        dom: {
          eventType: domEvent.type,
          signal: domEvent.type === 'dom_mutation' ? 'mutation_observer' : 'text_coord_delta',
          mutationCount: domEvent.mutationCount || 0,
          sampleSelectors: domEvent.sampleSelectors || [],
          summary: domEvent.summary || null,
          timestamp: domEvent.timestamp,
        },
      };
      chains.push(chain);
    }

    chains.sort((a, b) => b.confidence - a.confidence || a.deltaMs - b.deltaMs);
    return chains.slice(0, 3);
  }
  // Returns true if a high-precision dom_mutation event exists within ±windowMs
  // of the given timestamp.  Used to suppress lower-precision visual_delta
  // (TEXT_COORD_DELTA) correlations when MutationObserver data is available.
  // (Proposal A priority rule.)
  _hasDomMutationCoverage(buffer, timestamp, windowMs = 500) {
    return buffer.events.some(
      e => e.type === 'dom_mutation' && Math.abs(e.timestamp - timestamp) <= windowMs
    );
  }

  // Rule 2: Framework snapshot → DOM (100ms window, 0.85 base confidence)
  // A recent framework component update is treated as strong evidence for a
  // subsequent DOM change.  The method stores a chain that links the snapshot
  // to any DOM mutation or visual delta that arrived in the same buffer within
  // the short look-back window.  DOM_MUTATION events are preferred over
  // visual_delta when both are present (Proposal A priority rule).
  _correlateFrameworkEvent(buffer, snapshotEvent) {
    const windowMs = 100;
    const mutationEvents = buffer.before(snapshotEvent.timestamp, 'dom_mutation', windowMs);
    const visualEvents   = buffer.before(snapshotEvent.timestamp, 'visual_delta', windowMs);
    // Prefer higher-precision dom_mutation; fall back to visual_delta only if
    // no mutation events are present in the look-back window.
    const baseDomEvents = mutationEvents.length ? mutationEvents : visualEvents;
    if (!baseDomEvents.length) return [];

    const chains = [];
    for (const domEvent of baseDomEvents) {
      const deltaMs = snapshotEvent.timestamp - domEvent.timestamp;
      const confidence = Math.max(
        this.options.confidenceFloor,
        Math.round((0.85 - (deltaMs / windowMs) * 0.10) * 100) / 100
      );
      if (confidence < this.options.confidenceFloor) continue;

      chains.push({
        id: `chain-${snapshotEvent.tabId}-fw-${domEvent.timestamp}-${snapshotEvent.timestamp}`,
        type: 'CAUSAL_CHAIN',
        tabId: snapshotEvent.tabId,
        timestamp: snapshotEvent.timestamp,
        confidence,
        evidence: { temporal: confidence, deltaMs, candidates: baseDomEvents.length },
        rule: 'framework_dom_temporal',
        deltaMs,
        network: null,
        framework: snapshotEvent.summary || null,
        dom: {
          eventType: domEvent.type,
          signal: domEvent.type === 'dom_mutation' ? 'mutation_observer' : 'text_coord_delta',
          mutationCount: domEvent.mutationCount || 0,
          sampleSelectors: domEvent.sampleSelectors || [],
          summary: domEvent.summary || null,
          timestamp: domEvent.timestamp,
        },
      });
    }

    chains.sort((a, b) => b.confidence - a.confidence || a.deltaMs - b.deltaMs);
    return chains.slice(0, 3);
  }
}

function normalizeMessage(msg = {}) {
  const payload = msg.payload || {};
  const tabId = Number(msg.tabId);
  if (!Number.isFinite(tabId)) return null;

  if (msg.type === 'NETWORK_REQUEST') {
    return {
      type: 'network_request',
      tabId,
      timestamp: payload.ts || payload.startTime || Date.now(),
      requestId: payload.reqId || payload.requestId,
      url: payload.url,
      method: payload.method,
    };
  }

  if (msg.type === 'NETWORK_RESPONSE') {
    return {
      type: 'network_response',
      tabId,
      timestamp: payload.ts || payload.endTime || Date.now(),
      requestId: payload.reqId || payload.requestId,
      url: payload.url,
      status: payload.status,
      method: payload.method || null,
    };
  }

  if (msg.type === 'DOM_MUTATION') {
    const records = Array.isArray(payload.records) ? payload.records : [];
    return {
      type: 'dom_mutation',
      tabId,
      timestamp: payload.timestamp || payload.capturedAt || Date.now(),
      mutationCount: records.length,
      sampleSelectors: unique(records.map(r => r.targetSelector).filter(Boolean)).slice(0, 20),
      summary: {
        batchDurationMs: payload.batchDurationMs || null,
        records: records.slice(0, 20),
      },
    };
  }

  if (msg.type === 'TEXT_COORD_DELTA') {
    const deltas = Array.isArray(payload.deltas) ? payload.deltas : [];
    return {
      type: 'visual_delta',
      tabId,
      timestamp: payload.timestamp || payload.capturedAt || Date.now(),
      mutationCount: deltas.length,
      sampleSelectors: unique(deltas.map(d => d.selector || d.xpath).filter(Boolean)).slice(0, 20),
      summary: {
        deltaCount: deltas.length,
        viewStateOnly: !!payload.viewStateOnly,
      },
    };
  }

  if (msg.type === 'REACT_TRANSITION' || msg.type === 'EXPLORER_TRANSITION' || msg.type === 'STATE_HASH_REPORT') {
    return {
      type: 'framework_transition',
      tabId,
      timestamp: payload.timestamp || payload.ts || Date.now(),
      summary: {
        sourceType: msg.type,
        from: payload.from || payload.fromReact || null,
        to: payload.to || payload.toReact || payload.currentHash || null,
        trigger: payload.trigger || null,
      },
    };
  }

  // Rule 2 input: framework component snapshots provide high-confidence DOM
  // change context — forward them as framework_snapshot events so the
  // correlator can build Rule-2 and Rule-3 chains.
  if (
    msg.type === 'REACT_SNAPSHOT'    ||
    msg.type === 'VUE_SNAPSHOT'      ||
    msg.type === 'VUE2_SNAPSHOT'     ||
    msg.type === 'VUE3_SNAPSHOT'     ||
    msg.type === 'ANGULAR_SNAPSHOT'  ||
    msg.type === 'SVELTE_SNAPSHOT'
  ) {
    return {
      type: 'framework_snapshot',
      tabId,
      timestamp: payload.timestamp || payload.ts || payload.capturedAt || Date.now(),
      summary: {
        sourceType: msg.type,
        componentCount: Array.isArray(payload.components) ? payload.components.length : null,
        rootComponent: payload.rootComponent || payload.root || null,
      },
    };
  }

  return null;
}

function scoreNetworkToDom(deltaMs, frameworkConfirmed) {
  if (frameworkConfirmed && deltaMs <= 100) return 0.95;
  if (frameworkConfirmed && deltaMs <= 500) return 0.85;
  if (deltaMs <= 50) return 0.85;
  if (deltaMs <= 500) return Math.max(0.7, round2(0.85 - ((deltaMs - 50) / 450) * 0.15));
  if (deltaMs <= DEFAULTS.retentionMs) return Math.max(0.5, round2(0.7 - ((deltaMs - 500) / 4500) * 0.2));
  return 0;
}

// Evidence-based adjustments layered over the temporal base score.  Every
// factor that moves the number is recorded in the returned `evidence` object,
// so a chain's confidence is auditable instead of asserted.  (Review #4: the
// temporal score alone collapsed to a uniform ~0.66 on real pages because
// most responses land in the 0.5-0.7 decay band.)
const STATIC_ASSET_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|map)([?#]|$)/i;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function scoreChainEvidence(response, deltaMs, frameworkConfirmed, candidateCount) {
  const temporal = scoreNetworkToDom(deltaMs, frameworkConfirmed);
  const evidence = {
    temporal,
    deltaMs,
    frameworkConfirmed: !!frameworkConfirmed,
    candidates: candidateCount,
  };
  let confidence = temporal;

  // A write round-trip immediately before a DOM change is stronger causal
  // evidence than a read — polling GETs fire constantly on busy pages.
  if (MUTATING_METHODS.has(String(response.method || '').toUpperCase())) {
    evidence.mutatingMethod = 0.05;
    confidence += 0.05;
  }

  // Image/font responses don't drive DOM updates; temporal proximity to one
  // is coincidence, not causation.  (.js and .css are NOT penalized — lazy
  // chunks and stylesheet swaps genuinely change the page.)
  if (STATIC_ASSET_RE.test(String(response.url || ''))) {
    evidence.staticAsset = -0.2;
    confidence -= 0.2;
  }

  // When several responses compete for the same DOM change, the temporal
  // signal is ambiguous — each candidate is individually less likely to be
  // the cause.
  if (candidateCount > 1) {
    const penalty = Math.min(0.12, round2(0.04 * (candidateCount - 1)));
    evidence.ambiguity = -penalty;
    confidence -= penalty;
  }

  return {
    confidence: Math.min(0.95, Math.max(0, round2(confidence))),
    evidence,
  };
}

function selectorMatchesChain(selector, chain) {
  const samples = chain?.dom?.sampleSelectors || [];
  return samples.some(s => s === selector || s.includes(selector) || selector.includes(s));
}

function buildChainId(tabId, response, domEvent) {
  const req = String(response.requestId || response.url || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(-64);
  return `chain-${tabId}-${req}-${domEvent.timestamp}`;
}

function unique(values) {
  return [...new Set(values)];
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  CorrelationBuffer,
  TimeSeriesCorrelator,
  normalizeMessage,
  scoreNetworkToDom,
  scoreChainEvidence,
  selectorMatchesChain,
};
