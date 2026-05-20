# browser-whiskor v3

**Agent-grade browser perception and state navigation.** A Chrome/Firefox extension + MCP server that gives AI agents "eyes" into the browser — framework state, DOM structure, text coordinates, network traffic — and the ability to navigate between recorded UI states.

## What This Is (and Isn't)

**This is a perception and state management tool.** It gives AI agents rich, structured visibility into what's happening inside a browser tab, plus a semantic state graph that enables navigation between recorded UI states.

**What it provides (senses):**
- **Sight:** Component trees, state, props, hooks for React/Vue/Angular/Svelte/etc.
- **Touch:** Text content with pixel-precise coordinates (OCR-style)
- **Hearing:** Network requests/responses, console logs
- **Spatial awareness:** UI catalog (buttons, links, forms), accessibility tree, CSS layout
- **Memory:** Semantic state graph with labels, tags, and action paths between states

**What it also has (hands):**
- Click, type, navigate, scroll, and other browser actions
- State-based navigation: "go to the cart page" via recorded action replay

These action features work, but they live outside the core purpose of this project. **For reliable browser automation, we recommend pairing browser-whiskor with a dedicated browser control tool** (Playwright, Puppeteer, or a browser-use agent). The action layer here is useful for simple follow-up actions after perception and state navigation, but it is not a replacement for a proper automation framework.

## Framework Support — Honest Depth Report

Not all frameworks are supported equally. Here is the real state of each adapter:

| Framework | Depth | What You Get | Caveats |
|-----------|-------|-------------|---------|
| **React** | Deep | Full Fiber tree, hooks (useState/useRef/useEffect/etc.), Redux, Zustand, Jotai, MobX, Recoil, React Query, Router, render timings | Requires Bippy (bundled). Production builds work but hook names may be mangled. MobX/Recoil: best-effort detection via multi-layer failover |
| **Vue 3** | Deep | Component tree, setupState, props, Pinia stores, Vuex, Vue Router, provides | Production builds fully supported |
| **Vue 2** | Medium | Component tree, $data, $props, computed, Vuex, Vue Router | Relies on `__vue__` property; may miss deeply nested components |
| **Angular** | Medium | Component tree (Ivy), inputs, directives, NgRx store, Signals (v16+), Router | AngularJS (1.x) and Angular (2+) both supported but separately. NgRx detection depends on DevTools or injector access |
| **Svelte** | Medium | Svelte 4: component instances via DOM internals. Svelte 5: dev mode effect tree. Stores via subscribe-pattern scan, CSS scoping hashes | Production Svelte 4: component instances are not retained on DOM. Detection relies on internal property patterns |
| **Preact** | Medium | Component tree via vnode traversal, hooks, state. Multi-property-name probing for minified builds | Production builds mangle internal names; we probe candidates (`__k`, `_children`, etc.) but root vnode may not always be findable |
| **Alpine.js** | Medium | Components (`[x-data]` data), v3 stores via `Alpine.store()`, v2 registered components | v2/v3 both supported. Store access uses internal `_stores` map |
| **SolidJS** | Medium-Light | Dev mode: owner tree with signals/effects/memos. Production: SSR hydration markers, stores via 6-layer failover, router | Production builds: owner tree unavailable. Store detection uses DevTools hook → window scan → context providers → signal proxies → event closures → candidate names |

**In short:** React and Vue 3 are the most reliable. Everything else is "best effort" with multi-layer detection that works well in dev mode and reasonably in production.

## Architecture

```
AI Agent (Claude / Cursor / etc.)
    │ MCP (stdio)
    ▼
┌─ server/index.js ──────────────────────────────────────────────┐
│  ←── WebSocket ──→  extension/background/sw.js                 │
│                                                                │
│  ├─ mcp-server.js (35 tools)                                   │
│  ├─ cache-writer.js                                            │
│  ├─ action-executor.js                                         │
│  ├─ screenshot-manager.js                                      │
│  ├─ state-fingerprint.js    ← Unified hash engine (FNV32)      │
│  ├─ state-store.js          ← State graph + LRU + gzip         │
│  ├─ state-semantic.js       ← Labels, tags, keyState, search   │
│  ├─ state-navigator.js      ← BFS path finding + action replay │
│  └─ state-machine.js        ← Backward-compat wrapper           │
│                                                                │
│  extension/injected/                                           │
│  ├─ collector.js                                               │
│  ├─ state-reporter.js     ← Hash reporting + watchMode         │
│  ├─ explorer.js           ← Unified composite hash             │
│  ├─ analyzers/                                                 │
│  │   ├─ text-coords.js                                         │
│  │   ├─ network.js                                             │
│  │   ├─ ui-catalog.js                                          │
│  │   ├─ css.js                                                 │
│  │   ├─ perf.js                                                │
│  │   ├─ accessibility.js                                       │
│  │   ├─ console-logger.js                                      │
│  │   └─ storage-reader.js                                      │
│  └─ adapters/                                                  │
│      ├─ react.js (deep) ← writes __SI_REACT_HASH__            │
│      ├─ vue3.js (deep)                                         │
│      ├─ vue2.js / angular.js / svelte.js                       │
│      └─ preact.js / alpine.js / solid.js                       │
└────────────────────────────────────────────────────────────────┘
```

