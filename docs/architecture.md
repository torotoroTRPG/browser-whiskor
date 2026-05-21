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
│    49 tools available, organized in a layered architecture:                  │
│                                                                              │
│    mcp-server.js          ← Entry point, wires all layers together           │
│    mcp/registry.js        ← Tool registration, filtering, preset management  │
│    mcp/transport.js       ← stdio JSON-RPC 2.0 transport                    │
│    tool-manager.js        ← Dynamic profile management, auto-load/unload     │
│    mcp/tools/read.js      ← 21 read tools (sessions → lookup_pattern)       │
│    mcp/tools/write.js     ← 16 write tools (navigate_to → reload_page)      │
│    mcp/tools/capture.js   ← 2 capture tools (screenshot, refresh_data)      │
│    mcp/tools/control.js   ← 10 control tools (set_config → profile_status)  │
│                                                                              │
│    ┌──────────────────┬──────────────────────────────────────────────────┐  │
│    │  READ (21)       │ get_sessions, get_index, get_text_coords,        │  │
│    │                  │ get_viewport, get_framework_state, get_network,   │  │
│    │                  │ get_ui_catalog, get_accessibility, get_storage,   │  │
│    │                  │ get_console_logs, get_perf_metrics,               │  │
│    │                  │ get_css_analysis, get_dom_snapshot, get_state_map,│  │
│    │                  │ list_states, search_states, get_state_detail,     │  │
│    │                  │ pin_state, get_delta, list_patterns,              │  │
│    │                  │ lookup_pattern                                   │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  WRITE (16)      │ navigate_to, click, right_click, type_text,      │  │
│    │                  │ press_key, hover, scroll_page, mouse_scroll,     │  │
│    │                  │ drag, select_option, check_box, execute_js,      │  │
│    │                  │ wait_for_element, go_back/forward, reload_page   │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  CAPTURE (2)     │ capture_screenshot (± SoM marks), refresh_data   │  │
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
│  LAYER 2 : Server Core  ( server/index.js )                                  │
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
│  LAYER 3a : Cache   │           │  LAYER 3b : State Graph Store              │
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
│  LAYER 4 : Extension (Chrome MV3)                                            │
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
│  │  react.js → writes window.__SI_REACT_HASH__ for composite hash         │ │
│  │  vue3.js, vue2.js, angular.js, svelte.js, preact.js,                   │ │
│  │  alpine.js, solid.js, dom-generic.js                                   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  Analyzers (collect page-level data)                                   │ │
│  │  text-coords.js, network.js, css.js, ui-catalog.js, perf.js,           │ │
│  │  dom-mutations.js, accessibility.js, console-logger.js, storage-reader │ │
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

  Non-deterministic filter excludes:
    - Timestamps: 13-digit numbers, ISO 8601 strings
    - UUIDs: v4 pattern
    - Long random strings: 32+ alphanumeric chars
    - Configurable keys: createdAt, updatedAt, timestamp, etc.


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

  All 9 framework adapters are synchronized between Chrome and Firefox builds.
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
  FILE MAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server/
    index.js              — HTTP + WS server, cache writer, config manager
    mcp-server.js         — Entry point: wires registry, transport, tool modules
    mcp/
      registry.js         — Tool registration, filtering, preset management
      transport.js        — stdio JSON-RPC 2.0 transport layer
      tools/
        read.js           — 21 READ tools (sessions → lookup_pattern)
        write.js          — 16 WRITE tools (navigate_to → reload_page)
        capture.js        — 2 CAPTURE tools (screenshot, refresh_data)
        control.js        — 10 CONTROL tools (set_config → profile_status)
    configs/
      mcp-tools.json      — MCP tool visibility config (categories, tools, presets)
      tool-profiles.json  — Dynamic tool profile definitions and triggers
    state-machine.js      — Backward-compat wrapper → state-store.js
    state-store.js        — State graph management, gzip persistence, LRU
    state-fingerprint.js  — FNV32 hash, ND filter, composite hash
    state-semantic.js     — Label generation, tag extraction, keyState, search
    state-navigator.js    — BFS path finding, action replay, hash verification

  extension/ (Chrome MV3)
    manifest.json         — Extension manifest v3
    background/sw.js      — Service worker: WS client, command router, SoM
    injected/
      bridge.js           — ISOLATED world relay (content script → background)
      collector.js        — Plugin output aggregator
      executor.js         — Action executor (click, type, key, scroll, JS)
      explorer.js         — Autonomous page explorer (composite hash)
      state-reporter.js   — REQUEST_STATE_HASH handler, watchMode
      plugin-system.js    — Hot-reloadable plugin registry
      version-helper.js   — Runtime version detection
      adapters/           — Framework-specific state extractors (9 adapters)
      analyzers/          — Page data collectors (9 analyzers)
    lib/bippy.iife.js     — React Fiber traversal library

  firefox-mv2/            — Firefox Manifest V2 build (mirrors extension/)
  config.json             — Server configuration with plugin toggles + stateGraph
  .env                    — Environment variable overrides

```
