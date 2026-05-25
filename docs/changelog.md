# Changelog

All notable changes to browser-whiskor.

## [3.11.0] — 2026-05-24

### Added
- **CSS Origin @layer Cascade 5 spec compliance** — `css-origin.js`: `buildLayerRegistry()` tracks `@layer` declaration order, `flattenRules()` recursively flattens `@layer`/`@scope`/`@media`/`@supports`/`@container`, unlayered rules treated as `Infinity` priority (always beats layered at equal specificity)
- **Sourcemap VLQ decoder** — `css-origin.js`: Pure JS `vlqDecode()`, `fetchSourceMap()` (data: URI + HTTP), `resolveSourceLine()` maps generated line → `{originalFile, originalLine, originalColumn}`. Session-scoped cache for maps.
- **Level 1 CSS Origin bridge** — `css-origin.js` sends `postMessage(CSS_ORIGIN_RESOURCE_REQUEST)` → `bridge.js` (reqId forwarding) → `sw.js` (routing) → `panel.js` (`chrome.devtools.inspectedWindow.getResources()` + `getContent()`) → reverse path via `scripting.executeScript` injection into MAIN world. 500ms timeout fallback.
- **Framework snapshots to correlator** — `server/core.js`: `REACT_SNAPSHOT`, `VUE_SNAPSHOT`, `VUE2_SNAPSHOT`, `VUE3_SNAPSHOT`, `ANGULAR_SNAPSHOT`, `SVELTE_SNAPSHOT` now feed `correlator.addMessage()` for improved Rule 2/3 causal chain accuracy (without chain persistence).

### Changed
- **css-origin.js acquisitionLevel default** — `|| 4` → `?? 4` (nullish coalescing) so `acquisitionLevel: 0` correctly disables Level 1 instead of falling back to 4.
- **source-fetcher.js dependencies** — `[]` → `['css', 'css-origin']` so SourceFinder runs after both CSS analyzers.
- **devtools.js simplified** — Removed 69-line polling loop (`collectLevel1Css`, `startL1Polling`, `__SI_DEVTOOLS_CSS_CACHE__`). Level 1 bridge moved to `panel.js` where `getResources()` is available.
- **core.js message routing refined** — Generic DOM snapshots (cache + dashboard only) separated from framework snapshots (cache + dashboard + correlator). `STATE_HASH_REPORT` and `TRANSITION_HISTORY` correlator calls removed (they added no causal value). `_persistCausalChains` argument fixed.

### Fixed
- **bridge.js reqId lost** — `CSS_ORIGIN_RESOURCE_REQUEST` correlation ID (`reqId`) now forwarded in `postMessage`→`runtime.sendMessage` conversion.
- **Old Level 1 polling removed** — `devtools.js` no longer uses `chrome.devtools.inspectedWindow.eval()` for CSS extraction. Replaced by on-demand `getResources()` + `getContent()` bridge.

### Firefox MV2
- All above in `firefox-mv2/`: css-origin.js, source-fetcher.js, panel.js, background.js, bridge.js, devtools.js synced.

---

## [3.10.0] — 2026-05-22

