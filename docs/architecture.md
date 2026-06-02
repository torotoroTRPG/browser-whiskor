# browser-whiskor v3 — Architecture

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║                         browser-whiskor v3                                   ║
║                    Agent-Grade Browser Instrumentation                       ║
║                              Architecture                                  ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝


  browser-whiskor provides LLM agents with "eyes not hands" — passive
  observation of browser state (DOM, framework internals, network, storage,
  console, accessibility) plus controlled write actions (click, type, navigate).
  A semantic state graph enables navigation between recorded UI states.
  Communication flows through a local Node.js server via WebSocket (extension)
  and MCP stdio (agent), with a cache layer for data persistence.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LAYER OVERVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 0 : LLM Agent                                                         │
│                                                                              │
│    Claude, GPT, Gemini, Cursor, Windsurf, or any MCP-compatible client.     │
│    Calls tools via MCP stdio: get_text_coords, click, capture_screenshot…   │
│    State navigation: list_states, search_states, navigate_to_state          │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │  MCP stdio (JSON-RPC 2.0)
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 1 : MCP Server  ( server/mcp/ )                                       │
│                                                                              │
│    62 tools available, organized in a layered architecture:                  │
│                                                                              │
│    mcp-server.js          ← Entry point, wires all layers together           │
│    mcp/registry.js        ← Tool registration, filtering, preset management  │
│    mcp/transport.js       ← stdio JSON-RPC 2.0 transport                    │
│    tool-manager.js        ← Dynamic profile management, auto-load/unload     │
│    mcp/tools/read.js      ← Entry point → 22 read tools (split into         │
│    read-basic.js, read-data.js, read-state.js, read-helpers.js)             │
│    mcp/tools/write.js     ← 16 write tools (navigate_to → reload_page;      │
│                             observe option on interaction tools)            │
│    mcp/tools/tabs.js      ← 4 tab tools (list/switch/open/close_tab)        │
│    mcp/tools/capture.js   ← 3 capture tools (screenshot, refresh_data,      │
│                             capture_element)                                │
│    mcp/tools/capture-element.js ← element screenshot crop+encode            │
│    mcp/tools/control.js   ← 10 control tools (set_config → profile_status)  │
│    mcp/tools/intelligence.js ← 5 intelligence tools                       │
│    (explain_element, why_did_this_change, analyze_click,                   │
│     get_source_file, detect_site_updates)                                  │
│                                                                              │
│    ┌──────────────────┬──────────────────────────────────────────────────┐  │
│    │  READ (22)       │ get_sessions, get_index, get_text_coords,        │  │
│    │                  │ get_viewport, get_framework_state, get_network,   │  │
│    │                  │ get_ui_catalog, get_accessibility, get_storage,   │  │
│    │                  │ get_console_logs, get_perf_metrics,               │  │
│    │                  │ get_css_analysis, get_dom_snapshot, get_state_map,│  │
│    │                  │ list_states, search_states, get_state_detail,     │  │
│    │                  │ pin_state, get_delta, list_patterns,              │  │
│    │                  │ lookup_pattern, find_target                      │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  WRITE (16)      │ navigate_to, click, right_click, type_text,      │  │
│    │                  │ press_key, hover, scroll_page, mouse_scroll,     │  │
│    │                  │ drag, select_option, check_box, execute_js,      │  │
│    │                  │ wait_for_element, go_back/forward, reload_page   │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  TABS (4)        │ list_tabs, switch_tab, open_tab, close_tab       │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  CAPTURE (3)     │ capture_screenshot (± SoM marks), refresh_data,   │
│                  │ capture_element_screenshot (selector/rect/padding)  │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  INTELLIGENCE (5)│ explain_element, why_did_this_change,            │  │
│    │                  │ analyze_click, get_source_file,                  │  │
│    │                  │ detect_site_updates                              │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  CONTROL (10)    │ set_config, get_config_changes, trigger_collect, │  │
│    │                  │ trigger_explorer, navigate_to_state,             │  │
│    │                  │ get_navigation_path, load_profile,               │  │
│    │                  │ unload_profile, search_tools, profile_status     │  │
│    └──────────────────┴──────────────────────────────────────────────────┘  │
│                                                                              │
│    Tool visibility: per-tool on/off, category toggle, presets                │
│    Config: server/configs/mcp-tools.json                                     │
│    Presets: read_only, read_and_capture, full_access, no_execute_js,         │
│             no_state_navigation                                              │
│    Env override: WHISKOR_MCP_<TOOL_NAME>=false                               │
│                                                                              │
│    Fuzzy matching (token Jaccard + bigram similarity) for text search.      │
│    Freshness warnings (STALE_DATA, ADAPTER_LIMITED, PARTIAL_TREE, NO_MATCH).│
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │  callbacks → index.js
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 2 : Intelligence Layer ( server/ + extension/ )                       │
│                                                                              │
│    Five subsystems transform raw collected data into deterministic           │
│    conclusions before they reach the LLM agent. Each produces structured     │
│    output with an explicit confidence value and degrades gracefully          │
│    through a fallback chain.                                                 │
│                                                                              │
│    ┌──────────────────────────────────────────────────────────────────────┐  │
│    │  Subsystem              Location         Answers                      │  │
│    ├──────────────────────────────────────────────────────────────────────┤  │
│    │  CSS Origin Tracker     extension/       Which stylesheet rule       │  │
│    │                         css-origin.js    applies & source file/line  │  │
│    ├──────────────────────────────────────────────────────────────────────┤  │
│    │  Source Layer           extension/       Actual text of CSS/JS files │  │
│    │                        source-fetcher   + change detection           │  │
│    │                        + server/                                     │  │
│    │                        source-store.js                               │  │
│    ├──────────────────────────────────────────────────────────────────────┤  │
│    │  Framework↔DOM         extension/       Which component owns a DOM   │  │
│    │  Mapper               framework-dom-    node + props/state           │  │
│    │                        map.js                                        │  │
│    ├──────────────────────────────────────────────────────────────────────┤  │
│    │  Clickability          extension/       Element clickability pre-    │  │
│    │  Analyzer             clickability.js   check + obstruction analysis │  │
│    ├──────────────────────────────────────────────────────────────────────┤  │
│    │  Time-series           server/          Network→DOM causal chains   │  │
│    │  Correlator           correlator.js     with confidence scoring      │  │
│    ├──────────────────────────────────────────────────────────────────────┤  │
│    │  Source Map            server/          Compiled→original source     │  │
│    │  Resolver             source-map-       file/line (VLQ decode)       │  │
│    │                        resolver.js                                   │  │
│    ├──────────────────────────────────────────────────────────────────────┤  │
│    │  Stream Delta          server/          UI change aggregation,       │  │
│    │  Engine               delta-engine.js   pattern registry             │  │
│    │                        + pattern-registry.js                         │  │
│    ├──────────────────────────────────────────────────────────────────────┤  │
│    │  Session Replay        server/          Action recording + replay    │  │
│    │                        session-replay.js                             │  │
│    ├──────────────────────────────────────────────────────────────────────┤  │
│    │  Conclusion Cache      server/          explain_element result       │  │
│    │                        conclusion-      cache with SHA-256           │  │
│    │                        cache.js         invalidation key             │  │
│    ├──────────────────────────────────────────────────────────────────────┤  │
│    │  State Visualizer      server/          Text-based state graph       │  │
│    │                        state-           rendering for agent          │  │
│    │                        visualizer.js                                 │  │
│    └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│    Data flow — explain_element:                                              │
│      Agent→MCP→server→trigger collection→extension runs css-origin.js +     │
│      framework-dom-map.js→cache→correlator chains→assemble response         │
│                                                                              │
│    Data flow — capture_element:                                              │
│      Agent→MCP→screenshot-manager.js→CAPTURE_ELEMENT→extension→crop→return  │
│                                                                              │
│    Data flow — session replay:                                               │
│      session-replay.js reads actions.jsonl→pre-state hash verify→execute     │
│      action→post-state hash verify→report divergence                         │
│                                                                              │
│    Confidence values are defined per-subsystem. 1.0 = direct API query.      │
│    Confidence floor for correlation: 0.50. Further detail in the DATA FLOW   │
│    sections below.                                                           │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │  server-core data flow
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 3 : Server Core  ( server/index.js )                                  │
│                                                                              │
│    HTTP API server (port 7892) — serves cached data to DevTools panel.      │
│    WebSocket server (port 7891) — bridges extension ↔ server.               │
│    Cache writer — persists collected data to disk as JSON.                  │
│    State machine — builds state-transition graphs from explorer actions.    │
│    Config manager — validates, logs, and auto-reverts non-recommended       │
│    changes via config-change-log.js.                                        │
│                                                                              │
│    Message handlers:                                                        │
│      REACT_TRANSITION  → stateStore.addEdge() (was previously swallowed)    │
│      STATE_HASH_REPORT → navigator.handleHashReport() (for nav verification)│
│      EXPLORER_STATE_UPDATE → stateStore.addNode() with reactHash/domHash    │
└──────┬───────────────────────────────────────┬───────────────────────────────┘
       │ HTTP :7892                            │ WebSocket :7891
       ▼                                       ▼