## State Graph & Navigation

browser-whiskor builds a semantic state graph as you browse or run the autonomous explorer. Each state is identified by a composite hash (React state priority, DOM fallback) and enriched with:

- **Auto-generated label:** "Cart page (2 items, $49.99 total)"
- **Semantic tags:** `["authenticated", "cart-open"]`
- **keyState:** Important values extracted from Redux/Zustand stores
- **Action edges:** Recorded transitions with confidence scores

### Workflow

1. **Discover states:** `list_states()` or `search_states("cart")`
2. **Inspect a state:** `get_state_detail(hash)`
3. **Check path:** `get_navigation_path({ fromHash, toHash })` (dry-run)
4. **Navigate:** `navigate_to_state({ tabId, hash })` — replays recorded actions with hash verification

### State Hashing

States are identified by a composite hash:
- **reactHash:** Component tree shape + router path + store keys (FNV32, non-deterministic values filtered)
- **domHash:** URL pathname + interactive element signatures
- **compositeHash:** `FNV32(reactHash + domHash)` if React is available, otherwise `domHash`

Non-deterministic values (timestamps, UUIDs, loading flags) are excluded from hash computation to ensure stable state identification.

## Setup

```bash
cd browser-whiskor-v3
npm install
node server/index.js
```

### Chrome/Edge (MV3)
1. `chrome://extensions` → Developer mode ON
2. "Load unpacked" → select `extension/` folder

### Firefox (MV2)
1. `about:debugging` → This Firefox → Load Temporary Add-on
2. Select `firefox-mv2/manifest.json`

