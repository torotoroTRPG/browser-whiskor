# Agent Knowledge Base — browser-whiskor v3

Reverse reference and source map for LLM agents using browser-whiskor via MCP.

---

## MCP Tool → Source Code Map

### READ Tools

| Tool | Handler | Data Source | Cache File |
|------|---------|-------------|------------|
| `get_sessions` | `mcp-server.js` | `cache.getSessionList()` | `cache/{tabId}/_index.json` |
| `get_index` | `mcp-server.js` | `cache.getSessionData(tabId)` | `cache/{tabId}/_index.json` |
| `get_text_coords` | `mcp-server.js` | `text-coords.js` (extension) | `cache/{tabId}/raw/visual/text-coords.json` |
| `get_framework_state` | `mcp-server.js` | Framework adapters | `cache/{tabId}/raw/react_snapshot.json` etc. |
| `get_network` | `mcp-server.js` | `network.js` analyzer | `cache/{tabId}/raw/network/requests.json` |
| `get_ui_catalog` | `mcp-server.js` | `ui-catalog.js` analyzer | `cache/{tabId}/raw/ui/elements.json` |
| `get_accessibility` | `mcp-server.js` | `accessibility.js` analyzer | `cache/{tabId}/raw/accessibility/tree.json` |
| `get_storage` | `mcp-server.js` | `storage-reader.js` analyzer | `cache/{tabId}/raw/storage/data.json` |
| `get_console_logs` | `mcp-server.js` | `console-logger.js` analyzer | `cache/{tabId}/raw/console/logs.json` |
| `get_perf_metrics` | `mcp-server.js` | `perf.js` analyzer | `cache/{tabId}/raw/perf/metrics.json` |
| `get_css_analysis` | `mcp-server.js` | `css.js` analyzer | `cache/{tabId}/raw/css/analysis.json` |
| `get_dom_snapshot` | `mcp-server.js` | `dom-generic.js` adapter | `cache/{tabId}/raw/dom/snapshot.json` |
| `get_state_map` | `mcp-server.js` | `state-machine.js` | `cache/graphs/{siteVersion}.json.gz` |

### State Navigation Tools

| Tool | Handler | Source |
|------|---------|--------|
| `list_states` | `mcp-server.js` | `state-store.getAllNodesFlat()` |
| `search_states` | `mcp-server.js` | `state-semantic.searchStates()` |
| `get_state_detail` | `mcp-server.js` | `state-store.getNodeByHash()` + `loadSnapshot()` |
| `pin_state` | `mcp-server.js` | `state-store.pinNode()` |
| `navigate_to_state` | `mcp-server.js` | `state-navigator.navigate()` |
| `get_navigation_path` | `mcp-server.js` | `state-navigator.findPath()` |

### WRITE Tools

| Tool | Handler | Extension Handler | Source |
|------|---------|-------------------|--------|
| `navigate_to` | `mcp-server.js` | `sw.js` (chrome.tabs.update) | — |
| `click` | `mcp-server.js` | `executor.js` (MAIN world) | `injected/executor.js` |
| `type_text` | `mcp-server.js` | `executor.js` (MAIN world) | `injected/executor.js` |
| `press_key` | `mcp-server.js` | `executor.js` (MAIN world) | `injected/executor.js` |
| `hover` | `mcp-server.js` | `executor.js` (MAIN world) | `injected/executor.js` |
| `scroll_page` | `mcp-server.js` | `executor.js` (MAIN world) | `injected/executor.js` |
| `select_option` | `mcp-server.js` | `executor.js` (MAIN world) | `injected/executor.js` |
| `check_box` | `mcp-server.js` | `executor.js` (MAIN world) | `injected/executor.js` |
| `execute_js` | `mcp-server.js` | `executor.js` (MAIN world eval) | `injected/executor.js` |
| `wait_for_element` | `mcp-server.js` | `executor.js` (MutationObserver) | `injected/executor.js` |
| `go_back` | `mcp-server.js` | `sw.js` (chrome.tabs.goBack) | — |
| `go_forward` | `mcp-server.js` | `sw.js` (chrome.tabs.goForward) | — |
| `reload_page` | `mcp-server.js` | `sw.js` (chrome.tabs.reload) | — |

