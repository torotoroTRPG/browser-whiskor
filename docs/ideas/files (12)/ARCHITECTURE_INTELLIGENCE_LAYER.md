╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║                         browser-whiskor v4                                   ║
║                    Intelligence Layer Architecture                           ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝


  This document extends browser-whiskor v3 Architecture with the Intelligence
  Layer: a set of server-side and extension-side subsystems that transform raw
  collected data into deterministic conclusions before delivery to the agent.

  Design axiom: the agent receives conclusions, not raw material.  Every
  question the software can answer deterministically must be answered by the
  software.  Confidence values make the boundary explicit: 1.0 denotes a
  direct API query with no inference; values below 1.0 carry a stated basis.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LAYER OVERVIEW (updated)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 0 : LLM Agent                                                         │
│                                                                              │
│    Receives conclusions.  Does not receive raw JSON to interpret.            │
│    New tools: explain_element, why_did_this_change, analyze_click,           │
│    get_source_file, detect_site_updates.                                     │
│    Existing tools: click, right_click, get_css_analysis carry enriched       │
│    payloads.                                                                 │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │  MCP stdio (JSON-RPC 2.0)
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 1 : MCP Server  ( unchanged — see v3 Architecture )                   │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 2 : Intelligence Layer  ( new )                                       │
│                                                                              │
│  server/                                                                     │
│    correlator.js          ← Time-series Correlator                           │
│    source-store.js        ← Source file cache + hash registry                │
│                                                                              │
│  extension/injected/analyzers/                                               │
│    css-origin.js          ← CSS Origin Tracker                               │
│    clickability.js        ← Clickability Analyzer                            │
│    framework-dom-map.js   ← Framework↔DOM Mapper                             │
│    source-fetcher.js      ← Source Layer acquisition                         │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 3 : Server Core + Cache + State Graph  ( unchanged — see v3 )         │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 4 : Extension  ( unchanged — see v3 Architecture )                    │
└──────────────────────────────────────────────────────────────────────────────┘


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  INTELLIGENCE LAYER — SUBSYSTEM OVERVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Subsystem                  Location         Answers                    │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  CSS Origin Tracker         extension         Which stylesheet rule      │
  │                                              applies to a given element, │
  │                                              and from which source file. │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  Source Layer               extension         Actual text content of CSS │
  │                             + server          and JS files referenced    │
  │                                              by the page.                │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  Time-series Correlator     server            Which network response     │
  │                                              caused which DOM mutation   │
  │                                              and style recomputation.    │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  Framework↔DOM Mapper       extension         Which framework component  │
  │                                              owns a given DOM node.      │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  Clickability Analyzer      extension         Whether a target element   │
  │                                              can receive a click, why it │
  │                                              cannot, and what action     │
  │                                              must precede it.            │
  └─────────────────────────────────────────────────────────────────────────┘

  Each subsystem operates through a fallback chain.  Each level of the chain
  is attempted in order; the highest level successfully reached is recorded
  in the output as acquisition_level.  Subsystems degrade gracefully: a
  lower-level result with a lower confidence value is always preferable to
  returning no result.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SUBSYSTEM 1 : CSS ORIGIN TRACKER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Answers: for a given DOM element, which CSS rule determines each computed
  property value, and from which source file does that rule originate?

  Location: extension/injected/analyzers/css-origin.js
  Emit type: CSS_ORIGIN_MAP  (new)
  Runs at:   on-demand (triggered by agent tool call or MANUAL_COLLECT)


  Source acquisition fallback chain
  ─────────────────────────────────

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Level 1 — chrome.devtools.inspectedWindow.getResources()               │
  │                                                                          │
  │  Precondition: the DevTools panel is open and the extension has a       │
  │  devtools_page context.  Not callable from the injected content world;  │
  │  invoked via message relay through background/sw.js.                    │
  │                                                                          │
  │  Capability: full source text of all page resources regardless of       │
  │  origin.  Bypasses CORS.  Provides uncompressed source even for         │
  │  cross-origin stylesheets served without CORS headers.                  │
  │                                                                          │
  │  acquisition_level = 1                                                  │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Level 2 — document.styleSheets[i].cssRules traversal                   │
  │                                                                          │
  │  Available when: same-origin stylesheet, or cross-origin stylesheet     │
  │  served with Access-Control-Allow-Origin.                               │
  │                                                                          │
  │  Capability: full rule text via cssText, selectorText, style.*          │
  │  properties.  Original source line numbers are not available.           │
  │                                                                          │
  │  CORS-blocked sheets: styleSheet.cssRules === null.  The tracker        │
  │  records { blocked: true, reason: "CORS" } and falls through to         │
  │  Level 3 for that sheet only.                                           │
  │                                                                          │
  │  acquisition_level = 2                                                  │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Level 3 — fetch(styleSheet.href)                                        │
  │                                                                          │
  │  Available when: the stylesheet URL responds to a fetch with a          │
  │  permissive CORS policy or is same-origin.  The tracker inspects the    │
  │  Access-Control-Allow-Origin response header before committing to a     │
  │  full read.                                                             │
  │                                                                          │
  │  Request options: { credentials: 'omit', cache: 'no-store' }           │
  │  Failure modes: 4xx/5xx, network error, CORS rejection → Level 4.      │
  │                                                                          │
  │  Capability: full source text.  Rule-to-line mapping requires text      │
  │  search on the fetched content; no CSSOM reflection is available.       │
  │                                                                          │
  │  acquisition_level = 3                                                  │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Level 4 — URL and inline record only                                    │
  │                                                                          │
  │  Always available.  Records the stylesheet href, or the string          │
  │  "inline" for <style> elements, together with the sheet index.          │
  │  No rule text is available at this level.                               │
  │                                                                          │
  │  acquisition_level = 4                                                  │
  └─────────────────────────────────────────────────────────────────────────┘


  Rule matching algorithm
  ───────────────────────

  Given target element el and property name prop:

       1. window.getComputedStyle(el)[prop]           → computed value V
       │
       ├─ Inline style: el.style[prop] !== ""?
       │     YES → { source: "inline", specificity: [1,0,0,0], confidence: 1.0 }
       │           Remaining steps skipped.
       │
       ├─ Iterate document.styleSheets in reverse source order
       │   (later sheets have higher precedence at equal specificity)
       │
       ├─ For each CSSStyleRule r in sheet.cssRules:
       │     el.matches(r.selectorText) ?
       │       YES → r declares prop?
       │               YES → candidate: { rule: r, specificity: S(r.selectorText) }
       │               NO  → skip
       │       NO  → skip
       │
       ├─ Sort candidates descending by [specificity, source_order]
       │
       ├─ Winner = candidates[0]
       │     Verify: winner.style[prop] === V  (after normalization)
       │     Mismatch → source is inherited or UA stylesheet
       │
       └─ No candidate or mismatch:
             { source: "inherited" | "user-agent", confidence: 0.85 }

  Specificity computation  (no external library)

    S(selectorText) → [id_count, class_attr_pseudo_count, element_count]
    Single regex pass over the selector string.
    Packed into a 32-bit integer: id×65536 + (class+attr+pseudo)×256 + element.

    Pseudo-elements (::before, ::after): count as one element.
    :not()    — contents are counted; :not() wrapper is not.
    :is()     — contributes the highest specificity among its arguments.
    :where()  — contributes zero specificity.


  Confidence values
  ─────────────────

    Inline style                                                → 1.00
    acquisition_level = 1, source map resolved                 → 1.00
    acquisition_level = 1, no source map                       → 0.97
    acquisition_level = 2, same-origin cssRules                → 0.93
    acquisition_level = 3, fetch succeeded                     → 0.88
    acquisition_level = 4, URL only                            → 0.40
    Inherited / UA stylesheet                                  → 0.85
    Specificity tie among candidates (adjustment)              → −0.08

  When multiple properties are returned in a single CSSStyleOriginMap, each
  property carries its own confidence value.  The map-level confidence field
  is the minimum across all property confidences.

  CSS @layer (Cascade Layers) — known gap: see KNOWN LIMITATIONS.


  Output schema (CSSStyleOriginMap)
  ───────────────────────────────────

  Emitted as CSS_ORIGIN_MAP via the standard plugin emit path.

  {
    type: "CSS_ORIGIN_MAP",
    tabId: number,
    timestamp: number,
    element: {
      selector: string,
      tag: string,
      id: string | null,
      classList: string[]
    },
    properties: {
      [propName: string]: {
        computedValue: string,
        source: "rule" | "inline" | "inherited" | "user-agent",
        rule: {
          selectorText: string,
          ruleText: string,
          specificity: number,
          sheetHref: string | null,
          sheetIndex: number,
          ruleIndex: number,
          sourceLine: number | null,
          originalFile: string | null,
          originalLine: number | null
        } | null,
        acquisition_level: 1 | 2 | 3 | 4,
        confidence: number
      }
    },
    map_confidence: number
  }


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SUBSYSTEM 2 : SOURCE LAYER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Answers: what is the text content of a CSS or JS file referenced by the
  current page, and has it changed since the last session?

  Scope: text-bearing resources only.  MIME types accepted:
    text/css, text/javascript, application/javascript, application/x-javascript.
  Binary and image assets are excluded.

  Location (extension): extension/injected/analyzers/source-fetcher.js
  Location (server):    server/source-store.js
  Emit type:            SOURCE_CONTENT  (new; replaces SOURCE_CATALOG for text)


  Acquisition
  ───────────

  source-fetcher.js runs after SOURCE_CATALOG is populated.  It iterates
  catalog entries and attempts acquisition at the highest available level,
  mirroring the CSS Origin Tracker fallback chain (Levels 1–4).

  CSS files: fetched and stored in full.
  Size cap: config.plugins.sourceFetcher.maxCssSizeBytes  (default: 512 KB).
  Files exceeding the cap are stored as hash-only.

  JS files: hash-only by default.  Full-text storage is opt-in:
  config.plugins.sourceFetcher.storeJs = true.
  Rationale: bundled JS files commonly range from 500 KB to several MB per
  chunk.  Full-text storage for all chunks at every session is impractical.
  The hash is sufficient for update detection.  Full text is available on
  explicit agent request via get_source_file.


  Hash-based update detection
  ────────────────────────────

  On first acquisition for a URL:

    { url, sha256, byteLength, acquiredAt, sessionId }

  stored in server/source-store.js, persisted to cache/sources/hashes.json.

  On subsequent sessions: the URL is re-fetched.  ETag-based conditional
  GET (If-None-Match) is used when a prior ETag was recorded; otherwise
  unconditional.  If the SHA-256 differs from the stored value, the tracker
  emits SOURCE_CHANGED:

  {
    type: "SOURCE_CHANGED",
    url: string,
    previousHash: string,
    currentHash: string,
    previousAcquiredAt: number,
    detectedAt: number,
    byteLength: { previous: number, current: number }
  }

  SOURCE_CHANGED is included in the get_index response and accessible via
  the detect_site_updates MCP tool.


  Storage layout
  ──────────────

    cache/sessions/{siteVersion}/{tabId}-{sessionId}/
      raw/sources/
        catalog.json             ← existing: URL list (SOURCE_CATALOG)
        content/
          {sha256[0..7]}.css     ← CSS source text
          {sha256[0..7]}.js      ← JS source text (if storeJs = true)

    cache/sources/
      hashes.json                ← cross-session URL → hash registry


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SUBSYSTEM 3 : TIME-SERIES CORRELATOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Answers: which network response caused which DOM mutation, and which
  framework state update mediated the relationship?

  Location: server/correlator.js
  Input:    timestamped events from the existing server/index.js WebSocket stream
  Output:   CausalChain objects stored in session cache


  CorrelationBuffer
  ─────────────────

  Per-tab ring buffer of received events.

    Capacity:        200 events per tab
    Retention:       5 000 ms from event timestamp
    Overflow policy: evict oldest event
    Thread model:    Node.js event loop; no concurrent access


  Event types consumed
  ─────────────────────

  All event types carry timestamp: number in their existing schema.

    NETWORK_RESPONSE       { requestId, url, status, responseKeys[], timestamp }
    REACT_SNAPSHOT         { rootComponents[], timestamp }
    VUE_SNAPSHOT           { components[], timestamp }
    TEXT_COORD_DELTA       { deltas[], timestamp }
    EXPLORER_STATE_UPDATE  { compositeHash, timestamp }

  DOM mutation proxy: TEXT_COORD_DELTA is used as the DOM mutation signal.
  It carries per-element coordinate deltas with timestamps, enabling temporal
  correlation without a dedicated mutation event.  Coverage gap: attribute-only
  mutations and invisible insertions are not observed through this proxy.
  A dedicated DOM_MUTATION event type is recorded as a future improvement
  (see KNOWN LIMITATIONS).


  Correlation rules
  ─────────────────

  Rules are evaluated in listed order.  A single DOM mutation event may match
  multiple rules; all matching chains are recorded.

  Rule 1 — Network → DOM
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Trigger:   NETWORK_RESPONSE followed by TEXT_COORD_DELTA               │
  │  Window:    deltaMs ≤ 500                                               │
  │  Confidence base:  0.70                                                 │
  │  Adjustments:                                                           │
  │    deltaMs ≤  50 ms                        → +0.15                     │
  │    deltaMs ≤ 150 ms                        → +0.08                     │
  │    responseKeys ∩ affectedTextTokens ≠ ∅   → +0.10                     │
  │    status ≠ 200                            → −0.10                     │
  │  Minimum reported confidence: 0.50                                      │
  └─────────────────────────────────────────────────────────────────────────┘

  Rule 2 — Framework update → DOM
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Trigger:   REACT_SNAPSHOT or VUE_SNAPSHOT followed by TEXT_COORD_DELTA │
  │  Window:    deltaMs ≤ 100                                               │
  │  Confidence base:  0.85                                                 │
  │  Adjustments:                                                           │
  │    Framework↔DOM linkage confirmed by Subsystem 4     → 1.00            │
  │    deltaMs ≤ 20 ms                                    → +0.08           │
  │    Multiple components updated simultaneously         → −0.05           │
  └─────────────────────────────────────────────────────────────────────────┘

  Rule 3 — Network → Framework → DOM  (composed chain)
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Trigger:   Rule 1 chain AND Rule 2 chain where the Rule 2 framework    │
  │             event falls within the Rule 1 window                        │
  │  Confidence: min(Rule1.confidence, Rule2.confidence) + 0.05             │
  └─────────────────────────────────────────────────────────────────────────┘


  False-positive mitigation
  ──────────────────────────

  Background polling:  requests with the same URL recurring at a regular
    interval — ≥ 3 occurrences, coefficient of variation of inter-arrival
    time < 0.15 — are tagged { pollingCandidate: true }.  Their correlation
    confidence is halved.

  Scroll-only deltas:  TEXT_COORD_DELTA events that the Delta Engine has
    classified as scroll-only motion are excluded from correlation.

  Confidence floor:  chains with final confidence < 0.50 are discarded.
    Sub-threshold chains are never written to cache.


  CausalChain schema
  ───────────────────

  {
    id: string,                    // sha256(events joined)[0..8]
    rule: 1 | 2 | 3,
    confidence: number,            // 0.50 – 1.00
    network: {
      requestId: string,
      url: string,
      method: string,
      status: number,
      deltaMs: number
    } | null,
    framework: {
      type: "react" | "vue" | "angular" | "svelte" | "solid" | "other",
      components: string[],
      deltaMs: number
    } | null,
    dom: {
      affectedCount: number,
      sampleSelectors: string[],   // up to 3 computed selectors
      deltaMs: number
    },
    timestamp: number,
    sessionId: string
  }

  Stored at: cache/sessions/.../raw/intelligence/causal-chains.json
  Capacity:  500 chains per session, LRU eviction on overflow.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SUBSYSTEM 4 : FRAMEWORK↔DOM MAPPER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Answers: which framework component owns a given DOM node, and what are
  that component's current props and state?

  Location: extension/injected/analyzers/framework-dom-map.js
  Emit type: FRAMEWORK_DOM_MAP  (new)
  Runs at:   on-demand, triggered by CSS_ORIGIN_MAP or agent request


  Per-framework acquisition
  ──────────────────────────

  React  (via bundled bippy.iife.js)
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  const fiberKey = Object.keys(el).find(                                 │
  │    k => k.startsWith('__reactFiber') || k.startsWith('__reactInternals')│
  │  );                                                                      │
  │  const fiber = el[fiberKey];                                             │
  │                                                                          │
  │  Component name: walk fiber.return until fiber.type is a function or    │
  │  class.  Prefer fiber.type.displayName, then fiber.type.name.           │
  │  Anonymous: "(anonymous)".                                               │
  │                                                                          │
  │  Props:  fiber.memoizedProps  (shallow copy)                            │
  │  State:  fiber.memoizedState  (linked list; first hook value)           │
  │                                                                          │
  │  Source location: fiber.type._debugSource                               │
  │    { fileName, lineNumber, columnNumber }                                │
  │    Present in development builds; absent in production.                 │
  │                                                                          │
  │  Confidence: 1.00  (Fiber reference is a direct pointer)               │
  └─────────────────────────────────────────────────────────────────────────┘

  Vue 3
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  const vueKey = Object.keys(el).find(                                   │
  │    k => k.startsWith('__vueParentComponent')                            │
  │  );                                                                      │
  │  const instance = el[vueKey];                                            │
  │                                                                          │
  │  Name:  instance.type.__name || instance.type.name                      │
  │  Props: instance.props                                                   │
  │  State: instance.setupState  (Composition API)                          │
  │         instance.data        (Options API)                               │
  │                                                                          │
  │  Confidence: 0.97                                                        │
  └─────────────────────────────────────────────────────────────────────────┘

  Angular  (Ivy renderer)
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  ng.getComponent(el)       → component instance                         │
  │  ng.getOwningComponent(el) → nearest component host                     │
  │                                                                          │
  │  Available in both dev and production builds.                           │
  │                                                                          │
  │  Confidence: 0.98                                                        │
  └─────────────────────────────────────────────────────────────────────────┘

  Svelte
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  el.__svelte_meta → { loc: { file, line, char } }                       │
  │  Available in development builds only (Svelte 4+).                      │
  │                                                                          │
  │  Production: no DOM annotation; fallback to Level 5.                    │
  │                                                                          │
  │  Confidence: 0.95 (dev) / 0.00 (production)                             │
  └─────────────────────────────────────────────────────────────────────────┘

  No framework / unknown
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  component: null                                                         │
  │  DOM node position in tree is recorded.                                 │
  │  Confidence: 0.00                                                        │
  └─────────────────────────────────────────────────────────────────────────┘


  Acquisition level priority

    Level 1: React Fiber        __reactFiber / __reactInternals   → 1.00
    Level 2: Vue 3              __vueParentComponent               → 0.97
    Level 3: Angular            ng.getComponent()                  → 0.98
    Level 4: Svelte dev         __svelte_meta                      → 0.95
    Level 5: No framework       DOM position only                  → 0.00


  Output schema (FrameworkDomEntry)

  {
    domSelector: string,
    component: {
      name: string | null,
      framework: "react" | "vue3" | "vue2" | "angular" | "svelte"
                 | "preact" | "solid" | "alpine" | null,
      props: object | null,
      state: object | null,
      sourceFile: string | null,
      sourceLine: number | null,
      confidence: number
    },
    acquisitionLevel: 1 | 2 | 3 | 4 | 5
  }


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SUBSYSTEM 5 : CLICKABILITY ANALYZER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Produces a structured report before and after each click attempt, giving
  the agent a deterministic account of why a click failed and what action
  must precede it.

  Location: extension/injected/analyzers/clickability.js
  Invoked by: extension/injected/executor.js  (pre- and post-click)
  Not a standalone plugin; does not emit a message type.
  Output is embedded in the ACTION_RESULT message returned by executor.js.


  Pre-click checks
  ─────────────────

  All checks use synchronous DOM/CSSOM APIs.

  Check 1 — Existence
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  el !== null && document.contains(el)                                   │
  │  Failure: { exists: false }. Remaining checks skipped.                  │
  └─────────────────────────────────────────────────────────────────────────┘

  Check 2 — Visibility
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  cs = window.getComputedStyle(el)                                       │
  │  visible = cs.display !== 'none'                                        │
  │         && cs.visibility !== 'hidden'                                   │
  │         && cs.visibility !== 'collapse'                                 │
  │         && parseFloat(cs.opacity) > 0                                   │
  │                                                                          │
  │  Ancestor walk: a hidden ancestor makes the element invisible           │
  │  regardless of its own computed style.                                  │
  │  Walk limit: 32 ancestor levels.                                        │
  │                                                                          │
  │  Failure: { visible: false, hiddenBy: { selector, property, value } }  │
  └─────────────────────────────────────────────────────────────────────────┘

  Check 3 — Viewport presence
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  rect = el.getBoundingClientRect()                                      │
  │  inViewport = rect.width > 0 && rect.height > 0                         │
  │            && rect.bottom > 0 && rect.right > 0                         │
  │            && rect.top  < window.innerHeight                            │
  │            && rect.left < window.innerWidth                             │
  │                                                                          │
  │  Failure: { inViewport: false, rect }.                                  │
  │  The executor attempts scrollIntoView before proceeding.                │
  └─────────────────────────────────────────────────────────────────────────┘

  Check 4 — Pointer events
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  cs.pointerEvents === 'none'                                            │
  │  Applied to element and ancestors (same walk as Check 2).               │
  │  An ancestor with pointer-events: none blocks all descendants.          │
  │                                                                          │
  │  Failure: { pointerEventsEnabled: false, blockedBy: { selector } }     │
  │  Strategy implication: 'direct' or 'programmatic' required.             │
  └─────────────────────────────────────────────────────────────────────────┘

  Check 5 — Disabled state
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  disabled = el.disabled === true                                        │
  │          || el.getAttribute('aria-disabled') === 'true'                │
  │          || el.getAttribute('disabled') !== null                        │
  │                                                                          │
  │  Failure: { disabled: true, canAutoFix: false }.                        │
  └─────────────────────────────────────────────────────────────────────────┘

  Check 6 — Obstruction  (hit-test)
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  rect  = el.getBoundingClientRect()                                     │
  │  cx    = rect.left + rect.width  / 2                                   │
  │  cy    = rect.top  + rect.height / 2                                   │
  │  topEl = document.elementFromPoint(cx, cy)                              │
  │                                                                          │
  │  obstructed = topEl !== null                                            │
  │            && !el.contains(topEl)                                       │
  │            && el !== topEl                                              │
  │                                                                          │
  │  When obstructed:                                                       │
  │    Walk topEl ancestors.  A match against the obstruction pattern set   │
  │    (see CONFIG ADDITIONS) sets obstructorInfo.isModal = true.           │
  │                                                                          │
  │  Obstruction pattern set (configurable):                                │
  │    ARIA roles:  [role="dialog"], [role="alertdialog"]                   │
  │    Structural:  [role="presentation"], [aria-modal="true"]              │
  │    CSS classes: configurable via                                        │
  │                 config.intelligence.clickability.obstructionPatterns    │
  │    Default class patterns: .modal, .overlay, .backdrop, [data-modal]   │
  │                                                                          │
  │  Note: elementFromPoint uses the center of the bounding rect.           │
  │  Non-rectangular elements (clip-path, border-radius) may not have       │
  │  their hit region centered at the geometric center.                     │
  └─────────────────────────────────────────────────────────────────────────┘


  ObstructorInfo schema

  {
    topElement: string,
    tag: string,
    text: string,                  // textContent, trimmed, max 120 chars
    rect: DOMRect,
    isModal: boolean,
    modalType: "dialog" | "alertdialog" | "popover" | "custom" | null,
    hasCloseButton: boolean,
    closeButtonSelector: string | null,
    escapeDismissible: boolean
  }

  Close button detection:
    Query within the obstructor element against:
      [aria-label*="close" i], [data-dismiss],
      button.close, .modal-close, .dialog-close,
      button:has(svg)            ← trailing icon button, common pattern
    Additional patterns configurable via
      config.intelligence.clickability.closeButtonPatterns.
    First match → closeButtonSelector.  No match → hasCloseButton: false.


  Click strategies
  ─────────────────

  ┌──────────────────┬───────────────────────────────────────────────────┐
  │  Strategy        │  Mechanism                                        │
  ├──────────────────┼───────────────────────────────────────────────────┤
  │  native          │  Dispatch MouseEvent sequence:                    │
  │  (default)       │  pointerover → mouseover → pointermove →         │
  │                  │  mousemove → pointerdown → mousedown →           │
  │                  │  pointerup → mouseup → click                     │
  │                  │  bubbles: true, cancelable: true                  │
  │                  │  clientX/Y from getBoundingClientRect center      │
  ├──────────────────┼───────────────────────────────────────────────────┤
  │  direct          │  el.click()                                       │
  │                  │  Bypasses pointer-events: none.                   │
  │                  │  Crosses Shadow DOM boundaries.                   │
  │                  │  Does not synthesize full mouse event chain.      │
  ├──────────────────┼───────────────────────────────────────────────────┤
  │  programmatic    │  React: fiber.memoizedProps.onClick?.({...})      │
  │                  │  Vue:   instance.vnode.props?.onClick?.()         │
  │                  │  Invokes the framework handler directly.          │
  │                  │  Browser-native behaviors (form submit, link nav) │
  │                  │  are not triggered.  Recorded in diagnosis as     │
  │                  │  unexpectedBehavior: "default_prevented".         │
  ├──────────────────┼───────────────────────────────────────────────────┤
  │  force           │  1. Set obstructors: el.style.display = 'none'   │
  │                  │  2. Execute 'native' on target                    │
  │                  │  3. Restore: el.style.display = ''               │
  │                  │  Used only when all unblock attempts have failed. │
  └──────────────────┴───────────────────────────────────────────────────┘

  Strategy selection

    Condition                                    Recommended
    ──────────────────────────────────────────   ──────────────────────
    All checks pass                              native
    pointer-events: none                         direct → programmatic
    Obstructed, canAutoFix = true                unblock → native
    Obstructed, canAutoFix = false               report only
    el.getRootNode() instanceof ShadowRoot       direct
    disabled = true                              none (report only)


  Auto-unblock pipeline
  ──────────────────────

  Executed only when obstructed = true AND isModal = true.
  Attempted in order; stops at first success.

       Step 1: Click closeButtonSelector  (if hasCloseButton = true)
       │         Confirm: obstructor removed from DOM or no longer visible
       │
       Step 2: Dispatch KeyboardEvent 'Escape' on document
       │         Confirm: obstructor removed/hidden within 300 ms
       │
       Step 3: Click the backdrop element
       │         Pattern-matched against config.intelligence.clickability
       │           .backdropPatterns  (defaults: [data-overlay], .backdrop,
       │           computed backdrop sibling of the dialog element)
       │         Confirm: as Step 2
       │
       Step 4: canAutoFix = false, fixResult = "all_steps_failed"
               Return report; target click is not attempted.

  Step confirmation: 300 ms MutationObserver scoped to the obstructor.
  Success criterion: obstructor removed from DOM or computed display = 'none'.


  Post-click diagnosis
  ─────────────────────

  diagnoseClickResult(target, preClickFingerprint) → ClickDiagnosis
  Executed 100 ms after click dispatch.

  {
    clickLanded: boolean,
    whatReceivedClick: {
      selector: string,
      isTarget: boolean
    },
    stateChanged: boolean,         // compositeHash differs from pre-click
    popupAppeared: boolean,        // new [role="dialog"] within 300 ms
    popupInfo: ObstructorInfo | null,
    unexpectedBehavior:
      null
      | "modal_appeared"
      | "click_intercepted"
      | "no_state_change"
      | "navigation_triggered"
      | "default_prevented"
  }


  Full ClickabilityReport schema

  {
    exists: boolean,
    visible: boolean,
    hiddenBy: { selector, property, value } | null,
    inViewport: boolean,
    rect: DOMRect | null,
    pointerEventsEnabled: boolean,
    pointerEventsBlockedBy: { selector } | null,
    disabled: boolean,
    obstructed: boolean,
    obstructedBy: ObstructorInfo | null,
    canAutoFix: boolean,
    fixAttempted: boolean,
    fixStepsAttempted: number,
    fixResult: "success" | "all_steps_failed" | "not_attempted" | null,
    recommendedStrategy: "native" | "direct" | "programmatic" | "force" | "none",
    strategyUsed:        "native" | "direct" | "programmatic" | "force" | "none" | null,
    diagnosis: ClickDiagnosis | null
  }


  executor.js integration

       analyzeClickability(el)
       │
       ├─ exists = false      → ACTION_RESULT { ok: false, error: "not_found",
       │                                        clickability: report }
       │
       ├─ disabled = true     → ACTION_RESULT { ok: false, error: "disabled",
       │                                        clickability: report }
       │
       ├─ obstructed = true   → runAutoUnblock()
       │     success           → re-analyze; proceed with native
       │     failure           → ACTION_RESULT { ok: false, error: "obstructed",
       │                                        clickability: report }
       │
       ├─ !inViewport         → scrollIntoView({ behavior:'instant', block:'center' })
       │                         re-check; if still false → report
       │
       ├─ strategy = selectStrategy(report)
       │
       ├─ execute strategy
       │
       ├─ diagnoseClickResult(el, preClickHash)
       │
       └─ ACTION_RESULT {
               ok: boolean,
               clickability: report,
               diagnosis: diagnosis
            }

  Backward compatibility: agents that do not consume clickability or
  diagnosis fields are unaffected.  The ok field remains the primary
  success indicator.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CONFIDENCE SCORING — UNIFIED REFERENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┌───────────────────────────────────────────────────────────────────┬───────┐
  │  Source                                                           │ Value │
  ├───────────────────────────────────────────────────────────────────┼───────┤
  │  CSS: inline style                                                │  1.00 │
  │  CSS: getResources() + source map resolved                        │  1.00 │
  │  CSS: getResources(), no source map                               │  0.97 │
  │  CSS: same-origin cssRules                                        │  0.93 │
  │  CSS: fetch() succeeded                                           │  0.88 │
  │  CSS: inherited / UA stylesheet                                   │  0.85 │
  │  CSS: URL only                                                    │  0.40 │
  │  CSS: specificity tie (adjustment)                                │ −0.08 │
  ├───────────────────────────────────────────────────────────────────┼───────┤
  │  Framework: React Fiber direct                                    │  1.00 │
  │  Framework: Angular ng.getComponent()                             │  0.98 │
  │  Framework: Vue 3 __vueParentComponent                            │  0.97 │
  │  Framework: Svelte __svelte_meta (dev)                            │  0.95 │
  │  Framework: Svelte (production) / no framework                    │  0.00 │
  ├───────────────────────────────────────────────────────────────────┼───────┤
  │  Correlation: Rule 2 + Framework↔DOM confirmed                    │  1.00 │
  │  Correlation: Rule 2 base                                         │  0.85 │
  │  Correlation: Rule 1, deltaMs ≤ 50 ms                             │  0.85 │
  │  Correlation: Rule 1 base, deltaMs ≤ 500 ms                       │  0.70 │
  │  Correlation: polling candidate (halved)                          │  var  │
  │  Correlation: floor (chains below discarded)                      │  0.50 │
  └───────────────────────────────────────────────────────────────────┴───────┘

  Confidence values are not combined across subsystems.  Each subsystem's
  value is reported independently.  The MCP conclusion tools (explain_element,
  why_did_this_change) present each confidence value alongside the claim
  it qualifies.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DATA FLOW: explain_element
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Agent calls explain_element(tabId, selector)
       │
       ▼
  MCP tool handler
       │
       ├─ [1] Trigger on-demand collection:
       │       MANUAL_COLLECT → extension: run css-origin, framework-dom-map
       │       Wait for CSS_ORIGIN_MAP and FRAMEWORK_DOM_MAP  (timeout: 8 s)
       │
       ├─ [2] Read from session cache:
       │       CSS_ORIGIN_MAP for selector (or nearest ancestor match)
       │       FRAMEWORK_DOM_MAP for selector
       │       causal-chains.json: chains whose sampleSelectors include selector
       │
       ├─ [3] Assemble ExplainElementResponse:
       │       {
       │         element: { selector, tag, text },
       │         styles: [ { property, value, rule, source, confidence } ],
       │         component: { name, framework, props, state, confidence },
       │         causedBy: [ CausalChain ],
       │         map_confidence: number
       │       }
       │
       └─ [4] Return to agent


  Agent calls why_did_this_change(tabId, selector, sinceMs=5000)
       │
       ├─ [1] Read causal-chains.json
       │       Filter: timestamp > (now − sinceMs)
       │               AND selector in chain.dom.sampleSelectors
       │
       ├─ [2] Sort by confidence descending
       │
       └─ [3] Return top-3 chains with full detail


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  MCP TOOL ADDITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  New tools registered in server/mcp/tools/intelligence.js  (new file).
  Profile: 'intelligence'  (except analyze_click: 'core').

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Tool                  Profile          Description                      │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  explain_element       intelligence     CSS origin + component + causal  │
  │                                        chain for a selector.            │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  why_did_this_change   intelligence     Causal chains for a selector     │
  │                                        within a time window.            │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  analyze_click         core             Dry-run clickability analysis.   │
  │                                        Returns ClickabilityReport        │
  │                                        without executing the click.     │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  get_source_file       intelligence     Text content of a CSS or JS file │
  │                                        by URL.  Uses Source Layer cache; │
  │                                        fetches on miss.                 │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  detect_site_updates   intelligence     SOURCE_CHANGED events since last  │
  │                                        session.                          │
  └─────────────────────────────────────────────────────────────────────────┘

  Existing tools with enriched return values:

    click        → ACTION_RESULT now includes clickability + diagnosis fields
    right_click  → same
    get_css_analysis → existing shallow analysis unchanged; css_origin_map
                       field added (null if not yet collected)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PLUGIN SYSTEM EXTENSIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  The existing plugin-system.js plugin contract is extended with two fields:

    dependencies: string[]    // plugin IDs that must be installed first
    acquisitionLevel: number  // max level to attempt (1–4); default 4

  installAll() performs a topological sort on the dependency graph before
  installation.  Cycles are detected and reported as startup errors.

  New plugin registrations:

    { id: 'css-origin',        runAt: 'load', emitType: 'CSS_ORIGIN_MAP',
      dependencies: ['css'],   acquisitionLevel: 4 }

    { id: 'source-fetcher',    runAt: 'load', emitType: 'SOURCE_CONTENT',
      dependencies: ['sources'], acquisitionLevel: 4 }

    { id: 'framework-dom-map', runAt: 'load', emitType: 'FRAMEWORK_DOM_MAP',
      dependencies: [],        acquisitionLevel: 5 }

  css-origin depends on 'css' to reuse the stylesheet URL list populated by
  the existing CSS analyzer.

  Clickability Analyzer and Time-series Correlator are not plugins.
  Clickability is invoked inline by executor.js.  The Correlator is a
  server-side subsystem with no extension-side registration.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CONFIG ADDITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  New section in config.json under plugins.intelligence:

  "intelligence": {
    "cssOrigin": {
      "enabled": true,
      "maxPropertiesPerElement": 20,
      "maxElements": 50,
      "acquisitionLevel": 4
    },
    "sourceFetcher": {
      "enabled": true,
      "storeJs": false,
      "maxCssSizeBytes": 524288,
      "updateDetection": true
    },
    "correlator": {
      "enabled": true,
      "bufferCapacityPerTab": 200,
      "retentionMs": 5000,
      "confidenceFloor": 0.50,
      "maxChainsPerSession": 500
    },
    "frameworkDomMap": {
      "enabled": true
    },
    "clickability": {
      "enabled": true,
      "autoUnblock": true,
      "autoUnblockStrategies": ["closeButton", "escape", "backdrop"],
      "obstructionPatterns": [
        "[role=\"dialog\"]", "[role=\"alertdialog\"]",
        "[aria-modal=\"true\"]", ".modal", ".overlay", ".backdrop",
        "[data-modal]"
      ],
      "backdropPatterns": [".backdrop", "[data-overlay]"],
      "closeButtonPatterns": [
        "[aria-label*=\"close\" i]", "[data-dismiss]",
        "button.close", ".modal-close", ".dialog-close", "button:has(svg)"
      ]
    }
  }

  All intelligence subsystems default to enabled: true.
  Individual subsystems may be disabled without affecting others.
  obstructionPatterns, backdropPatterns, and closeButtonPatterns are
  configurable selector arrays; defaults are listed above and cover the
  common cross-library patterns.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STORAGE LAYOUT ADDITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    cache/sessions/{siteVersion}/{tabId}-{sessionId}/
      raw/
        intelligence/
          css-origin-map.json       ← latest CSSStyleOriginMap per session
          framework-dom-map.json    ← latest FrameworkDomEntry[] per session
          causal-chains.json        ← CausalChain[] (max 500, LRU)
        sources/
          catalog.json              ← existing SOURCE_CATALOG (URL list)
          content/
            {sha256[0..7]}.css      ← CSS source text
            {sha256[0..7]}.js       ← JS source text (if storeJs = true)

    cache/sources/
      hashes.json                   ← cross-session { url → { sha256, ... } }


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FILE MAP ADDITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server/
    correlator.js                  — Time-series Correlator, CorrelationBuffer
    source-store.js                — Source file text cache + hash registry
    mcp/tools/
      intelligence.js              — explain_element, why_did_this_change,
                                     analyze_click, get_source_file,
                                     detect_site_updates

  extension/injected/analyzers/
    css-origin.js                  — CSS Origin Tracker, rule matching,
                                     specificity computation, CSSStyleOriginMap
    source-fetcher.js              — Source Layer acquisition (Levels 1–4)
    framework-dom-map.js           — Framework↔DOM Mapper, FrameworkDomEntry
    clickability.js                — ClickabilityReport, ObstructorInfo,
                                     analyzeClickability(), diagnoseClickResult(),
                                     auto-unblock pipeline


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  KNOWN LIMITATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  CSS @layer and @scope  (Cascade Layers, CSS Scoping)
    @layer ordering overrides specificity-based cascade order.  The current
    specificity computation does not account for @layer sequence.  A rule in
    a later-declared @layer wins over an equal-specificity rule in an earlier
    layer.  Effect: the tracker reports the correct computed value from
    getComputedStyle but the winning-rule identification may be incorrect for
    layered stylesheets.
    Resolution path: post-process candidates against CSSLayerStatementRule
    order before winner selection.

  Time-series Correlator — DOM mutation proxy precision
    TEXT_COORD_DELTA is used as the DOM mutation proxy.  It reflects visual
    coordinate changes, not MutationObserver events.  Attribute-only mutations
    and invisible insertions are not captured.  Introducing a dedicated
    DOM_MUTATION event type emitted directly from a MutationObserver in
    extension/injected/analyzers/dom-mutations.js would improve coverage.

  Framework↔DOM Mapper — Svelte production builds
    Svelte production builds do not emit __svelte_meta annotations.  The
    mapper falls back to acquisition level 5 (DOM position only) for
    production Svelte applications.  No workaround exists without modifying
    the Svelte compilation output.

  Time-series Correlator — async renders
    Async rendering (React concurrent mode, Vue async components) may produce
    DOM mutations substantially after the triggering network response.  The
    500 ms window (Rule 1) is intentionally wide to accommodate this.

  Clickability Analyzer — programmatic strategy and browser defaults
    The programmatic click strategy invokes the framework event handler
    directly.  Browser-native behaviors coupled to the full event dispatch
    chain (form validation, link navigation, drag-and-drop defaults) are not
    triggered.  The diagnosis field records unexpectedBehavior:
    "default_prevented" when this strategy is used.

  Clickability Analyzer — non-rectangular hit regions
    Check 6 uses the geometric center of getBoundingClientRect.  Elements
    with non-rectangular hit regions (CSS clip-path, custom shapes) may not
    be hit-tested correctly at their center.