### Added
- **3 new analyzers** — `shadow-dom.js` (Shadow DOM perception: 60 roots, 600 nodes/root, per-root MutationObserver, closed root handling, slot resolution, 80ms delta debounce), `dom-mutations.js` v2 (content recording with before/after attribute values & characterData, bigram-based batching with 80ms debounce, per-element caps: 40 structural/30 text/10 attributes, overflow counter), `dom-snapshot.js` (3000-node budget structural snapshot, same-origin iframe recursion, form state capture, targeted mode via SNAPSHOT_ELEMENT, real-time delta stream)
- **Element-level screenshot capture** — `capture_element_screenshot` MCP tool with selector/rect/padding/format/quality options; `cropImage()` added to both Chrome MV3 (`sw.js` via OffscreenCanvas) and Firefox MV2 (`background.js` via `<canvas>`); `ELEMENT_CAPTURE_RESULT` routed through server core
- **File splitting** — `react.js` → `react-hooks.js` (classifyHook, getHooks) + `react-state-managers.js` (detectStateManagers) + `react.js` (main adapter); `state-store.js` → `state-persistence.js` (persistGraph, loadGraph, save/loadSnapshot)
- **`read.js` split into 4 files** — `read-helpers.js` (fuzzy matching helpers), `read-basic.js` (tools 1–5), `read-data.js` (tools 6–13), `read-state.js` (tools 14–21)
- **Dev tooling** — `.eslintrc.json`, `.prettierrc`, bash scripts (`scripts/sync-shared.sh`, `scripts/validate.sh`) alongside existing PowerShell scripts
- **Archive tests** — `tests/archive/mcp-capture.test.js` (element capture tool logic), `tests/archive/sw.test.js` (cropImage geometry clamping)

### Changed
- **react.js split** — Maintains backward-compatible IIFE; new files register on `window.__SI_REACT_HOOKS__` and `window.__SI_REACT_STATE_MANAGERS__` globals
- **state-store.js split** — Persistence functions extracted to `state-persistence.js`; `persistGraph` calls updated to pass `graphs` Map parameter to avoid circular requires
- **cache-writer.js hot-path I/O** — `getSession` and `updateIndex` converted from sync `fs` to await `fs.promises` (`fsp.mkdir`, `writeJsonAsync`)
- **React adapter loading order** — `manifest.json` (both Chrome & Firefox) updated: `bippy.iife.js` → `react-hooks.js` → `react-state-managers.js` → `react.js`
- **Content scripts** — Both manifests now include `shadow-dom.js` and `dom-snapshot.js` after `dom-mutations.js`; all shared/ files synced to extension/ and firefox-mv2/
- **Test count** — 308 tests pass (277 unit, 20 integration, 11 stress)

### Fixed
- **README.md naming** — References to `state-machine.js` corrected to `state-store.js`
- **Archive stub tests** — `mcp-capture.test.js` and `sw.test.js` updated from stubs to proper assertions

---

## [3.9.0] — 2026-05-22

### Added
- **Navigate lock** (`state-navigator.js`) — tab-level `navigating` Map prevents concurrent `navigate()` calls on the same tab, returning `CONCURRENT_NAVIGATION` error instead of corrupting state.

### Changed
- **Async I/O in WS handler** — `handleMessage()` in `cache-writer.js` now uses `fs.promises` for all file writes/reads. TEXT_COORDS read→merge→write no longer blocks the event loop.
- **CORS restricted** — HTTP API `Access-Control-Allow-Origin` changed from wildcard `*` to localhost-only by default. Respects `allowedMcpOrigins` config when set to specific origins.
- **Console.error → console.log** — Info-level cache events (PAGE_NAVIGATED, TEXT_COORDS, etc.) now log to `console.log` instead of `console.error`. Actual errors (I/O failures, path traversal) remain on stderr.
- **Test counts** — 277 unit / 299 total (was 282 / 313). Two inline-implementation stubs archived to `tests/archive/` with documentation notes.

### Fixed
- **`readSessionFile` path traversal** — Added `path.resolve()` + `startsWith(dir)` validation. Blocks `../../etc/passwd` style attacks even though `relPath` is currently hardcoded.
- **Dashboard viewport jitter on page navigation** — `cache-writer.js` now deletes stale `text-coords.json` on `PAGE_NAVIGATED`. Dashboard explicitly clears `S.words` and calls `resetCanvasView()`.

---

## [3.8.0] — 2026-05-22

### Added
- **WhiskorCore** (`server/core.js`) — Extracted core server logic (socket management, message routing, broadcast, config push, HTTP handling) into a testable class. Enables real code coverage measurement without starting full server.
- **Server fixture integration** — `tests/helpers/server-fixture.js` now wraps `WhiskorCore` with injected stubs, providing accurate coverage of routing logic.
- **`_route()` test alias** — Added to `ServerFixture` for direct message routing in unit tests.