┌─────────────────────┐           ┌────────────────────────────────────────────┐
│  LAYER 4a : Cache   │           │  LAYER 4b : State Graph Store              │
│                     │           │                                            │
│  cache/             │◄──────────┤  server/state-store.js                     │
│  {tabId}/           │  JSON     │    L1: In-memory graph (Map)               │
│    _index.json      │  files    │    L2: Disk (gzip JSON)                    │
│    raw/visual/      │           │    L3: LRU eviction → evicted/             │
│    raw/network/     │           │    Snapshots: cache/graphs/snapshots/      │
│    raw/ui/          │           │                                            │
│    raw/accessibility│           │  server/state-fingerprint.js               │
│    raw/storage/     │           │    FNV32 hash, ND filter, composite hash   │
│    raw/console/     │           │                                            │
│    raw/perf/        │           │  server/state-semantic.js                  │
│    raw/css/         │           │    Labels, tags, keyState, search          │
│    raw/dom/         │           │                                            │
│    raw/react_*.json │           │  server/state-navigator.js                 │
│    ...              │           │    BFS path finding, action replay         │
└─────────────────────┘           └──────────────┬─────────────────────────────┘
                                                 │
                                                 ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 5 : Extension (Chrome MV3)                                            │
│                                                                              │
│  extension/background/sw.js                                                  │
│    WebSocket client → server                                                 │
│    Routes commands to content scripts                                        │
│    Set-of-Marks screenshot overlay (OffscreenCanvas)                         │
│    REQUEST_STATE_HASH / CANCEL_WATCH relay to content scripts                │
│    Tab lifecycle tracking                                                    │
│                                                                              │
│  extension/injected/bridge.js                                                │
│    Content-world ↔ MAIN-world relay (runs in ISOLATED world)                 │
│                                                                              │
│  extension/injected/*.js (MAIN world, run at document_start)                 │
│    plugin-system.js  — plugin registry                                       │
│    collector.js      — data aggregation                                      │
│    state-reporter.js — REQUEST_STATE_HASH handler, watchMode                 │
│    explorer.js       — autonomous exploration, composite hash                │
│    executor.js       — action execution                                      │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  Framework Adapters (detect & extract component state)                 │ │
│  │  react-hooks.js + react-state-managers.js + react.js (split from      │ │
│  │    single react.js; react.js writes __SI_REACT_HASH__)                │ │
│  │  vue3.js, vue2.js, angular.js, svelte.js, preact.js,                   │ │
│  │  alpine.js, solid.js, dom-generic.js                                   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  Analyzers (collect page-level data) — 15 total                       │ │
│  │  text-coords.js, network.js, css.js, css-origin.js,                   │ │
│  │  source-fetcher.js, ui-catalog.js, perf.js, dom-mutations.js,          │ │
│  │  shadow-dom.js, dom-snapshot.js, clickability.js,                     │ │
│  │  framework-dom-map.js, accessibility.js, console-logger.js,            │ │
│  │  storage-reader                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  lib/bippy.iife.js — React Fiber traversal (third-party, bundled)           │
│  version-helper.js — runtime version detection                              │
│  config.json — server-side config, pushed to page via postMessage           │
└──────────────────────────────────────────────────────────────────────────────┘


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STATE HASHING ENGINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Three-layer hash system ensures consistent state identification:

  Layer 1: reactHash (highest priority)
    Input: component tree shape + router pathname + store keys
    Filter: non-deterministic values excluded (timestamps, UUIDs, loading flags)
    Algorithm: FNV32 32bit → base-36 (7 chars)

  Layer 2: domHash (always available)
    Input: URL pathname + search + interactive elements (tag:text, max 50)
    Algorithm: FNV32 32bit → base-36 (7 chars)

  Layer 3: compositeHash (graph node ID)
    = FNV32(reactHash + "|" + domHash)  if reactHash available
    = domHash                            otherwise

  Non-deterministic filter (config.json react.hashFilter.mode):
    - 'key-aware' (default): a value is normalized away only when its KEY looks
      volatile (createdAt, *At, timestamp, nonce…) OR the value is an
      unambiguous format (UUID v4, ISO-8601). Legitimate numeric IDs — even
      13-digit ones — survive, so distinct states stay distinct.
    - 'aggressive': additionally strips bare 13-digit numbers and 32+ char
      random strings regardless of key (the old blind heuristic).
    - 'off': no filtering (legacy; hash changes on every volatile prop).
    - Configurable excludeKeys are always dropped (except in 'off').

  NOTE: the live reactHash is produced client-side in
  shared/injected/adapters/react.js (_getStateHash); server/state-fingerprint.js
  mirrors the same spec. observe + explorer both consume the client hash.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DATA FLOW: Collection (Read Path)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Page loads → content scripts inject at document_start
       │
       ├─ plugin-system.js scans window.__REACT_DEVTOOLS_GLOBAL_HOOK__,
       │   Vue devtools globals, Angular ng, Svelte internals, etc.
       │
       ├─ Detected framework → corresponding adapter activated
       │   react.js writes window.__SI_REACT_HASH__ on each commit
       │
       ├─ Analyzers run on config-driven schedule or manual trigger
       │
       ├─ explorer.js computes compositeHash from reactHash + domHash
       │   Writes window.__SI_CURRENT_HASH__ = { compositeHash, reactHash, domHash }
       │
       ├─ collector.js aggregates all plugin outputs into a single payload
       │
       ├─ bridge.js receives payload (ISOLATED world) → forwards to
       │   background/sw.js via chrome.runtime.sendMessage
       │
       ├─ sw.js forwards payload to server via WebSocket
       │
       ├─ server/index.js receives → cache-writer persists to disk
       │     EXPLORER_STATE_UPDATE → stateStore.addNode() with reactHash/domHash
       │     REACT_TRANSITION → stateStore.addEdge()
       │
       └─ MCP server reads from cache on agent tool call


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DATA FLOW: State Navigation (navigate_to_state)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Agent calls navigate_to_state(tabId, hash="a1f3c8e2")
       │
       ▼
  MCP server → state-navigator.navigate()
       │
       ├─ [1] REQUEST_STATE_HASH → extension → STATE_HASH_REPORT
       │     Gets current compositeHash
       │
       ├─ [2] BFS on state graph: startHash → targetHash
       │     Returns path: Edge[] with replayAction params
       │     If no path: try URL fallback (navigate_to target URL)
       │
       ├─ [3] For each edge in path:
       │     executeAction(tabId, edge.replayAction)
       │     REQUEST_STATE_HASH → verify actualHash == expected to
       │     On mismatch: record new edge, continue or fail
       │
       └─ [4] Final STATE_HASH_REPORT → verify == targetHash
              Return { ok, exactMatch, path, durationMs }


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DATA FLOW: Smart Delta (UI Change Aggregation)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Extension sends TEXT_COORD_DELTA (per-element coordinate changes)
       │
       ▼
  server/index.js → broadcastToDashboard (real-time canvas update)
       │
       ▼
  delta-engine.addFrame(tabId, {
    timestamp,
    viewport: { from, to },
    deltas: [{ id, dx, dy, dw, dh, textChanged, ... }]
  })
       │
       ├─ Frames buffered (max 5 or 1.5s window)
       │
       ├─ Decorative changes filtered (opacity/color/shadow-only)
       │
       ├─ Motion clustering: elements with same vector grouped
       │
       ├─ Scroll detection: 70%+ same vector → classified as scroll
       │
       ├─ Pattern registry: first appearance → full def + ref ID
       │                    repeat appearance → ref ID only
       │
       ▼
  delta-engine.flushBuffer() → aggregated smart delta
       │
       ▼
  cache.storeSmartDelta(tabId, delta)
       │
       ▼
  Agent calls get_delta(tabId) → returns latest aggregated delta
  Agent calls lookup_pattern(ref) → retrieves full pattern definition


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DATA FLOW: CSS Origin Analysis (4-Level Fallback)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  css-origin.js resolves CSS property origins through four progressive levels,
  each with higher confidence but stricter access requirements:

  Level 1 — DevTools getResources() bridge (acqLevel >= 1, confidence 0.99)
    css-origin.js (MAIN)
      └─ postMessage({ CSS_ORIGIN_RESOURCE_REQUEST, reqId })
           └─ bridge.js (ISOLATED) → chrome.runtime.sendMessage
                └─ sw.js → panel port
                     └─ panel.js → chrome.devtools.inspectedWindow.getResources()
                          ├─ type=stylesheet filter
                          ├─ getContent(content, encoding)
                          ├─ sourceMappingURL extraction
                          └─ chrome.runtime.sendMessage (reverse path)
                               └─ sw.js → scripting.executeScript (MAIN injection)
                                    └─ css-origin.js: postMessage listener matches reqId
                                         └─ sourceLine + sourceMapURL → VLQ decode
                                              → originalFile / originalLine

    Sourcemap resolution (post-loop):
      fetchSourceMap(href, sourceMapURL) → JSON parse → vlqDecode() → resolveSourceLine()
      Result: { originalFile, originalLine, originalColumn } + confidence boost +0.05

  Level 2 — cssRules access (acqLevel >= 2, confidence 0.93)
    document.styleSheets → rules → CSSStyleRule matching
    @layer cascade support: buildLayerRegistry() + flattenRules()
      - CSSLayerStatementRule/CSSLayerBlockRule recursively flattened
      - Unlayered rules = Infinity priority
      - Layered rules ordered by declaration (later wins)
    specificity computed via packed 32-bit: (a<<24)|(b<<16)|(c<<8)
    Cascade order: layerOrder > specificity > sheetIndex > ruleIndex

  Level 3 — HTTP fetch fallback (acqLevel >= 3, confidence 0.93)
    tryFetchSheet(href): fetch(href, { credentials: 'omit' })
      → findRuleLineInSource(text, selector) for source line estimation
    Works when CORS headers permit cross-origin access

  Level 4 — Preloaded sources (acqLevel >= 4, confidence 0.95)
    SourceFinder (source-fetcher.js) provides pre-fetched content
    dependencies: ['css', 'css-origin'] → runs after both CSS analyzers

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DATA FLOW: Screenshots (Set-of-Marks)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Agent calls capture_screenshot(tabId, marks=true)
       │
       ▼
  server/index.js → send to extension:
       { type: 'CAPTURE_SCREENSHOT', tabId, opts: {marks: true} }
       │
       ▼
  extension/background/sw.js:
       1. chrome.scripting.executeScript → query interactive elements
          Returns: [{id, tag, text, x, y, w, h, selector}, …]
       │
       2. chrome.tabs.captureVisibleTab → raw PNG dataUrl
       │
       3. drawMarksOnImage(dataUrl, elements):
            OffscreenCanvas → draw raw image
            For each element: draw red circle (#e53e3e) with white number
            convertToBlob → FileReader → marked dataUrl
       │
       ▼
  sw.js → send to server:
       { type: 'SCREENSHOT_RESULT', dataUrl, elements, capturedAt }
       │
       ▼
  server/index.js → save PNG to disk, return to MCP:
       { ok: true, dataUrl, filePath, elements: {1: {tag, text, center, …}} }


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DATA FLOW: Element-Level Screenshot Capture
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Agent calls capture_element_screenshot(tabId, selector="div.main", padding=4)
       │
       ▼
  MCP server → server/core.js routeMessage → screenshot-manager.captureElement()
       │
       ├─ Sends CAPTURE_ELEMENT to extension via WebSocket:
       │   { type: 'CAPTURE_ELEMENT', tabId, selector, rect, padding, format, quality }
       │
       ▼
  extension/background/sw.js:
       │
       ├─ [1] chrome.tabs.captureVisibleTab → full-page PNG dataUrl
       │
       ├─ [2] cropImage(dataUrl, rect, padding, dpr):
       │     If rect provided: clamp to image bounds, apply padding
       │     If selector provided: evaluate selector in page to get bounding rect
       │     Chrome: OffscreenCanvas → drawImage(cropped) → canvas.toBlob()
       │     Firefox: document.createElement('canvas') → getContext → drawImage → toDataURL()
       │
       ├─ [3] Returns:
       │   { type: 'ELEMENT_CAPTURE_RESULT', dataUrl, format, rect, padding, ... }
       │
       ▼
  server/core.js → screenshot-manager.handleResult()
       │
       ├─ Saves to disk (if path configured)
       ▼
  MCP responds:
    { ok: true, dataUrl, format, rect, padding, filePath }

  Fallback: if CAPTURE_ELEMENT command not recognized by extension
    (e.g., outdated service worker), returns full-page screenshot instead.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CONFIG SYSTEM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  config.json (server-side defaults)
       │
       ▼
  server/index.js loads config → validates → applies
       │
       ├─ .env overrides: WHISKOR_SERVER_WS_PORT=8080
       │
       ├─ Pushed to extension via WebSocket SET_CONFIG
       │   → sw.js → chrome.storage.local.set({SI_CONFIG: …})
       │   → chrome.scripting.executeScript → postMessage CONFIG_UPDATE
       │   → injected scripts receive and apply
       │
       ├─ stateGraph section:
       │   maxNodesInMemory, maxMemoryMB, maxDiskMB
       │   excludeKeys, excludePatterns (for hash stability)
       │   labelMaxLength, autoTagging, protectedTags
       │   defaultNavigateTimeoutMs, maxNavigateSteps
       │
       └─ Agent changes via set_config MCP tool:
            require: agentControl.allowAgentConfig = true
            config-change-log.js tracks every change
            autoRevertConfig = true → danger/warning changes reverted on restart


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FIREFOX MV2 PARITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  firefox-mv2/ mirrors extension/ with these adaptations:

    ┌──────────────────┬──────────────────┬──────────────────────────────────┐
    │  Component       │  Chrome MV3      │  Firefox MV2                     │
    ├──────────────────┼──────────────────┼──────────────────────────────────┤
    │  Background      │  sw.js           │  background.js                   │
    │                  │  (Service Worker)│  (Event page, persistent:false)  │
    ├──────────────────┼──────────────────┼──────────────────────────────────┤
    │  WebSocket       │  native WS       │  native WS                       │
    ├──────────────────┼──────────────────┼──────────────────────────────────┤
    │  SoM overlay     │  OffscreenCanvas │  document.createElement('canvas')│
    ├──────────────────┼──────────────────┼──────────────────────────────────┤
    │  Script inject   │  scripting API   │  executeScript API               │
    │                  │  world:'MAIN'    │  content_scripts + postMessage   │
    ├──────────────────┼──────────────────┼──────────────────────────────────┤
    │  Injected scripts│  identical       │  identical (MAIN world)          │
    ├──────────────────┼──────────────────┼──────────────────────────────────┤
    │  state-reporter  │  included        │  included (copied)               │
    └──────────────────┴──────────────────┴──────────────────────────────────┘

  All 9 framework adapters (react split into 3 files = react-hooks.js +
  react-state-managers.js + react.js) are synchronized between Chrome and
  Firefox builds.
  State reporting (state-reporter.js) is included in both builds.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SECURITY MODEL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  server/security config (config.json):                                   │
  │                                                                          │
  │    allowExecuteJs:    true   — allow arbitrary JS execution via MCP     │
  │    allowActions:      true   — allow click/type/scroll actions          │
  │    allowScreenshots:  true   — allow screenshot capture                │
  │    allowExplorer:     true   — allow autonomous page exploration       │
  │    executeJsTimeoutMs: 15000 — JS execution timeout                    │
  │    actionTimeoutMs:   15000 — action execution timeout                 │
  │    allowedMcpOrigins: ["*"]  — MCP origin whitelist                    │
  └──────────────────────────────────────────────────────────────────────────┘

  All communication is localhost-only (127.0.0.1). No external network access.
  Extension host_permissions restricted to localhost/* and ws://localhost/*.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  v0.4.x BEHAVIORAL ADDITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Behavioural layers added on top of the structure above. No new modules — each
  lives inside an existing file.

  Action routing (multi-browser) — server/core.js  sendToTab()
    Tab-scoped messages (EXECUTE_ACTION, CAPTURE_*) go ONLY to the service
    worker that owns msg.tabId (tracked in core._wsToTabs), instead of being
    broadcast to every connected browser. Stops a browser that lacks the tab
    from answering "No tab with id" first and winning the result race. Falls
    back to broadcast only when the owner is unknown.

  Tab-gone recovery — extension sw.js  (isTabGone / tabGoneInfo)
    When chrome.tabs.* fails because the tab was closed or reloaded into a new
    id, the SW returns { tabGone:true, liveTabs:[{tabId,url,title}], error }
    instead of a raw Chrome error, so the agent can retarget by URL (or use
    list_tabs / switch_tab). Capture also fails fast rather than grabbing the
    active tab. Forwarded through action-executor / screenshot-manager.

  Native dialog guard — shared/injected/executor.js
    window.alert/confirm/prompt are overridden in the MAIN world so a native
    dialog never blocks the event loop (which used to freeze the click handler
    and time the action out). Content is captured, auto-answered (alert
    dismissed; confirm/prompt per policy, per-call override via the `dialog`
    option on click / type_text), and returned in result.dialogs with causal
    attribution: direct (fired during the action) / indirect (<1.5s after) /
    none.

  Profile auto-load on call — server/tool-manager.js  ensureToolVisible()
    Calling a tool whose profile is not loaded auto-loads the owning profile
    and proceeds (reported via _autoLoaded) instead of bouncing the call —
    which agents misread as "not implemented". Permission-gated profiles
    (allowExecuteJs / allowAgentConfig) are NOT auto-loaded and return a
    precise reason so the agent asks the user.

  find_target — server/mcp/tools/read-data.js  (READ, core profile)
    One-shot "where do I act for X?" resolver: fuzzy-ranks get_ui_catalog +
    get_text_coords (MiniLM when available) and returns click coordinates,
    selector hint, kind, score, enterKey, and a clickable hint (obstructedBy
    when covered). Obstructed candidates are deprioritised; verify:true
    re-checks the top candidate live via analyze_click.

  Submit-key inference — shared/injected/executor.js  (type_text submit:"auto")
    Best-effort inference of the submit gesture from observable signals, in
    priority order: aria-keyshortcuts, role=searchbox / type=search,
    role=textbox + aria-multiline, enterkeyhint, a single-line <input> in a
    <form>, then hint text. Returns submitInference {key, confidence, evidence};
    key:null when it cannot be inferred (it never guesses).

  Accessible-name search — ui-catalog.js + executor.js elementText
    Icon controls are indexed by aria-label / title / alt and the text of
    aria-labelledby / aria-describedby targets (e.g. a tooltip "送信") at the
    control's OWN coordinates, so search / click(text) / find_target hit the
    real control rather than a floating tooltip overlay. contenteditable /
    role=textbox editors are catalogued among inputs.

  Token-light screenshots — capture.js  (agentControl.screenshot)
    capture_screenshot returns filePath only by default (base64 omitted to
    save tokens); when the image is requested it is JPEG-encoded and downscaled
    to maxWidth. Configurable; per-call overrides on the tool.

  Semantic search backend — MiniLM (paraphrase-multilingual) is used by default
    (searchClassifier.backend:"auto") for get_text_coords(match:) and fuzzy
    suggestions, with a dictionary fallback. An exact-search miss now returns
    fuzzy _suggestions by default. matchBackend:"minilm" in the response
    confirms the model served the query.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FILE MAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server/
    index.js              — HTTP + WS server, cache writer, config manager
    mcp-server.js         — Entry point: wires registry, transport, tool modules
    mcp/
      registry.js         — Tool registration, filtering, preset management
      transport.js        — stdio JSON-RPC 2.0 transport layer
      tools/
        read.js           — Entry point → 22 READ tools
        read-helpers.js   — Fuzzy matching (tokenize, bigramSet, jaccard, freshness)
        read-basic.js     — READ tools 1–5 (sessions → framework_state)
        read-data.js      — READ tools 6–13 + find_target (network → dom_snapshot)
        read-state.js     — READ tools 14–21 (state_map → lookup_pattern)
        write.js          — 16 WRITE tools (navigate_to → reload_page; observe option helper)
        tabs.js           — 4 TABS tools (list_tabs, switch_tab, open_tab, close_tab)
        capture.js        — 3 CAPTURE tools (screenshot, refresh_data, capture_element)
        capture-element.js — Element screenshot crop+encode logic
        control.js        — 10 CONTROL tools (set_config → profile_status)
    configs/
      mcp-tools.json      — MCP tool visibility config (categories, tools, presets)
      tool-profiles.json  — Dynamic tool profile definitions and triggers
    state-machine.js      — Backward-compat wrapper → state-store.js
    state-store.js        — State graph management, LRU eviction (core logic)
    state-persistence.js  — State graph disk I/O (persistGraph, loadGraph, saveSnapshot)
    state-fingerprint.js  — FNV32 hash, ND filter, composite hash
    state-semantic.js     — Label generation, tag extraction, keyState, search
    state-navigator.js    — BFS path finding, action replay, hash verification
    intelligence.js       — 5 intelligence MCP tools (explain_element, why_did_this_change, analyze_click, get_source_file, detect_site_updates)
    services/
      embed-service.js    — Semantic search orchestration, diff-embedding, async cache
      embed-store.js      — Embeddings JSON LRU disk cache
      embed-worker.js     — Transformers.js ONNX embedding execution
      embed-worker-pool.js— Single Worker thread pool manager, auto-recovery
      load-monitor.js     — Event loop lag / EWMA batch time load detection
    core.js               — Message router, on-demand collection triggers, explore/screenshot coordination
    screenshot-manager.js — Screenshot/element-capture request management, pending-request tracking, disk save
    correlator.js         — Time-series Correlator: ring buffer, 3 correlation rules, CausalChain output
    source-store.js       — Source file cache + cross-session hash registry
    source-map-resolver.js— VLQ-based source map resolution, LRU-cached parsed segments
    conclusion-cache.js   — explain_element result cache with SHA-256 invalidation key
    session-replay.js     — Action recording (actions.jsonl) + replay engine with divergence detection
    state-visualizer.js   — Text-based state graph renderer (BFS layout, ASCII connectors)
    delta-engine.js       — UI change aggregation (frame buffer, motion clustering, pattern registry)
    pattern-registry.js   — UI pattern deduplication (first appearance→full def, repeat→ref ID)
    config-loader.js      — Config validation, schema check, env override
    config-change-log.js  — Agent config change tracking, auto-revert for dangerous changes

  extension/ (Chrome MV3)
    manifest.json         — Extension manifest v3
    background/sw.js      — Service worker: WS client, command router, SoM,
                            element screenshot crop (OffscreenCanvas)
    background/sw-element-capture.patch.js — Reference patch for element capture
    injected/
      bridge.js           — ISOLATED world relay (content script → background)
      collector.js        — Plugin output aggregator
      executor.js         — Action executor (click, type, key, scroll, JS)
      explorer.js         — Autonomous page explorer (composite hash)
      state-reporter.js   — REQUEST_STATE_HASH handler, watchMode
      plugin-system.js    — Hot-reloadable plugin registry
      version-helper.js   — Runtime version detection
      adapters/           — Framework-specific state extractors (react split into
      react-hooks.js + react-state-managers.js + react.js, 9 adapters total)
      analyzers/          — Page data collectors (15 analyzers incl.
      css-origin.js, source-fetcher.js, clickability.js,
      framework-dom-map.js, shadow-dom.js, dom-snapshot.js)
    lib/bippy.iife.js     — React Fiber traversal library

  firefox-mv2/            — Firefox Manifest V2 build (mirrors extension/)
  config.json             — Server configuration with plugin toggles + stateGraph
  .env                    — Environment variable overrides

```
