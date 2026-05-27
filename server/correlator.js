/**
 * server/correlator.js
 *
 * Intelligence Layer: Time-series Correlator.
 *
 * Builds deterministic, bounded causal candidates from timestamped browser
 * events.  It is intentionally conservative: chains below the confidence floor
 * are discarded, and every emitted chain records the rule that produced it.
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
      const confidence = scoreNetworkToDom(deltaMs, frameworkEvents.length > 0);

      if (confidence < this.options.confidenceFloor) continue;

      const chain = {
        id: buildChainId(domEvent.tabId, response, domEvent),
        type: 'CAUSAL_CHAIN',
        tabId: domEvent.tabId,
        timestamp: domEvent.timestamp,
        confidence,
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
  selectorMatchesChain,
};
