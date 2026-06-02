# Changelog

All notable changes to browser-whiskor.

> **Note on Versioning:** The versioning scheme was changed during development. The project transitioned from `3.x.x` (internal/development versioning) to `0.3.x` to prepare for the initial open-source release (OSS), reflecting its pre-1.0 status.

## [0.5.3] — 2026-06-02

### Added

- **Crash resilience / auto-restart** — the server now recovers on its own when the worker crashes. `npm start` and `start.ps1` run under a new zero-dependency supervisor (`scripts/supervisor.js`) by default, which restarts the worker on an *unclean* exit with backoff and a crash-loop guard (gives up after 5 crashes in 60s); a clean signal exit (code 0) is not restarted. Run the raw worker with `npm run start:raw` / `start.ps1 -NoSupervisor`. The `--mcp` process is intentionally not supervised (its lifecycle belongs to the agent).
- **No lost instructions during a restart** — in Proxy Mode the worker (heavy process: ports + cache + embeddings) and the MCP/stdio process the agent talks to are separate, so a worker crash never reaches the agent. `requestServer()` now retries connection-level forward failures (`ECONNREFUSED`/`ECONNRESET`/…) while the worker restarts (`config.json` → `resilience.proxyRetry`, default up to 15s), turning a restart into a brief pause instead of a dropped tool call. Only connection failures are retried — a refused connection never reached the worker, so re-sending cannot double-execute an action; HTTP error responses are returned as-is.

### Fixed

- **No corrupted cache on crash** — `cache-writer` now writes atomically (temp file → `rename`), so a crash mid-write leaves the previous file intact instead of a half-written JSON. On startup the integrity check additionally sweeps orphaned `*.tmp` files left by a crash (`cache-integrity.cleanupTempFiles`).
- **Clean shutdown handoff** — `uncaughtException` / `unhandledRejection` / `SIGTERM` / `SIGINT` now route through a single `shutdown()` that flushes in-memory network/console buffers synchronously (`cache.flushAllSync()`) before exiting (non-zero on crash so the supervisor restarts). Also lifts `httpServer` to module scope so the signal handlers no longer reference an out-of-scope binding.

## [0.5.2] — 2026-06-02

### Added

- **Related-input detection** — `analyze_click` and `get_ui_catalog` now surface `relatedInputs` (+ a `relatedInputsTip`) for action buttons: the input fields a button likely depends on (e.g. a code field that must be filled before a "join" button works), so the agent fills them first instead of hitting a validation alert. Association is layered — shared `<form>` / ARIA `aria-controls`|`aria-describedby` (confidence `high`) and a bounded nearest-common-container heuristic (confidence `low`). `confidence` is evidence-tiered with the `basis` exposed (not a fabricated number), and the tip hedges for low-confidence matches.

### Fixed

- **Stale version strings** — `start.ps1` banner now reads the version from `package.json`; `mcp-server.js` header and the README/CLAUDE.md titles no longer hardcode a version (which kept drifting each release).

### Docs

- Clarified that `shared/injected/` is **partial** coverage: 7 analyzers (`text-coords`, `network`, `css-origin`, `source-fetcher`, `ui-catalog`, `framework-dom-map`, `clickability`) plus `plugin-system.js` and `bridge.js` live outside `shared/` and must be edited in both `extension/` and `firefox-mv2/`. `sync-shared.ps1` only touches files present in `shared/`, so it does not overwrite those.

## [0.5.1] — 2026-06-02

### Fixed

- **Manual collect re-runs analyzers** — `MANUAL_COLLECT` with no plugin list called `registry.runAt('manual')`, which matched zero plugins (all register at `DOMContentLoaded`/`load`). The DevTools panel's Collect button, `refresh_data`, `trigger_collect`, and the adaptive scheduler therefore re-collected nothing but storage. It now re-runs the `DOMContentLoaded`+`load` phases.
- **Set-of-Marks marker drift** — Dashboard SoM markers drifted because the marks layer covers the preview container while the screenshot `<img>` is centred inside it (`margin:0 auto`); markers are now anchored to the image's rendered offset so they line up regardless of the target viewport's aspect ratio.

### Added

- **`GET /export`** — Downloads the session cache as a ZIP (optional `?tabId=` scopes to one session), fixing the panel's "ZIP" button which pointed at a nonexistent route. Uses a dependency-free `server/zip-writer.js` (zlib deflate + CRC32).

## [0.5.0] — 2026-06-02

### Added