### Changed
- **server/index.js** — Refactored to instantiate `WhiskorCore` with real modules (cache, actions, screenshots, state-machine, etc.). Reduced from 484 → 210 lines. All routing logic delegated to core.
- **Test coverage** — 273 unit tests now measure real server routing logic instead of mock implementations.

### Fixed
- **`_pendingActions` closure bug** — Fixed `this` reference in `actions.handleResult` stub within `server-fixture.js`.
- **Default stub syntax errors** — Fixed `getSessionList() []` → `getSessionList() { return []; }` and similar in `core.js`.

---

## [3.7.0] — 2026-05-22

### Added
- **Shared Code Infrastructure** (`shared/injected/`) — 19 common files extracted from Chrome/Firefox extensions into a single source of truth. Eliminates manual sync overhead.
- **Auto-Sync CI** (`.github/workflows/ci.yml`) — Automatically copies `shared/` changes to both `extension/` and `firefox-mv2/` on push. Verifies sync integrity via hash comparison.
- **Sync Script** (`scripts/sync-shared.ps1`) — Local tool to propagate `shared/` changes to both extensions (`-CheckOnly`, `-DryRun` modes supported).
- **Scroll-Triggered Text Collection** — `IntersectionObserver` in `text-coords.js` now triggers `collect()` when new text elements enter the viewport, ensuring offscreen texts are cached.
- **11 unit tests** for IntersectionObserver scroll-triggered collection (`seen-text-tracker.test.js`).

### Fixed
- **HOST binding security issue** — `WebSocketServer` and `httpServer` now bind to configured `HOST` (default: `127.0.0.1`) instead of `0.0.0.0`.
- **CI flaky tests on Linux** — WebSocket disconnect tests now use polling (`waitFor`) instead of event waiting, fixing timeout failures on GitHub Actions runners.
- **Scroll-triggered collection not working** — Added debounced `api.emit()` call when `IntersectionObserver` detects new elements.

### Changed
- **CI report format** — Per-file test results with ASCII-formatted summary, pass rate, and sync status.
- **Test timeout** — `waitEvent` default timeout increased from 2s to 5s for CI stability.
- **Documentation**: Archived `DESIGN_V2.md` to `docs/archive/`, updated `update-report.md` to v3.6.0.
- **`.gitignore`** — Added temporary directories (`.idea/`, `cache/`, `playwright-report/`, `test-results/`).

### Removed
- **Duplicate files** — 19 identical files removed from `extension/injected/` and `firefox-mv2/injected/`. Now sourced from `shared/injected/`.
- **Stale test archive** — `tests/archive/` (5 skeleton tests) removed; full versions exist in `integration/` and `stress/`.

---

## [3.6.0] — 2026-05-22

### Added
- **Dynamic Tool Profile Manager** (`tool-manager.js`) — Manages MCP tool visibility based on context, auto-detection, and AI requests. Core tools (12) are always available. Other profiles load on demand or auto-trigger, and auto-unload after idle turns.
- **Tool Profiles** (`configs/tool-profiles.json`):
  - `core` (12 tools) — Basic perception and interaction. Always loaded.
  - `debug` (+6) — Console, storage, perf, CSS, DOM, accessibility. Auto-loads on debug triggers.
  - `state-nav` (+7) — State graph navigation. Auto-loads on state-related calls.
  - `delta` (+3) — UI change tracking. Auto-loads after page interactions.
  - `advanced-actions` (+10) — Drag, hover, select, etc. Auto-loads when needed.
  - `admin` (+4) — Server config. Requires `allowAgentConfig`.
  - `power` (+2) — JS execution, explicit waits. Requires `allowExecuteJs`.