### CAPTURE Tools

| Tool | Handler | Extension Handler | Source |
|------|---------|-------------------|--------|
| `capture_screenshot` | `mcp-server.js` | `sw.js` + `drawMarksOnImage` | `background/sw.js` |
| `refresh_data` | `mcp-server.js` | Triggers collect via `index.js` | `server/index.js` |

### CONTROL Tools

| Tool | Handler | Extension Handler | Source |
|------|---------|-------------------|--------|
| `set_config` | `mcp-server.js` | `sw.js` (SET_CONFIG) | `server/config-change-log.js` |
| `get_config_changes` | `mcp-server.js` | — | `server/config-change-log.js` |
| `trigger_collect` | `mcp-server.js` | `sw.js` (MANUAL_COLLECT) | `injected/collector.js` |
| `trigger_explorer` | `mcp-server.js` | `sw.js` (EXPLORER_CONTROL) | `injected/explorer.js` |

---

## Framework Adapter Capability Matrix

| Framework | File | Component Tree | Props | State/Signals | Store | Router | Notes |
|-----------|------|:---:|:---:|:---:|:---:|:---:|-------|
| React | `adapters/react.js` | Yes | Yes | Yes (useState, useReducer) | Yes Redux/Zustand/Jotai/Recoil/MobX | Yes | Uses bippy.iife.js for Fiber traversal; writes `__SI_REACT_HASH__` |
| Vue 3 | `adapters/vue3.js` | Yes | Yes | Yes (reactive, ref) | Yes Pinia | Yes Vue Router | Requires `__VUE_DEVTOOLS_GLOBAL_HOOK__` |
| Vue 2 | `adapters/vue2.js` | Yes | Yes | Yes (data, computed) | Yes Vuex | Yes Vue Router | Requires devtools build or hook |
| Angular | `adapters/angular.js` | Yes | Yes | Yes (component state) | Yes NgRx | Yes Router | Uses `ng.probe` / `getDebugNode` |
| Svelte | `adapters/svelte.js` | Partial | Partial | Yes (stores) | — | — | Production: only CSS scoping hashes available |
| Preact | `adapters/preact.js` | Partial | Partial | Partial | — | — | Depends on `__PREACT_DEVTOOLS__` hook |
| Alpine | `adapters/alpine.js` | Yes | Yes | Yes (x-data) | — | — | Reads `Alpine.store()` and component data |
| Solid | `adapters/solid.js` | Partial | Partial | Yes (signals, stores) | — | — | Production: only hydration markers available |
| DOM-generic | `adapters/dom-generic.js` | — | — | — | — | — | Fallback: DOM tree + ARIA + window.* globals |

### Adapter Limitations

- **Svelte**: Component instances only accessible in dev builds. Production builds expose only CSS scoping hashes (`__svelte.css`).
- **SolidJS**: Owner tree, stores, and signals only available in dev builds. Production builds expose only hydration markers.
- **Preact**: Requires `__PREACT_DEVTOOLS__` global hook. May not be present in all builds.
- **Angular**: Requires `ng.probe` or `getDebugNode` — only available in dev mode or with `enableProdMode()` not called.

---

## State Graph & Navigation

### Hash System

States are identified by a composite hash:

| Layer | Input | Algorithm |
|-------|-------|-----------|
| reactHash | Component tree shape + router path + store keys | FNV32 32bit (ND-filtered) |
| domHash | URL pathname + interactive element signatures | FNV32 32bit |
| compositeHash | `FNV32(reactHash \| domHash)` or `domHash` | FNV32 32bit |

Non-deterministic values are excluded from hash computation:
- Timestamps (13-digit numbers, ISO 8601 strings)
- UUIDs (v4 pattern)
- Long random strings (32+ alphanumeric chars)
- Configurable keys: `createdAt`, `updatedAt`, `timestamp`, `lastSeen`, `capturedAt`, etc.

### State Node Structure

