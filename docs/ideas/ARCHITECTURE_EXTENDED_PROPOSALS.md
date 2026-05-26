╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║                         browser-whiskor v3                                   ║
║                    Extended Architecture — Implemented & Proposed            ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝


  This document catalogs extensions to the Intelligence Layer beyond the five
  core subsystems.  Each extension is self-contained: it specifies scope,
  interface contracts, data schemas, and integration points.

  Status:  [IMPLEMENTED]  = already shipped in v3.
           [PROPOSAL]     = not yet implemented (only D remains).


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  EXTENSION A : DOM_MUTATION Event Type                          [IMPLEMENTED]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Addresses the coverage gap in the Time-series Correlator's DOM mutation
  proxy.  TEXT_COORD_DELTA is currently used as a mutation signal; it misses
  attribute-only mutations and invisible insertions.

  A dedicated DOM_MUTATION event type, emitted from a MutationObserver in
  extension/injected/analyzers/dom-mutations.js, provides direct mutation
  coverage independent of visual coordinate changes.


  MutationObserver configuration

    const observer = new MutationObserver(records => emit(DOM_MUTATION, ...));
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeOldValue: true,
      characterDataOldValue: false   // high volume; opt-in only
    });


  Batching

  MutationObserver callbacks batch all mutations queued since the previous
  microtask.  The emitter coalesces records by target element and mutation
  type within a 16 ms window before sending to avoid flooding the WebSocket
  with one message per keystroke during text input.

  Coalescing rule: multiple attribute mutations on the same element within
  the window collapse to the latest value of each attribute.  childList
  mutations are not coalesced (addition and removal of the same node within
  a window indicates transient DOM; record both).


  DOM_MUTATION schema

  {
    type: "DOM_MUTATION",
    tabId: number,
    timestamp: number,
    batchDurationMs: number,         // duration of the coalesced window
    records: [
      {
        mutationType: "childList" | "attributes" | "characterData",
        targetSelector: string,      // computed selector of target element
        addedCount: number,          // childList only
        removedCount: number,        // childList only
        attributeName: string | null,
        oldValue: string | null,
        newValue: string | null
      }
    ]
  }


  Correlator integration

  The Time-series Correlator is extended to consume DOM_MUTATION alongside
  TEXT_COORD_DELTA.  When both are present in the buffer, DOM_MUTATION takes
  precedence as the mutation signal (higher precision).  TEXT_COORD_DELTA
  remains as the fallback for sites where MutationObserver is suppressed or
  where the dom-mutations analyzer is disabled.

  All three correlation rules (Network→DOM, Framework→DOM, composed chain)
  apply equally to DOM_MUTATION as to TEXT_COORD_DELTA.  The CausalChain
  dom.signal field records which proxy was used:

    dom.signal: "mutation_observer" | "text_coord_delta"


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  EXTENSION B : CSS @layer Cascade Resolution                    [IMPLEMENTED]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Addresses the known limitation in the CSS Origin Tracker: @layer order
  is not accounted for in the winning-rule selection algorithm.


  @layer ordering in the CSSOM

  CSSLayerStatementRule and CSSLayerBlockRule are accessible via
  document.styleSheets[i].cssRules.  Layer declaration order reflects the
  cascade precedence: a rule in a later @layer declaration takes precedence
  over a rule in an earlier @layer at equal specificity.

  @layer priority is lower than non-layered rules.  A rule outside any
  @layer wins over any layered rule at equal specificity.


  Extended candidate sort key

  The existing sort key [specificity, source_order] is extended to
  [layer_priority, specificity, source_order]:

    layer_priority:
      0  = unlayered rule  (highest priority)
      1  = first-declared @layer
      2  = second-declared @layer
      ...

  Layer priority is computed by collecting CSSLayerStatementRule and
  CSSLayerBlockRule entries from each stylesheet in document order.  The
  resulting map assigns an integer index to each layer name.  Anonymous
  layers are assigned sequential indexes at their point of declaration.

  @layer ordering is computed once per stylesheet and cached until the
  next PAGE_NAVIGATED event.


  Layer index extraction

  function buildLayerIndex(sheet) {
    const map = new Map();  // layerName → priority
    let seq = 0;
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSLayerStatementRule) {
        for (const name of rule.nameList) {
          if (!map.has(name)) map.set(name, ++seq);
        }
      }
      if (rule instanceof CSSLayerBlockRule) {
        const name = rule.name || "__anon_" + seq;
        if (!map.has(name)) map.set(name, ++seq);
      }
    }
    return map;
  }

  A rule's layer name is determined by the nearest enclosing
  CSSLayerBlockRule ancestor in the rule's cssRule hierarchy.  Rules not
  inside any CSSLayerBlockRule receive layer_priority = 0.

  @scope (CSS Scoping Level 1) follows an analogous approach when
  CSSStyleRule.scope is available in the browser; no action is required
  beyond acknowledging proximity score in the existing specificity rank.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  EXTENSION C : State Graph Visualizer                           [IMPLEMENTED]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Produces a compact, text-encoded representation of the state graph for a
  given session, including a position marker for the current state.

  The visualizer does not replace the state graph data model; it is a
  read-only projection of the existing StateGraph structure.

  Location: server/state-visualizer.js  (new)
  Accessible via: new MCP tool get_state_map_visual  (read category)
  Output: a single UTF-8 string


  Layout algorithm

  Nodes are arranged in topological order using a BFS traversal rooted at
  the first-observed node (earliest firstSeen).  Each level of the BFS
  becomes a row in the output.  Edges are represented as connector characters
  between rows.

  Constraints:
    - Output width: configurable, default 80 columns
    - Maximum nodes rendered: configurable, default 40
      Graphs larger than the limit are rendered as a summary with a message
      indicating truncation and an offer to render a subgraph.
    - Long labels are truncated with "…" to fit the column budget.


  Rendering elements

    ●  current position (the state whose hash matches the current composite
       hash, obtained via REQUEST_STATE_HASH)
    ○  visited state
    ◎  pinned state
    ─  single forward edge
    ┬  branch point (multiple outgoing edges)
    ┴  merge point (multiple incoming edges)
    ?  unvisited interactive element (from getUnvisitedActions)


  Example output  (illustrative)

    session: tab 4  /dashboard  (12 nodes, 18 edges)
    ──────────────────────────────────────────────────────────────────────

    ○ Home  (1bca3f2)                         first seen 14:02
      │
      ├─ ○ Login  (4a9d871)
      │    │
      │    └─ ○ Settings  (7f3c120)
      │         │
      │         └─ ○ Settings / Profile  (2e5a907)
      │
      └─ ○ Dashboard  (9c14e3b)
           │
           ├─ ● Reports  (0d82f11)            ← current
           │    ?  Export button (unvisited)
           │
           └─ ○ Analytics  (8b71c04)

    ──────────────────────────────────────────────────────────────────────
    ● current  ○ visited  ◎ pinned  ? unvisited action

  The position marker is updated on each call to get_state_map_visual by
  requesting the current hash at render time (one REQUEST_STATE_HASH round
  trip, identical to navigate_to_state verification).


  get_state_map_visual  tool schema

  Input:
  {
    tabId: number,
    maxNodes?: number,       // default 40
    width?: number,          // default 80
    rootHash?: string        // render subgraph rooted at this state
  }

  Output:
  {
    ok: boolean,
    visual: string,          // UTF-8 text map
    currentHash: string,
    totalNodes: number,
    renderedNodes: number,
    truncated: boolean
  }


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  EXTENSION D : Adaptive Collection Scheduling                   [PROPOSAL — sole remaining]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Analyzers currently run on a fixed schedule or on manual trigger.  Adaptive
  scheduling adjusts collection frequency per analyzer based on observed
  change rate, reducing unnecessary collection on stable pages and increasing
  responsiveness on high-activity pages.


  Change rate model

  Each analyzer maintains a per-session EMA (exponential moving average)
  of inter-observation change magnitude.  Change magnitude is defined per
  analyzer:

    text-coords:   count of elements whose text or coordinates changed
    network:       count of new requests since last collection
    css-origin:    count of new CSS rules affecting tracked elements
    framework:     count of component state updates (from REACT_SNAPSHOT
                   or equivalent)

  EMA weight α = 0.3.  Updated after each collection:

    ema_n = α × magnitude_n + (1 − α) × ema_{n-1}


  Scheduling policy

  ┌──────────────────────┬─────────────────┬──────────────────────────────┐
  │  ema value           │  Classification │  Collection interval         │
  ├──────────────────────┼─────────────────┼──────────────────────────────┤
  │  0                   │  quiescent      │  no scheduled collection     │
  │  > 0, ≤ low_thresh   │  low activity   │  config.analyzer.interval    │
  │  > low_thresh        │  active         │  config.analyzer.interval    │
  │                      │                 │  × config.adaptive.activeDiv │
  │  > high_thresh       │  high activity  │  interval × activeDiv²       │
  └──────────────────────┴─────────────────┴──────────────────────────────┘

  Thresholds and divisors are per-analyzer and configurable.

  Quiescent analyzers are not scheduled; they resume on any of:
    - PAGE_NAVIGATED event
    - EXPLORER_STATE_UPDATE event
    - Explicit MANUAL_COLLECT command


  Config additions

  "adaptive": {
    "enabled": false,          // opt-in; default off
    "emaAlpha": 0.3,
    "perAnalyzer": {
      "textCoords":   { "lowThresh": 5,  "highThresh": 50, "activeDiv": 2 },
      "network":      { "lowThresh": 1,  "highThresh": 10, "activeDiv": 3 },
      "cssOrigin":    { "lowThresh": 2,  "highThresh": 20, "activeDiv": 2 },
      "framework":    { "lowThresh": 3,  "highThresh": 30, "activeDiv": 2 }
    }
  }


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  EXTENSION E : Source Map Resolver                              [IMPLEMENTED]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Resolves compiled file/line references from CSS and JS assets to their
  original source positions using the V3 Source Map format (RFC 5988 / TC39
  proposal).

  Location: server/source-map-resolver.js  (new)

  The resolver is invoked on-demand:
    - CSS Origin Tracker: after acquiring CSS source text at Level 3, check
      for a `/*# sourceMappingURL=... */` comment.
    - Framework↔DOM Mapper: after reading React fiber._debugSource, cross-
      reference against the corresponding JS bundle's source map.


  Source map acquisition

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Step 1: Check inline data URI                                           │
  │    sourceMappingURL = data:application/json;base64,...                  │
  │    Decode and parse immediately.  No network request.                   │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Step 2: Fetch external .map file                                        │
  │    Resolve the sourceMappingURL relative to the source file URL.        │
  │    Fetch with { credentials: 'omit', cache: 'force-cache' }.            │
  │    On 404 or CORS failure: resolver returns null for this file.         │
  │    Source map files are commonly large (> 1 MB for JS bundles);         │
  │    size cap: config.sourceMap.maxSizeBytes (default: 4 MB).             │
  └─────────────────────────────────────────────────────────────────────────┘


  VLQ decoding

  Source maps encode position mappings as Base64 VLQ.  The resolver
  implements VLQ decoding in plain JS without external libraries.  The
  mappings string is parsed on first access and the decoded segments are
  indexed into a sorted array by generated line/column for binary search.

  Data structure after parsing:

    segments[generatedLine] = [
      { generatedColumn, sourceIndex, originalLine, originalColumn, nameIndex }
    ]

  Lookup: given (generatedLine, generatedColumn), binary-search for the
  nearest preceding segment on that line.  Returns { originalFile, originalLine }.
  originalFile is resolved against the sources[] array in the source map.


  Cache model

  Parsed source maps are held in memory in a Map<url, ParsedSourceMap> with
  LRU eviction at 10 entries.  Source map files are not persisted to the
  session cache directory; they are re-fetched on cache miss.

  Cross-session persistence is intentionally excluded: source map files may
  change with each deployment, and their URLs are not stable identifiers.


  Resolver API

  sourceMapResolver.resolve(compiledUrl, generatedLine, generatedColumn)
    → { originalFile: string, originalLine: number } | null

  Failure modes:
    - No sourceMappingURL comment in source → null
    - Source map fetch failed → null
    - VLQ decode error → null  (malformed map; no exception propagated)
    - Segment not found at given position → null


  Integration with CSS Origin Tracker

  After Level 3 (fetch) acquisition, the tracker calls:

    const mapped = sourceMapResolver.resolve(
      sheetHref, lineNumber, columnNumber
    );
    if (mapped) {
      rule.originalFile = mapped.originalFile;
      rule.originalLine = mapped.originalLine;
      acquisition_level = 1;              // treated as Level 1 equivalent
      confidence = 1.00;
    }


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  EXTENSION F : Session Replay                                   [IMPLEMENTED]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Records a time-ordered sequence of agent actions and page state snapshots
  within a session and provides a replay mechanism that re-executes them.

  Scope: replay covers actions dispatched through executor.js (click, type,
  key, scroll, navigate).  It does not attempt to reproduce server-side state
  or network responses.


  Recording model

  Every ACTION_RESULT message currently recorded in cache-writer.js is
  extended with a SessionReplayEntry:

  {
    seq: number,                     // monotonically increasing per session
    timestamp: number,
    action: {                        // the original action payload
      type: string,
      selector: string | null,
      text: string | null,
      key: string | null,
      x: number | null,
      y: number | null
    },
    preStateHash: string,            // compositeHash before action
    postStateHash: string,           // compositeHash after action (300 ms settle)
    ok: boolean,
    errorType: string | null
  }

  Entries are appended to:
    cache/sessions/.../raw/replay/actions.jsonl  (newline-delimited JSON)


  Replay

  A replay run iterates actions.jsonl in seq order.  For each entry:

       1. Request current hash → compare to entry.preStateHash
            Match    → proceed
            Mismatch → divergence detected (see below)
       │
       2. Execute entry.action via action-executor.js
       │
       3. Wait 300 ms; request hash → compare to entry.postStateHash
            Match    → record { seq, status: "ok" }
            Mismatch → record { seq, status: "diverged", actualHash }
            Continue replay regardless (partial replay)


  Divergence semantics

  A state divergence at step N does not abort replay.  Remaining steps are
  attempted with the actual current state.  The replay report lists all
  divergences; the caller determines whether the replay is acceptable.

  Divergence causes include: server-side state change between sessions,
  network latency differences, non-deterministic page behavior.  Session
  Replay is not a correctness guarantee; it is a best-effort reproduction
  for debugging and agent training.


  MCP tool: replay_session

  Input:
  {
    tabId: number,
    sourceTabId: number,           // session whose actions.jsonl to replay
    fromSeq?: number,              // replay from this sequence number
    toSeq?: number,                // replay to this sequence number (inclusive)
    stopOnDivergence?: boolean     // default false
  }

  Output:
  {
    ok: boolean,
    totalSteps: number,
    successSteps: number,
    divergedSteps: number,
    divergences: [
      { seq, expectedHash, actualHash, actionType }
    ],
    durationMs: number
  }


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  EXTENSION G : Conclusion Cache                                 [IMPLEMENTED]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Avoids redundant re-computation of Intelligence Layer conclusions when
  the underlying data has not changed since the last compute.

  The bottleneck is explain_element, which triggers two on-demand collections
  (css-origin and framework-dom-map) and a causal chain lookup on each call.
  When the page state has not changed, the conclusions are identical to the
  previous call.


  Invalidation key

  A conclusion is valid as long as all of the following are unchanged:

    - compositeHash of the current state (from REQUEST_STATE_HASH)
    - contentHash of the CSS_ORIGIN_MAP file for the session
    - contentHash of the FRAMEWORK_DOM_MAP file for the session

  The invalidation key is the SHA-256 of the concatenation of these three
  values.


  Cache entry schema

  {
    invalidationKey: string,
    selector: string,
    computedAt: number,
    result: ExplainElementResponse
  }

  Storage: in-memory Map<selector, CacheEntry>, per tab.
  Capacity: 100 entries per tab, LRU eviction.
  Not persisted to disk; rebuilt on each server restart.


  Integration with explain_element

       compute invalidationKey
       │
       ├─ cache hit AND key matches     → return cached result immediately
       │
       └─ cache miss OR key mismatch    → run full collection + assembly
                                          store in cache; return result


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DEPENDENCY GRAPH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Extension A–G implementation status (v3):

    A (DOM_MUTATION Event)        → IMPLEMENTED — server/core.js handles, correlator processes
    B (@layer Cascade)            → IMPLEMENTED — css-origin.js full @layer flatten + registry
    C (State Graph Visualizer)    → IMPLEMENTED — server/state-visualizer.js
    D (Adaptive Collection)       → PROPOSAL (only remaining)
    E (Source Map Resolver)       → IMPLEMENTED — server/source-map-resolver.js
    F (Session Replay)            → IMPLEMENTED — server/session-replay.js
    G (Conclusion Cache)          → IMPLEMENTED — server/conclusion-cache.js