- **4 new MCP tools:**
  - `load_profile` — Load a tool profile dynamically
  - `unload_profile` — Unload a profile to free context
  - `search_tools` — Discover available tools without loading them
  - `profile_status` — Check active profiles and idle turns
- **Auto-detection**: Server infers intent from tool calls and loads relevant profiles automatically.
- **Idle unloading**: Profiles not used for N turns are automatically removed to keep AI context lean.
- **Usage warnings**: AI receives warnings when a profile has been active for many turns, encouraging load→use→unload→reload best practices.
- **Session reset**: All profiles reset on MCP reconnect for clean state.
- **14 unit tests** for tool manager (session management, profile loading, auto-detection, idle unload, warnings).

### Changed
- **MCP tool count: 45 → 49**
- **Tool filtering**: Registry now uses tool manager for dynamic visibility.
- **Server integration**: Tool manager initialized on MCP startup with session ID.

---

## [3.5.0] — 2026-05-21

### Added
- **Smart Delta Engine** (`delta-engine.js`) — Aggregates `TEXT_COORD_DELTA` frames into semantic events. Motion clustering groups elements with identical movement vectors. Scroll detection classifies bulk movement (70%+ threshold). Decorative CSS animations (opacity/color/shadow-only) are filtered out.
- **Pattern Registry** (`pattern-registry.js`) — UI patterns are hashed and stored on first appearance. Subsequent appearances are sent as compact reference IDs (`pat-xxxx`). Supports `lookup_pattern` for lazy detail retrieval when AI needs to "remember" a pattern.
- **3 new MCP tools:**
  - `get_delta` — Get latest aggregated UI changes (scroll, motion groups, content updates, appearances)
  - `list_patterns` — List all known UI patterns for a tab
  - `lookup_pattern` — Look up full definition of a pattern by reference ID
- **Delta integration in server** — `TEXT_COORD_DELTA` and `VIEWPORT_UPDATE` messages feed into the delta engine. Aggregated deltas are stored in cache for MCP access.
- **22 unit tests** for delta engine and pattern registry (motion clustering, scroll detection, pattern hashing, frame buffering).

### Changed
- **MCP tool count: 42 → 45**
- **`TEXT_COORD_DELTA` handling** — Now feeds delta engine in addition to dashboard broadcast.

---

## [3.2.0] — 2026-05-20

### Added
- **State graph with semantic labels** — Each recorded UI state has an auto-generated label ("Cart page (2 items, $49.99 total)"), semantic tags (`["authenticated", "cart-open"]`), and keyState (important values extracted from Redux/Zustand stores).
- **Unified composite hash** — Three-layer hash system: `reactHash` (component tree + router + store keys), `domHash` (URL + interactive elements), `compositeHash` (FNV32 combination). Non-deterministic values (timestamps, UUIDs, loading flags) are excluded from hash computation.
- **State navigation** — `navigate_to_state` replays recorded actions via BFS shortest path with per-step hash verification. Falls back to URL navigation if no recorded path exists.
- **6 new MCP tools:**
  - `list_states` — List all recorded states with labels, tags, visit counts
  - `search_states` — Fuzzy-search states by label, tags, URL, or keyState
  - `get_state_detail` — Full metadata for a state, optionally with snapshot
  - `pin_state` — Bookmark states with custom labels and tags
  - `navigate_to_state` — Navigate to a target state by replaying actions
  - `get_navigation_path` — Dry-run path check without executing actions
- **Non-deterministic filter** — Excludes timestamps, UUIDs, long random strings, and configurable keys from state hash computation for stable identification.
- **Multi-layer storage** — L1 in-memory graph, L2 gzip-compressed disk persistence, L3 LRU eviction with protected tags.
- **REACT_TRANSITION handler** — Previously swallowed events now recorded as state graph edges.
- **state-reporter.js** — Extension-side module for REQUEST_STATE_HASH handling and watchMode during navigation replay.
- **Edge confidence scoring** — Based on observation count, recency, and transition consistency.