```json
{
  "hash": "a1f3c8e2",
  "reactHash": "3f8a1b2c",
  "domHash": "7e4d9a1f",
  "hashSource": "react",
  "url": "/cart",
  "title": "Your Cart - MyShop",
  "label": "Cart page (2 items, $49.99 total)",
  "tags": ["authenticated", "cart-open"],
  "keyState": {
    "route": "/cart",
    "user.isLoggedIn": true,
    "cart.items.length": 2,
    "cart.total": 49.99
  },
  "uiSummary": { "buttons": ["Checkout", "Continue Shopping"], "inputs": ["promo-code"] },
  "visitCount": 5,
  "firstSeen": 1716000000000,
  "lastSeen": 1716003600000,
  "hasFullSnapshot": true
}
```

### Navigation Flow

```
navigate_to_state({ tabId, hash: "a1f3c8e2" })

  1. REQUEST_STATE_HASH → browser → current compositeHash
  2. BFS on state graph: startHash → targetHash
     If no path: try URL fallback (navigate_to target URL)
  3. For each edge: execute action → verify hash
  4. Final verification: actualHash == targetHash?
```

### Confidence Scoring

Edge confidence = base_score × recency_factor × consistency_factor

| Factor | Calculation |
|--------|-------------|
| base_score | count=1 → 0.4, count=2 → 0.6, count>=3 → 0.8, count>=10 → 0.95 |
| recency_factor | <1hr → 1.0, <1day → 0.9, <1week → 0.7, older → 0.5 |
| consistency_factor | single target → 1.0, multiple targets → maxCount/totalCount |

---

## Warning Codes

| Code | Severity | Meaning | Action |
|------|----------|---------|--------|
| `STALE_DATA` | warning | Data is older than `staleThresholdMs` (default 30s) | Call `refresh_data` before relying on data |
| `ADAPTER_LIMITED` | info | Framework adapter returned a note about partial data | Check adapter capability matrix above |
| `PARTIAL_TREE` | warning | Framework data is incomplete (usually production build) | Use `get_dom_snapshot` as fallback, or run site in dev mode |
| `NO_MATCH` | info | Fuzzy text search returned no results above `minScore` | Try different query or lower `minScore` |

---

## Config Keys & Severity

| Key Path | Recommended | Severity if Changed | Effect |
|----------|:---:|:---:|---------|
| `plugins.*` | `true` | safe | Disabling plugins reduces data available to agent |
| `security.allowExecuteJs` | `true` | danger | Disabling blocks `execute_js` tool entirely |
| `security.allowActions` | `true` | danger | Disabling blocks all write actions |
| `security.allowScreenshots` | `true` | danger | Disabling blocks `capture_screenshot` |
| `security.allowExplorer` | `true` | warning | Disabling blocks `trigger_explorer` |
| `collection.staleThresholdMs` | `30000` | warning | Lower = more frequent staleness warnings |
| `textCoords.level` | `"word"` | safe | `"block"` = less granular text coordinates |
| `agentControl.allowAgentConfig` | `false` | danger | `true` allows agent to change config via `set_config` |
| `agentControl.autoRevertConfig` | `false` | warning | `true` auto-reverts danger/warning changes on restart |
| `agentControl.screenshotMarks` | `false` | safe | `true` enables SoM markers by default |
| `stateGraph.maxNodesInMemory` | `500` | safe | Lower = more aggressive LRU eviction |
| `stateGraph.autoTagging` | `true` | safe | Disabling stops automatic tag generation |

---

## File Locations

### Server-side
```
server/
  index.js              — Main server: HTTP + WebSocket + cache writer
  mcp-server.js         — MCP tool definitions (35 tools) and callTool() handlers
  cache-writer.js       — Session cache, freshness tracking, console log buffer
  config-change-log.js  — Config audit, validation rules, auto-revert logic
  state-machine.js      — Backward-compat wrapper → state-store.js
  state-store.js        — State graph: nodes, edges, gzip persistence, LRU eviction
  state-fingerprint.js  — FNV32 hash engine, ND filter, composite hash
  state-semantic.js     — Label generation, tag extraction, keyState, fuzzy search
  state-navigator.js    — BFS path finding, action replay, hash verification
```