- **CDP high-fidelity input** — `agentControl.input.highFidelity` (`off` | `fallback` | `always`) routes `click`/`type_text`/`press_key` through the Chrome DevTools Protocol (`chrome.debugger`) so events are `isTrusted:true`, reaching widgets gated on trusted input or user activation (popups, clipboard, file pickers, some payment/OAuth). Synthetic events stay the default; Chrome only (Firefox ignores the setting and stays synthetic). Requires the `debugger` permission (Chrome manifest).
- **Physical-fidelity synthetic input** — Synthetic keys now carry `code`/`keyCode`/`which` (pages gating on those no longer ignore the keystroke) and emit IME `composition` events for CJK / rich-text editors; typing uses `InputEvent` (`beforeinput`/`input`).
- **Screenshots as MCP image blocks** — `capture_screenshot` / `capture_element_screenshot` return the image as a viewable MCP image content block (not base64 inside JSON text) when `returnImage=true`; the default omits it (`filePath` only) to save tokens.

## [0.4.5] — 2026-06-02

### Added

- **Native dialog guard** — `window.alert/confirm/prompt` are overridden in the page (MAIN world) so a native dialog never blocks the event loop — which previously froze the click handler and timed the action out (the classic "click hangs because a modal popped"). The dialog's content is captured, auto-answered (alert dismissed; confirm/prompt per policy, overridable per call via a `dialog: {confirm, prompt}` option on `click`/`type_text`), and returned in `result.dialogs` with causal attribution (`direct` / `indirect` / `none`) to the triggering action.

### Fixed

- **Multi-browser action routing** — Actions and screenshots are now sent only to the service worker that owns the target tab (`core.sendToTab`) instead of being broadcast to every connected browser. Previously, when more than one browser ran the extension, a browser lacking the tab could answer "No tab with id" first and win the result race — causing flaky failures and hangs. Falls back to broadcast only when no connected SW is known to own the tab.
- **Tab-gone recovery** — When an action or capture targets a tab that was closed or reloaded into a new id, the service worker now returns a structured `tabGone` error with a `liveTabs` list (id/url/title) so the agent can retarget by URL or use `list_tabs` / `switch_tab`, instead of the raw Chrome "No tab with id". Capture also fails fast rather than silently grabbing the active tab.

## [0.4.4] — 2026-06-02

### Added

- **WAI-ARIA signals in `submit:"auto"` inference** — Beyond `enterkeyhint`, submit inference now reads `aria-keyshortcuts` (an authoritative declared shortcut, e.g. "Control+Enter"), `role="searchbox"` / `type="search"` (Enter submits), and `role="textbox"` + `aria-multiline` (`false` → single-line submit, `true` → newline), plus a `role="search"` landmark ancestor. Reported with `confidence:"aria"`. This resolves the Enter-vs-newline ambiguity on many contenteditable editors that set no `enterkeyhint`.
- **`find_target` live verification (`verify`)** — Set `verify:true` to re-check the top candidate(s) clickability live via `analyze_click` at call time instead of relying on the collection-time hint. It attaches a `live{exists,inViewport,obstructed,recommendedStrategy}` report and corrects `clickable` accordingly. Bounded by `verifyTop` (default 1) and prefers selector/text over coordinates so an overlay isn't mistaken for the target.

## [0.4.3] — 2026-06-02

### Changed

- **`find_target` deprioritizes obstructed candidates** — Ranking now demotes covered (`clickable:false`, −0.2) and offscreen (`clickable:null`, −0.05) candidates so a reachable target outranks a covered one of similar score, without overriding a clearly better text match. The reported `score` stays the true fuzzy score.
- **Wider `submit:"auto"` hint dictionary** — Submit inference now recognises `return` / `↵` / `⏎` as Enter, more modifier spellings (`ctrl`/`control`/`⌃`, `cmd`/`command`/`⌘`, `shift`/`⇧`), and more phrasings ("press/hit enter", "enterで送信", "return to send", "そうしん", …).
- **Stronger Svelte adapter** — `get_framework_state` (svelte) now also returns `metaComponents` (real component names/files from `__svelte_meta`, dev builds), `componentFingerprints` (per scoped-CSS-hash element counts + a sample — which work in production where instances are gone), and a `summary` of how many components each path found, so a production Svelte app reports useful context instead of an empty `components` list.

## [0.4.2] — 2026-06-02

### Added