### Changed
- **Explorer uses unified hash** — `explorer.js` now computes `compositeHash` from `reactHash` + `domHash` instead of its own independent hash.
- **react.js writes `__SI_REACT_HASH__`** — React adapter exposes its hash globally for composite hash calculation.
- **state-machine.js is now a wrapper** — Delegates to `state-store.js` for backward compatibility.
- **EXPLORER_STATE_UPDATE payload extended** — Now includes `reactHash` and `domHash` alongside `compositeHash`.

### Fixed
- **REACT_TRANSITION events were swallowed** — Added handler in `server/index.js` to record React state transitions as graph edges.
- **Hash inconsistency between explorer and React adapter** — Unified to FNV32 algorithm with same input structure.

---

## [3.1.0] — 2026-05-20

### Added
- **Set-of-Marks (SoM) screenshots** — `capture_screenshot(marks=true)` overlays numbered red circles on interactive elements. Returns an `elements` map so agents can reference elements by number instead of coordinates. Uses `OffscreenCanvas` (MV3) or `document.createElement('canvas')` (MV2).
- **Fuzzy text matching** — `get_text_coords(match="query")` performs token Jaccard + character bigram similarity search. Returns results sorted by score (0.0–1.0). Server-side implementation mirrors extension-side `text-coords.js` logic.
- **`contextHint` on text coordinates** — Each text item includes a role description (e.g. "navigation link", "form label", "button") for better agent understanding.
- **`get_config_changes` MCP tool** — Returns a log of config changes made during the session, with severity levels and auto-revert status.
- **Explorer v2** — Rewritten with fuzzy element matching, hash-based loop detection (`computeStateHash`), configurable `maxDepth`, and framework-agnostic state hashing.
- **Agent config control** — `agentControl` section in `config.json`:
  - `allowAgentConfig` — gate for `set_config` MCP tool (default: `false`)
  - `autoRevertConfig` — auto-revert non-recommended config changes on startup (default: `false`)
  - `screenshotMarks` — enable SoM markers by default (default: `false`)
- **Config change audit** — `config-change-log.js` tracks every config modification with `{keyPath, oldValue, newValue, severity, timestamp}`. Severity: `safe`, `warning`, `danger`.
- **Response warnings** — MCP responses include `_warnings` array with codes: `STALE_DATA`, `ADAPTER_LIMITED`, `PARTIAL_TREE`, `NO_MATCH`.

### Changed
- **Framework adapters synchronized** — All 9 Firefox MV2 adapters updated to match Chrome MV3 versions (React, Vue 3, Vue 2, Angular, Svelte, Preact, Alpine, Solid, DOM-generic).
- **README updated** — Added "eyes not hands" positioning, framework depth table, Chrome/Firefox parity table, Explorer limitations, SoM usage, agent config control docs.

### Fixed
- `injector.js` syntax error (escaped quotes from copy-paste).
- `archive_project.ps1` — strict analysis with unused variable detection, empty catch flagging, shadowing detection, redundant comparison removal.

---

## [3.0.0] — 2025-12-XX

### Added
- Initial browser-whiskor v3 release.
- Chrome MV3 extension with service worker background.
- Firefox MV2 extension with event page background.
- MCP server with 29 tools (read, write, capture, control).
- 9 framework adapters (React, Vue 3, Vue 2, Angular, Svelte, Preact, Alpine, Solid, DOM-generic).
- 9 analyzers (text-coords, network, CSS, UI catalog, perf, DOM mutations, accessibility, console, storage).
- Autonomous page explorer (BFS/DFS/random strategies).
- State-transition graph builder.
- Config system with `.env` overrides.
- Cache layer with freshness tracking.
- DevTools panel for manual inspection.
- WebSocket bridge between extension and server.
- Zero npm dependencies beyond `ws`.