### Extension-side (Chrome MV3)
```
extension/
  background/sw.js      — Service worker: WS client, command router, SoM overlay
  injected/
    bridge.js           — ISOLATED world → background relay
    collector.js        — Aggregates plugin outputs, posts to bridge
    executor.js         — Click/type/key/scroll/JS execution in MAIN world
    explorer.js         — Autonomous exploration: composite hash, loop detection
    state-reporter.js   — REQUEST_STATE_HASH handler, watchMode
    plugin-system.js    — Plugin registry with hot enable/disable
    version-helper.js   — Runtime framework version detection
    adapters/
      react.js          — React Fiber tree via bippy; writes __SI_REACT_HASH__
      vue3.js           — Vue 3 component tree via devtools hook
      vue2.js           — Vue 2 component tree via devtools hook
      angular.js        — Angular component tree via ng.probe
      svelte.js         — Svelte stores + CSS scoping hashes
      preact.js         — Preact component tree via devtools hook
      alpine.js         — Alpine.js x-data and stores
      solid.js          — SolidJS signals, stores, hydration markers
      dom-generic.js    — Fallback: DOM tree + ARIA + window globals
    analyzers/
      text-coords.js    — Visible text with pixel coordinates + fuzzy search
      network.js        — PerformanceObserver + fetch/XHR interception
      css.js            — CSS variables, stylesheet stats, computed styles
      ui-catalog.js     — Interactive elements: buttons, links, inputs
      perf.js           — Web Vitals: LCP, FCP, CLS, INP, TTFB
      dom-mutations.js  — DOM change tracking
      accessibility.js  — ARIA tree via tree-walker
      console-logger.js — console.* method override
      storage-reader.js — localStorage, sessionStorage, cookies
  lib/
    bippy.iife.js       — React Fiber traversal (third-party, bundled)
```

### Firefox MV2
```
firefox-mv2/
  background/background.js  — Event page (mirrors sw.js, uses canvas for SoM)
  injected/                 — Identical to extension/injected/ (includes state-reporter.js)
  manifest.json             — Manifest V2 with browser_specific_settings
```

### Configuration
```
config.json     — Server config: plugins, security, collection, agentControl, stateGraph
.env            — Environment overrides: WHISKOR_<SECTION>_<KEY>=<value>
```

### Cache
```
cache/
  {tabId}/
    _index.json             — Session index: URL, title, file list, freshness map
    raw/
      visual/text-coords.json
      network/requests.json
      ui/elements.json
      accessibility/tree.json
      storage/data.json
      console/logs.json
      perf/metrics.json
      css/analysis.json
      dom/snapshot.json
      react_snapshot.json   — If React detected
      vue_snapshot.json     — If Vue 3 detected
      ...
  graphs/
    {siteVersion}.json.gz   — State graphs (gzip compressed)
    snapshots/
      {siteVersion}/{hash}.snap.json.gz  — Full state snapshots
```

---

## Quick Reference: Agent Workflow

### Perception workflow
```
1. get_sessions()                → discover available tabIds
2. get_index(tabId)              → see what data is available + freshness
3. capture_screenshot(tabId, marks=true)  → see page with numbered elements
4. get_text_coords(tabId)        → find text with pixel coordinates
5. get_ui_catalog(tabId)         → find clickable elements
6. click(tabId, text="...")      → interact with the page
7. refresh_data(tabId)           → get fresh data after interaction
8. Repeat from step 3
```

### State navigation workflow
```
1. list_states()                 → discover recorded states with labels
2. search_states("cart")         → find states matching a query
3. get_state_detail(hash)        → inspect a specific state
4. get_navigation_path({fromHash, toHash})  → dry-run path check
5. navigate_to_state({tabId, hash})  → navigate to the state
6. capture_screenshot(tabId)     → verify the result
```

### State bookmarking workflow
```
1. list_states({ sortBy: "visitCount", limit: 10 })
2. pin_state({ hash: "a1f3c8e2", label: "Cart baseline", tags: ["test-baseline"] })
3. Later: list_states({ tags: ["test-baseline"] }) → bookmarked states only
```