- **`find_target` tool (core)** — A one-shot "where do I act for X?" resolver. It combines `get_ui_catalog` (buttons / links / inputs, with accessible-name labels) and `get_text_coords`, fuzzy-ranks them (MiniLM when available), and returns ranked candidates with click coordinates (`center`), a selector hint, `kind`, `score`, and — for inputs — the inferred `enterKey`. It finds an icon control by its label/tooltip (e.g. "送信") at the control's own coordinates rather than a floating tooltip overlay, and the returned `center` can be passed straight to `click(x, y)`. (61 → 62 tools; `core` profile 13 → 14.)
- **Clickability hints in `get_ui_catalog` / `find_target`** — Each interactive element now carries a collection-time `clickable` hint (`true` / `false` / `null` when offscreen) with `obstructedBy` (the covering element's selector) when something sits on top. Surfaced through `find_target` candidates so an agent can spot an obstructed target up front instead of after a failed click.
- **contenteditable / rich-text editors in `get_ui_catalog`** — Chat boxes and other `contenteditable` / `role="textbox"` editors are now catalogued among inputs (`type:"contenteditable"`) with an accessible-name `label` and inferred `enterKey`, so they're findable via `search` / `find_target` — not just native form fields.

## [0.4.1] — 2026-06-02

### Added

- **`type_text` submit inference (`submit:"auto"`)** — Infers the submit gesture from observable signals (`enterkeyhint`, a single-line `<input>` in a `<form>`, `<textarea>` = newline, hint text such as "Ctrl+Enter" / "送信"). It cannot read a page's JS keydown handlers, so it returns `submitInference {key, confidence, evidence}` with `key:null` (an honest "unknown") rather than guessing. `onFail` — `agentControl.submitInference.onFail` plus a per-call override — chooses `type-only` (default: type the text, skip submit) or `abort` (type nothing, return).
- **Pre-typing submit hint in `get_ui_catalog`** — Form inputs now carry `enterKey` (the same inference) so an agent knows how to submit before typing; inputs also gained a `label` (accessible name).
- **Fuzzy suggestions by default** — `get_text_coords` and `get_ui_catalog` now return MiniLM semantic `_suggestions` automatically when an exact `search` finds nothing (opt out with `includeSuggestions:false`); previously this required `includeSuggestions:true`. Search descriptions now point to fuzzy (`match:` / suggestions) when the exact wording is unknown.
- **`type_text` target echo** — The response reports the element actually typed into (`target:{tag,id,name,label,selector}`), so a wrong-target type (e.g. when `selector` is omitted and `activeElement` was unexpected) is caught immediately.

## [0.4.0] — 2026-06-01

### Added

- **Profile auto-load on tool call** — Calling a tool whose profile isn't loaded now auto-loads the owning profile and proceeds (reported via `_autoLoaded`) instead of bouncing the call back as unavailable — which agents repeatedly misread as "not implemented". Permission-gated profiles (`allowExecuteJs` / `allowAgentConfig`) are **not** auto-loaded and instead return a precise reason so the agent can ask the user. (`tool-manager.ensureToolVisible`, `mcp/registry.js`)
- **Configurable, token-light screenshots** — `capture_screenshot` no longer inlines the base64 image by default (large token cost); `filePath` is always returned and the image is saved to disk. New `agentControl.screenshot` config (`returnImageByDefault`, `format`, `quality`, `maxWidth`); when returned, the full screenshot is JPEG-encoded and downscaled to `maxWidth`. Per-call overrides: `returnImage` / `format` / `quality` / `maxWidth`. `capture_element_screenshot` is unaffected (already small).
- **`type_text` submit gestures** — New `submit` option (`enter` / `shift-enter` / `ctrl-enter` / `cmd-enter` / `none`) so the right submit/newline gesture can be chosen per app. `text` is now optional — submit an already-filled field with just `submit:"enter"` without loading the `press_key` profile. `pressEnter` kept as a legacy alias.
- **Accessible-name search** — `get_ui_catalog` buttons/links now carry a `label` resolved from `aria-label` / `title` / `alt` and the text of `aria-labelledby` / `aria-describedby` targets (e.g. a Material tooltip "送信") **at the element's own coordinates**. `click(text:)` matches the same — so an icon control is found by its label/tooltip rather than the floating tooltip overlay.

### Fixed

- **Proxy-mode read tools** — Read tools now `await` the proxy cache (which returns Promises over HTTP) instead of assuming a synchronous cache. Fixes `cache.freshnessInfo is not a function`, `getSessionList(...).find is not a function`, and `get_framework_state` falsely reporting "Available: none". Added `freshnessInfo` / `getConsoleLogs` proxy shims; the proxy `readSessionFile` now returns `null` for a missing file (404) instead of leaking `"File not found"` (fixes `get_viewport`).
- **`type_text` on contenteditable** — Rich-text editors (Gemini, Notion, …) have no `.value`; typing crashed with "Cannot read properties of undefined". They are now detected and driven via `execCommand('insertText')`.
- **`capture_element_screenshot`** — Replaced `new Image()` (undefined in MV3 service workers → "Image is not defined") with `createImageBitmap`; the crop now scales by the page's real `devicePixelRatio`.
- **Click diagnostics** — A click that triggers a full-page navigation no longer times out (the service worker reports soft success on main-frame `webNavigation.onCommitted`). A click whose target is removed/replaced by a re-render is no longer mislabeled `click_intercepted`.

## [0.3.4] — 2026-05-27

### Added

- **Coexistence Proxy Mode** — Resolves port binding conflicts (`EADDRINUSE`) when spawning multiple browser-whiskor instances (e.g., manually running a standalone server and editor-launched MCP clients).
  - Automatically checks `http://localhost:7892/health` on startup.
  - If active, switches to **Proxy Mode** where it skips binding HTTP/WebSocket ports and proxies all MCP commands to the running instance via HTTP requests.
  - Overrides the local `embed-service` to route semantic embedding requests to the remote instance (`POST /api/embed`), avoiding heavy local ONNX model loads or duplicate workers.

### Fixed

- **Firefox Extension Runtime Bugs**:
  - `css-origin.js` — Removed a syntax-breaking trailing backslash `\` at line 322.
  - `ui-catalog.js` — Fixed a `TypeError` by adding checks for `SVGAnimatedString` class types on SVG elements (aligning with Chrome's implementation).
- **Session Diagnostics**:
  - `get_sessions` MCP tool — Added warnings and detailed user notes when the active sessions list is empty, helping identify missing extension connections rather than returning a silent empty list.

## [0.3.3] — 2026-05-27

### Performance

- **VLQ Decoder Optimization** — Replaced `B64.indexOf()` with `B64_MAP.get()` for O(1) character lookups in source map parsing. Critical performance improvement for large production bundles: parsing time reduced from seconds to milliseconds. Applied to both browser-side (`css-origin.js`) and server-side (`source-map-resolver.js`) implementations.

### Security

- **MCP Origins Restriction** — Changed `allowedMcpOrigins` default from `["*"]` to `["localhost", "127.0.0.1"]`. Secure-by-default configuration prevents potential security risks in future HTTP-based integrations. Users must explicitly opt-in to allow external origins.

### Added

- **Disk Size Management** — Added LRU-based disk cache eviction to `cache-integrity.js`:
  - `calculateDiskUsage()` — Recursive directory size measurement
  - `getAllSessions()` — Enumerate sessions with metadata (path, updatedAt, size)
  - `enforceDiskLimit()` — Automatic cleanup of oldest sessions when exceeding `stateGraph.maxDiskMB`
  - Prevents unbounded disk growth in long-running deployments

### Documentation

- **Correlator Window Guidance** — Added comprehensive documentation to `correlator.js` explaining:
  - Correlation windows (Network→DOM: 500ms, Framework→DOM: 100ms)
  - Confidence scoring and decay curves
  - Adjustment guidance for heavy SPAs and slow networks
  - Priority rules (MutationObserver > TEXT_COORD_DELTA)
- **v0.3.3 Improvements Guide** — Created `docs/v0.3.3-improvements.md` with detailed explanations, testing recommendations, and migration guide

### Changed

- **Config Comments** — Added bilingual (EN/JA) warning comments for `allowedMcpOrigins` security setting

## [0.3.2] — 2026-05-27

### Added
- **Semantic Search (MiniLM ONNX)** — Upgraded text search to use a local `paraphrase-multilingual-MiniLM-L12-v2` model running in a background worker thread. Provides high-quality multilingual semantic similarity and fuzzy matching.
- **Model Pre-fetching** — Added `npm run download-model` to `postinstall` to automatically download the MiniLM model (approx 50MB) from Hugging Face Hub (no login required) and cache it in `.model-cache/`.
- **Search Services & Worker Pool** — Introduced new service layer (`embed-service.js`, `embed-worker-pool.js`, `embed-worker.js`, `load-monitor.js`) to handle asynchronous background embedding without blocking the MCP event loop.
- **Documentation Updates** — Updated `docs/architecture.md` and `README.md` to reflect the new semantic search architecture and `services/` directory.

## [0.3.1] — 2026-05-27
- Fix versioning issues.

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

## [3.0.0] — 2026-05-20

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