## MCP Configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "browser-whiskor": {
      "command": "node",
      "args": ["/path/to/browser-whiskor-v3/server/index.js"]
    }
  }
}
```

---

## Explorer — Honest Assessment

The autonomous exploration engine (`explorer.js`) uses a unified composite hash for state identification, fuzzy element matching, loop detection, and depth limiting. Current status:

- **Unified hashing:** React state (when available) + DOM signature ensures accurate state deduplication across SPA navigations
- **Element matching:** Token overlap + character bigram similarity for fuzzy text matching
- **Loop detection:** Revisits the same state hash N times → backtracks
- **Depth limiting:** Configurable max depth (default: 20)
- **State graph:** All transitions recorded with confidence scores based on observation count and recency

**What it does well:** Builds a navigable state graph of the application. The graph can be queried and traversed by agents using `navigate_to_state`.

**What it cannot do:** Handle authentication flows that require credentials, or navigate states that were never recorded in the graph.

**Recommendation:** Run the explorer to build the state graph, then use `navigate_to_state` for reliable state-based navigation.

## Chrome (MV3) vs Firefox (MV2) — Adapter Parity Report

The Chrome and Firefox builds share the same architecture but **adapter implementations differ significantly**. Firefox MV2 uses a synchronous XHR injection model and ships with older, simpler adapter versions.

| Framework | Chrome (MV3) | Firefox (MV2) | Parity | Notes |
|-----------|-------------|---------------|--------|-------|
| **React** | 724 lines | 436 lines | ~60% | Firefox lacks MobX/Recoil detection. Core Fiber tree + Redux/Zustand/Jotai/React Query are identical |
| **Vue 3** | 308 lines | 125 lines | ~40% | Firefox lacks: dynamicChildren traversal, Vuex extraction, Vue Router extraction, `__nuxt` selector |
| **Vue 2** | 170 lines | 90 lines | ~53% | Firefox lacks: `_findRoot` multi-candidate scan, `_extractComputed`, `_extractRouter` |
| **Angular** | 332 lines | 107 lines | ~32% | Firefox is a minimal stub: only detects AngularJS scope tree. No Ivy API, no NgRx, no Signals, no Router |
| **Svelte** | 257 lines | 41 lines | ~16% | Firefox only counts `svelte-xxxxxx` class hashes. No component instance extraction, no store detection |
| **Alpine.js** | 117 lines | 45 lines | ~39% | Firefox only extracts `[x-data]` attributes. No `_x_dataStack` merging, no store detection |
| **Preact** | 197 lines | 42 lines | ~21% | Firefox only detects presence. No vnode traversal, no hook extraction |
| **SolidJS** | 484 lines | 33 lines | ~7% | Firefox only reads `data-hk` attributes. No owner tree, no store detection, no router |

**Why the gap:** Firefox MV2 uses a synchronous XHR injection model (`injector.js`) which loads scripts at `document_start`. The adapters were initially written as minimal stubs to verify the injection pipeline worked. The Chrome MV3 adapters evolved with the project; Firefox adapters did not receive the same iteration.

**What works the same on both:** React (core), network capture, text-coords, UI catalog, CSS analysis, perf metrics, accessibility tree, console logger, storage reader, action executor, state reporting.

**Recommendation:** If you need deep framework introspection on Firefox, use Chrome/Edge. Firefox is fully functional for DOM-level perception (text, UI catalog, network, accessibility) but framework adapters are best-effort.

## Data Quality Warnings

Responses may include a `_warnings` array when data is incomplete or collected under degraded conditions:

```json
{
  "_warnings": [
    { "code": "ADAPTER_LIMITED", "message": "Firefox MV2 adapter: only hydration markers available." },
    { "code": "STALE_DATA", "ageMs": 45000, "message": "Data is 45s old. Consider calling refresh_data." }
  ]
}
```

Warning codes:
| Code | Meaning |
|------|---------|
| `ADAPTER_LIMITED` | Framework adapter is a stub or significantly reduced vs Chrome |
| `STALE_DATA` | Data age exceeds freshness threshold (default: 30s) |
| `PARTIAL_TREE` | Component tree was truncated (depth limit or serialization error) |
| `NO_FRAMEWORK` | No framework detected; `get_framework_state` returned generic DOM |
| `NO_MATCH` | Fuzzy text search returned no results above minScore |

---

## MCP Tools (v3.2: 35 tools)

### Perception (READ)

| Tool | Description |
|------|-------------|
| `get_sessions` | Active tabs (tabId, URL, data freshness) |
| `get_index` | Session file listing with summaries |
| `get_text_coords` | Text + absolute coordinates with fuzzy search and similarity scoring |
| `get_framework_state` | Component tree + state for detected framework |
| `get_network` | Captured HTTP requests/responses |
| `get_ui_catalog` | Buttons, links, forms listing |
| `get_accessibility` | ARIA accessibility tree |
| `get_storage` | localStorage / sessionStorage / Cookies |
| `get_console_logs` | Console output + unhandled errors |
| `get_perf_metrics` | Web Vitals (LCP, FCP, CLS, TTFB) |
| `get_css_analysis` | CSS variables, stylesheets |
| `get_dom_snapshot` | Generic DOM tree / global variables |
| `get_state_map` | State transition graph from exploration |

### State Navigation

| Tool | Description |
|------|-------------|
| `list_states` | List all recorded states with semantic labels, tags, and visit counts |
| `search_states` | Fuzzy-search states by label, tags, URL, or keyState |
| `get_state_detail` | Full metadata for a specific state, optionally with snapshot |
| `pin_state` | Bookmark a state with a custom label and tags |
| `navigate_to_state` | Navigate to a target state by replaying recorded actions (BFS path + hash verification) |
| `get_navigation_path` | Dry-run: check if a path exists without executing actions |

### Action (WRITE)

> These work but are not the focus of this project. For serious browser automation, use Playwright/Puppeteer alongside browser-whiskor.

| Tool | Description |
|------|-------------|
| `navigate_to` | Navigate to URL |
| `click` | Click by selector, text, or coordinates |
| `type_text` | Text input (React synthetic event aware) |
| `press_key` | Keyboard shortcuts |
| `hover` | Hover (dropdowns, tooltips) |
| `scroll_page` | Scroll |
| `select_option` | `<select>` value |
| `check_box` | Checkbox toggle |
| `execute_js` | Arbitrary JavaScript |
| `wait_for_element` | Wait for element |
| `go_back` / `go_forward` | Browser history |
| `reload_page` | Reload |

### Capture

| Tool | Description |
|------|-------------|
| `capture_screenshot` | Screenshot (base64 PNG), optionally with numbered markers (SoM) |
| `refresh_data` | Trigger data collection + wait for completion |

### Control

| Tool | Description |
|------|-------------|
| `set_config` | Change extension settings |
| `get_config_changes` | Review config changes made during session |
| `trigger_collect` | Manual data collection |
| `trigger_explorer` | Start/stop autonomous exploration |

---

## Text Search — Fuzzy Matching

`get_text_coords` supports two search modes:

**`search`** — Exact substring match (case-insensitive). Fast, returns all containing items.

**`match`** — Fuzzy similarity search. Uses token overlap + character n-gram scoring. Returns results sorted by similarity score (descending, 0.0–1.0). Useful when you don't know the exact text — e.g., searching for `"sign in"` will also surface `"Login"`, `"Sign In"`, `"Log in"`.

```json
{
  "name": "get_text_coords",
  "arguments": {
    "tabId": 1234,
    "match": "login",
    "level": "blocks",
    "maxResults": 10
  }
}
```

Each result includes a `contextHint` field — a short description of the element's role (e.g., `"navigation link"`, `"form label"`, `"heading"`, `"button text"`) so the agent can understand *why* this text appears and in what context.

---

## Data Freshness

All data includes a `_freshness` field:
```json
{
  "_freshness": {
    "available": true,
    "capturedAt": 1716000000000,
    "ageMs": 1200,
    "isStale": false
  }
}
```

Data older than 30 seconds is marked `isStale: true`. Use `refresh_data` to get fresh data.

## HTTP API

```
GET  http://localhost:7892/health             → Connection status
GET  http://localhost:7892/api/config         → Current config
POST http://localhost:7892/api/config         → Change config
GET  http://localhost:7892/api/sessions       → Session list
POST http://localhost:7892/api/collect        → Manual collection
POST http://localhost:7892/api/screenshot     → Screenshot
POST http://localhost:7892/api/action         → Execute action
GET  http://localhost:7892/api/graphs         → State graph listing
GET  http://localhost:7892/                   → Dashboard
```

## Dependencies

Only **`ws`** (WebSocket). No other npm packages. The extension side is zero-dependency vanilla JS.

## Agent Config Control

Agents can modify server settings via `set_config`, but this is **disabled by default** for safety.

### Enabling agent config control

Set in `config.json`:
```json
{
  "agentControl": {
    "allowAgentConfig": true,
    "autoRevertConfig": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `allowAgentConfig` | `false` | Allow agents to change config via `set_config` |
| `autoRevertConfig` | `false` | Auto-revert non-recommended changes on next server restart |

### Non-recommended changes

The following changes trigger warnings and may be auto-reverted:
- Disabling security features (`allowExecuteJs`, `allowActions`, `allowScreenshots`)
- Disabling plugins (reduces perception capability)
- Extreme values (`react.maxDepth > 100`, `textCoords.maxWords > 20000`)

### Reviewing changes

Use `get_config_changes` to see what was modified:
```json
{
  "name": "get_config_changes",
  "arguments": { "activeOnly": true }
}
```

## Set-of-Marks (SoM) Screenshots

Instead of working with raw pixel coordinates, agents can request screenshots with **numbered markers** overlaid on interactive elements. This eliminates coordinate misidentification.

### Enabling

Set in `config.json`:
```json
{
  "agentControl": {
    "screenshotMarks": true
  }
}
```

### Usage

```json
{
  "name": "capture_screenshot",
  "arguments": {
    "tabId": 1234,
    "marks": true
  }
}
```

Response includes:
```json
{
  "ok": true,
  "dataUrl": "data:image/png;base64,...",
  "elements": {
    "1": { "tag": "button", "text": "Sign In", "center": {"x": 450, "y": 320}, "selector": "#login-btn" },
    "2": { "tag": "a", "text": "Forgot password?", "center": {"x": 450, "y": 380}, "selector": "a.forgot-link" },
    "3": { "tag": "input", "text": "Enter email...", "center": {"x": 450, "y": 260}, "selector": "input[type=email]" }
  },
  "_note": "Use element numbers to reference elements..."
}
```

The agent can then say "click element 1" instead of dealing with raw coordinates.

### Performance

- **Zero overhead when disabled** — marks rendering only runs when `marks: true` is passed
- **OffscreenCanvas** is used in the MV3 Service Worker (no DOM manipulation)
- Element collection uses a single `querySelectorAll` in the content script

## License

MIT
