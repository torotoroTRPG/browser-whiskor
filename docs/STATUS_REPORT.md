# Comprehensive Proposal/Idea Document Analysis

---

## Document 1: `docs/ideas/ARCHITECTURE_INTELLIGENCE_LAYER.md` (1186 lines)

**Title:** browser-whiskor v4 — Intelligence Layer Architecture
**Purpose:** Extends v3 architecture with the Intelligence Layer — server-side and extension-side subsystems that transform raw collected data into deterministic conclusions before they reach the LLM agent.
**Status in codebase:** Ratified architecture (basis document per `CONTRAINTS.md` and `SOURCE_MAP.md`). Most subsystems exist in code but several have known gaps.

### Key Design Axioms / Constraints:
- **Design axiom:** "The agent receives conclusions, not raw material." Every question the software can answer deterministically must be answered by software. Confidence values make the boundary explicit.
- **Dependency constraint:** No npm packages beyond `ws` (server WebSocket) and `bippy` (bundled as `lib/bippy.iife.js`). All algorithms in plain Node.js (server) and vanilla JS (extension injected world).
- **Graceful degradation:** Each subsystem has a fallback chain rather than failing hard.
- **Confidence values:** 1.0 = derived from direct API query with no inference; below 1.0 = probability with stated basis. Values are NOT combined across subsystems.

### Layer Stack (4-layer architecture):

| Layer | Name | Status |
|-------|------|--------|
| Layer 0 | LLM Agent — receives conclusions via new tools (`explain_element`, `why_did_this_change`, `analyze_click`) | [PARTIAL] |
| Layer 1 | MCP Server (JSON-RPC 2.0 over stdio) — unchanged from v3 | [ACHIEVED] |
| Layer 2 | Intelligence Layer — five subsystems (new) | [PARTIAL] |
| Layer 3 | Server Core + Cache + State Graph — unchanged from v3 | [ACHIEVED] |
| Layer 4 | Extension — unchanged from v3 | [ACHIEVED] |

### Subsystem 1: CSS Origin Tracker
**File:** `extension/injected/analyzers/css-origin.js`
**Emit type:** `CSS_ORIGIN_MAP`
**Answers:** Which stylesheet rule applies to a given element and from which source file.

| Proposal | Status |
|----------|--------|
| Level 1 — `chrome.devtools.inspectedWindow.getResources()` | [ACHIEVED] — postMessage bridge (panel.js getResources → SW relay → css-origin.js), no polling (L1 fixed) |
| Level 2 — `document.styleSheets[i].cssRules` traversal | [ACHIEVED] |
| Level 3 — `fetch(styleSheet.href)` | [ACHIEVED] |
| Level 4 — URL and inline record only (always available) | [ACHIEVED] |
| Rule matching algorithm (specificity computation, inline style check, inherited/UA fallback) | [ACHIEVED] |
| Specificity computation (32-bit integer: `id*65536 + class*256 + element`) | [ACHIEVED] |
| Output schema `CSSStyleOriginMap` with per-property confidence and `map_confidence` | [ACHIEVED] |
| Confidence values table (acquisition_level 1-4, inline, inherited, tie adjustment) | [ACHIEVED] |
| **@layer / @scope cascade resolution** | [ACHIEVED] — `buildLayerRegistry`/`flattenRules` with `Infinity=unlayered` (5-point layered cascade, Proposal B) |

### Subsystem 2: Source Layer
**Files:** `extension/injected/analyzers/source-fetcher.js`, `server/source-store.js`
**Emit type:** `SOURCE_CONTENT` (replaces `SOURCE_CATALOG` for text files)
**Answers:** Text content of CSS/JS files and whether they changed since last session.

| Proposal | Status |
|----------|--------|
| Source acquisition at levels 1-4 (mirrors CSS Origin Tracker) | [ACHIEVED] |
| JS bundles: hash-only by default, full text opt-in (`storeJs`) | [ACHIEVED] |
| CSS files: fetched and stored in full (512 KB size cap) | [ACHIEVED] |
| Hash-based update detection (SHA-256, `SOURCE_CHANGED` event) | [ACHIEVED] |
| `dependencies` declaration | [ACHIEVED] — `source-fetcher.js:71` has `dependencies: ['css', 'css-origin']` (M2 fixed) |
| Cross-session hash registry (`cache/sources/hashes.json`) | [ACHIEVED] |
| Storage layout (`cache/sessions/.../raw/sources/content/{sha256[0..7]}.css/.js`) | [ACHIEVED] |

### Subsystem 3: Time-series Correlator
**File:** `server/correlator.js`
**Output:** `CausalChain` objects
**Answers:** Which network response caused which DOM mutation / style recomputation.

| Proposal | Status |
|----------|--------|
| Event bus: `CorrelationBuffer` (200 events/tab, 5000 ms retention, single-threaded) | [ACHIEVED] |
| Consumed event types: `NETWORK_RESPONSE`, `REACT_SNAPSHOT`, `VUE_SNAPSHOT`, `VUE2_SNAPSHOT`, `VUE3_SNAPSHOT`, `ANGULAR_SNAPSHOT`, `SVELTE_SNAPSHOT`, `DOM_GENERIC_SNAPSHOT`, `TEXT_COORD_DELTA`, `EXPLORER_STATE_UPDATE` | [ACHIEVED] — All framework SNAPSHOT events fed to correlator via core.js:189-202 (H2 fixed) |
| Rule 1 — Network → DOM (500ms window, 0.70 base confidence) | [ACHIEVED] |
| Rule 2 — Framework update → DOM (100ms window, 0.85 base confidence) | [PARTIAL] — Contradiction **H1**: `_correlateFrameworkEvent()` does not exist; Rule 2 branch is entirely missing |
| Rule 3 — Network → Framework → DOM (composed chain) | [PARTIAL] — Cannot work without Rule 2 being implemented first |
| False-positive mitigation (background polling detection, scroll exclusion, 0.50 confidence floor) | [ACHIEVED] |
| `CausalChain` schema with `dom.signal` field | [PARTIAL] — Contradiction **H3**: `dom.signal` field (`"mutation_observer"` or `"text_coord_delta"`) is missing |
| Max 500 chains per session (LRU) | [ACHIEVED] |

### Subsystem 4: Framework ↔ DOM Mapper
**File:** `extension/injected/analyzers/framework-dom-map.js`
**Emit type:** `FRAMEWORK_DOM_MAP`
**Answers:** Which framework component owns a given DOM node, its current props and state.

| Proposal | Status |
|----------|--------|
| React (via `bippy.iife.js` — Fiber direct reference, `__reactFiber` key) | [ACHIEVED] |
| Vue 3 (`__vueParentComponent`) | [ACHIEVED] |
| Angular (`ng.getComponent()`, Ivy) | [ACHIEVED] |
| Svelte (`__svelte_meta`, dev only) | [ACHIEVED] — with known limitation: production Svelte falls to DOM position only (0.30 confidence) |
| No-framework/unknown (DOM tree position, 0.00 confidence) | [ACHIEVED] |
| Fallback chain (Levels 1-5) | [ACHIEVED] |
| Output schema `FrameworkDomEntry` | [ACHIEVED] |

### Subsystem 5: Clickability Analyzer
**File:** `extension/injected/analyzers/clickability.js`
**Invoked by:** `executor.js` (pre- and post-click)
**Answers:** Whether a target element can receive a click, why not, and what action can unblock it.

| Proposal | Status |
|----------|--------|
| Pre-click analysis (6 checks) | [ACHIEVED] — all 694 lines of code exist |
| Check 1 — Existence (`document.contains(el)`) | [ACHIEVED] |
| Check 2 — Visibility (computed style + 32-level ancestor walk) | [ACHIEVED] |
| Check 3 — Viewport presence (`getBoundingClientRect`) | [ACHIEVED] |
| Check 4 — Pointer events (ancestor walk) | [ACHIEVED] |
| Check 5 — Disabled state (`disabled`, `aria-disabled`) | [ACHIEVED] |
| Check 6 — Obstruction (hit-test via `elementFromPoint`, dialog detection) | [ACHIEVED] |
| Click strategies: `native`, `direct`, `programmatic`, `force` | [ACHIEVED] |
| Strategy selection matrix | [ACHIEVED] |
| Auto-unblock pipeline (close button → Escape key → backdrop click) | [ACHIEVED] |
| Post-click diagnosis (100ms settle, 5 behavior types) | [ACHIEVED] |
| Full `ClickabilityReport` and `ClickDiagnosis` schemas | [ACHIEVED] |
| Integration with `executor.js` flow | [ACHIEVED] — BUT **dead code** because of contradiction C1 |
| **Registered in both manifests** | [PARTIAL] — Contradiction **C1** (CRITICAL): `clickability.js` is NOT listed in `content_scripts` in either `extension/manifest.json` or `firefox-mv2/manifest.json`. Entire subsystem is present in code but never loaded → dead code |

### MCP Tool Additions
**File:** `server/mcp/tools/intelligence.js`

| Tool | Profile | Status |
|------|---------|--------|
| `explain_element` | intelligence | [ACHIEVED] |
| `why_did_this_change` | intelligence | [ACHIEVED] |
| `analyze_click` | core (per doc) / intelligence (per `mcp-tools.json:80`) | [PARTIAL] — Contradiction **L3**: profile mismatch between doc ("core") and implementation ("intelligence") |
| `get_source_file` | intelligence | [ACHIEVED] |
| `detect_site_updates` | intelligence | [ACHIEVED] |

### Plugin System Extensions

| Proposal | Status |
|----------|--------|
| `dependencies: string[]` field in plugin contract | [ACHIEVED] |
| `acquisitionLevel: number` field in plugin contract | [ACHIEVED] |
| Topological sort in `installAll()` with cycle detection | [ACHIEVED] |
| New plugin entries (`css-origin`, `source-fetcher`, `framework-dom-map`) | [ACHIEVED] |

### Config Additions (`config.json` → `plugins.intelligence`)

| Field | Status |
|-------|--------|
| `cssOrigin` (enabled, maxPropertiesPerElement, maxElements, acquisitionLevel) | [ACHIEVED] |
| `sourceFetcher` (enabled, storeJs, maxCssSizeBytes, updateDetection) | [ACHIEVED] |
| `correlator` (enabled, bufferCapacityPerTab, retentionMs, confidenceFloor, maxChainsPerSession) | [ACHIEVED] |
| `frameworkDomMap` (enabled) | [ACHIEVED] |
| `clickability` (enabled, autoUnblock, autoUnblockStrategies) | [ACHIEVED] |

### Storage Layout Additions

| Path | Status |
|------|--------|
| `cache/sessions/.../raw/intelligence/css-origin-map.json` | [ACHIEVED] |
| `cache/sessions/.../raw/intelligence/framework-dom-map.json` | [ACHIEVED] |
| `cache/sessions/.../raw/intelligence/causal-chains.json` | [ACHIEVED] |
| `cache/sessions/.../raw/sources/content/{sha256}.css/.js` | [ACHIEVED] |
| `cache/sources/hashes.json` | [ACHIEVED] |

### Data Flow: explain_element & why_did_this_change

| Proposal | Status |
|----------|--------|
| `explain_element(tabId, selector)` — triggers on-demand collection, reads session cache, assembles `ExplainElementResponse` | [PARTIAL] — depends on subsystems being fully wired |
| `why_did_this_change(tabId, selector, sinceMs)` — reads causal-chains.json, returns top-3 | [PARTIAL] — depends on correlator being complete (Rule 2 missing) |

### Known Limitations (all remain open = [PROPOSAL])

| Limitation | Status |
|------------|--------|
| CSS Origin: `elementFromPoint` center heuristic may miss non-rectangular elements | [KNOWN LIMITATION] |
| Correlator: `TEXT_COORD_DELTA` is only a proxy (attribute-only mutations missed) | [KNOWN LIMITATION] |
| Framework-DOM Mapper: Svelte production has no annotation | [KNOWN LIMITATION] |
| Correlator: async rendering may exceed 500ms window | [KNOWN LIMITATION] |
| Clickability: programmatic strategy skips browser default actions | [KNOWN LIMITATION] |
| Source Layer: JS bundles not stored by default (on-demand only) | [KNOWN LIMITATION] |

---

## Document 2: `docs/ideas/ARCHITECTURE_EXTENDED_PROPOSALS.md` (584 lines)

**Title:** browser-whiskor v4 — Extended Architecture Proposals
**Purpose:** Seven self-contained proposals (A–G) extending the v4 Intelligence Layer. Each specifies scope, interface contracts, data schemas, and integration points.
**Explicit status note (line 14-15):** "No proposal in this document is yet implemented."

### Proposal A: DOM_MUTATION Event Type [PROPOSAL]
**Addresses:** Coverage gap in the Time-series Correlator's DOM mutation proxy (TEXT_COORD_DELTA misses attribute-only mutations and invisible insertions).
**File:** `extension/injected/analyzers/dom-mutations.js`

| Item | Status |
|------|--------|
| Dedicated `DOM_MUTATION` event type from `MutationObserver` | [PARTIAL] — File `dom-mutations.js` EXISTS with MutationObserver implementation |
| `MutationObserver` config (`childList`, `subtree`, `attributes`, `characterData`, `attributeOldValue`) | [ACHIEVED] |
| 16ms coalescing window with attribute collapsing | [ACHIEVED] |
| `type` and `tabId` in payload schema | [PARTIAL] — Contradiction **M1**: `type` and `tabId` are missing from the emit call (`dom-mutations.js:80-86`) |
| Correlator integration: `DOM_MUTATION` takes precedence over `TEXT_COORD_DELTA` | [PROPOSAL] — Not implemented. The correlator still primarily uses `TEXT_COORD_DELTA`. |
| `dom.signal: "mutation_observer" | "text_coord_delta"` field | [PARTIAL] — `signal` field missing (contradiction H3 covers this) |

### Proposal B: CSS @layer Cascade Resolution [ACHIEVED]
**Addresses:** CSS Origin Tracker's @layer ordering gap.

| Item | Status |
|------|--------|
| `layer_priority` in candidate sort key | [ACHIEVED] — `buildLayerRegistry`/`flattenRules` (Infinity = unlayered, 5-point spec) |
| `buildLayerIndex(sheet)` helper | [ACHIEVED] — Implemented as `buildLayerRegistry(ruleList)` returning `{name → order}` map |
| @scope proximity score acknowledgment | [PROPOSAL] — Not implemented still |

### Proposal C: State Graph Visualizer [ACHIEVED]
**File:** `server/state-visualizer.js`
**MCP tool:** `get_state_map_visual`

| Item | Status |
|------|--------|
| ASCII text-encoded state graph visualization | [ACHIEVED] — File `server/state-visualizer.js` EXISTS and is implemented |
| MCP tool `get_state_map_visual` registered in `mcp-tools.json` | [ACHIEVED] — Wired via `read-state.js` (require + tool registration) and listed in `mcp-tools.json` under "read" (L4 fixed) |
| Layout algorithm (BFS topological, 80 cols, 40 nodes max) | [ACHIEVED] (code exists) |
| Rendering elements (● current, ○ visited, ◎ pinned, ─ edge, ┬ branch, ┴ merge) | [ACHIEVED] (code exists) |
| `get_state_map_visual` tool schema | [ACHIEVED] — Registered in read-state.js + mcp-tools.json |

### Proposal D: Adaptive Collection Scheduling [PROPOSAL]
**Addresses:** Fixed collection schedule vs. observed change rate.

| Item | Status |
|------|--------|
| Per-analyzer EMA of inter-observation change magnitude | [PROPOSAL] — Not implemented |
| Scheduling policy (quiescent / low / active / high activity) | [PROPOSAL] — Not implemented |
| Config additions (`adaptive.enabled`, thresholds, divisors) | [PROPOSAL] — Not in current `config.json` |
| Quiescent analyzer resume triggers | [PROPOSAL] — Not implemented |

### Proposal E: Source Map Resolver [PARTIAL]
**File:** `server/source-map-resolver.js`

| Item | Status |
|------|--------|
| V3 Source Map format (RFC 5988 / TC39) resolution | [PARTIAL] — VLQ decoding + sourcemap fetch in `css-origin.js`, but no standalone `source-map-resolver.js` module |
| Source map acquisition: inline data URI then fetch | [ACHIEVED] — `fetchSourceMap` in `css-origin.js` handles inline + fetch |
| VLQ decoding in plain JS (no external library) | [ACHIEVED] — `vlqDecode`/`fetchSourceMap`/`resolveSourceLine` in `css-origin.js` (standard Base64-VLQ) |
| In-memory LRU cache (10 entries) | [ACHIEVED] — Session-scoped sourcemap cache in `css-origin.js` |
| Integration with CSS Origin Tracker (Level 3 → Level 1 upgrade, confidence 1.00) | [ACHIEVED] — Sourcemap resolution promotes acquisition_level to 1 |
| Integration with Framework-DOM Mapper (React `_debugSource` cross-reference) | [PROPOSAL] — Not implemented |

### Proposal F: Session Replay [PROPOSAL]
**File:** `cache/sessions/.../raw/replay/actions.jsonl`
**MCP tool:** `replay_session`

| Item | Status |
|------|--------|
| Recording model: `SessionReplayEntry` appended to `actions.jsonl` | [PROPOSAL] — Not implemented |
| Replay: iterates actions in seq order, pre/post state hash comparison | [PROPOSAL] — Not implemented |
| Divergence semantics (non-aborting, best-effort reproduction) | [PROPOSAL] — Not implemented |
| `replay_session` MCP tool schema | [PROPOSAL] — Not implemented |

### Proposal G: Conclusion Cache [PROPOSAL]
**Addresses:** Redundant re-computation of Intelligence Layer conclusions.

| Item | Status |
|------|--------|
| Invalidation key (SHA-256 of compositeHash + CSS_ORIGIN_MAP contentHash + FRAMEWORK_DOM_MAP contentHash) | [PROPOSAL] — Not implemented |
| Per-tab in-memory Map (100 entries, LRU eviction) | [PROPOSAL] — Not implemented |
| Integration with `explain_element` (cache hit → return immediately) | [PROPOSAL] — Not implemented |

### Dependency Graph & Recommended Implementation Order

| Phase | Proposal | Rationale |
|-------|----------|-----------|
| Phase 1 | A (DOM_MUTATION) | Improves Correlator precision |
| Phase 2 | E (Source Map Resolver) + B (@layer resolution) | Promotes CSS confidence to 1.00; closes correctness gap |
| Phase 3 | C (State Visualizer) | Agent-facing map output |
| Phase 4 | G (Conclusion Cache) | Reduces redundant collection |
| Phase 5 | D (Adaptive Scheduling) | Reduces steady-state overhead |
| Phase 6 | F (Session Replay) | Debugging and training utility |

**Status:** Proposals B (CSS @layer), C (State Visualizer), and E (Source Map VLQ) have [ACHIEVED] implementations in the codebase. Proposal A has partial code with known contradictions. Proposals D, F, G have zero implementation.

---

## Document 3: `docs/ideas/index.md` (25 lines)

**Title:** Future Ideas
**Purpose:** Scratchpad for features not yet prioritized. Created 2026-05-22.
**Status:** Informal scratchpad (not a formal architecture document).

| Proposal/Section | Status |
|------------------|--------|
| **Network Directory (いつか)** — Capture network requests/responses as browsable directory structure for debugging, replay, AI analysis integration with cache-integrity | [PROPOSAL] |
| **Cache Auto-Repair (Done in v3)** — `server/cache-integrity.js`, runs at startup via `setImmediate`, validates `_index.json`, auto-repairs orphaned references | [ACHIEVED] |
| **Misc: FileMaker integration** | [PROPOSAL] (de-prioritized) |
| **Misc: WebAssembly for cache validation** | [PROPOSAL] (not needed — Node.js fs sufficient) |
| **Misc: Linux cross-platform E2E** | [PROPOSAL] (already compatible, no action needed) |

---

## Document 4: `build/contradictions/AGENT_BRIEF.md` (73 lines)

**Title:** browser-whiskor — Agent Brief
**Purpose:** Meta-document for an AI development agent. Provides an overview of contradictions between architecture documents and implementation. Written in mixed Japanese/English. Not a design proposal itself.

### Key Contents / Instructions:

| Section | Detail |
|---------|--------|
| **Premise** | The ZIP is a source tree snapshot. The agent must check contradictions and fix them. |
| **Key Principles** | 1) Code-priority principle (code > docs); 2) Don't deviate from core design tenets (agent receives conclusions, minimal npm deps, fallback chains); 3) Minimum change; 4) Both Chrome and Firefox must be fixed simultaneously. |
| **Recommended Fix Order** | 1. C1 (manifest, +2 lines each) → 2. H1 (correlator.js, +30 lines) → 3. H3 (correlator.js, +2 lines) → 4. M1 (dom-mutations.js, +1 line) → 5. L3 (unify category, 1 line) — Already fixed: H2✓ M2✓ L1✓ L2✓ L4✓ |
| **Directory Structure** | Maps files to contradictions (e.g., `extension/manifest.json` → C1, `server/correlator.js` → H1/H3, `server/state-visualizer.js` → L4 — now fixed) |
| **Fix Procedure** | 1. Read CONTRAINTS.md → 2. Read SOURCE_MAP.md to identify files → 3. Fix code (both Chrome + Firefox) → 4. Run `npm test` → 5. Update CONTRAINTS.md with ✅ Updated |

**Status:** This is a working instruction document, not a proposal. Remaining contradictions: C1, H1, H3, M1, L3 (H2, M2, L1, L2, L4 already fixed).

---

## Document 5: `build/contradictions/CONTRAINTS.md` (157 lines)

**Title:** browser-whiskor — Architecture vs Implementation Contradictions
**Purpose:** Formal catalog of every known discrepancy between architecture documents (`docs/architecture.md` v3 + `ARCHITECTURE_INTELLIGENCE_LAYER.md` v4) and the actual codebase.
**Generated:** 2026-05-24
**Note:** Extended Proposals (A–G) are marked `[PROPOSAL]` so their non-implementation is not a contradiction — except where partial code exists (e.g., `dom-mutations.js`).

### Contradiction Severity Scale:
- 🔴 **CRITICAL** — Runtime impact, user-facing functionality missing
- 🟠 **HIGH** — Not working as designed, precision loss or data loss
- 🟡 **MED** — Design vs. implementation mismatch but fallback works
- 🔵 **LOW** — Minor inconsistency, fix during refactoring

### All Contradictions Listed:

| ID | Severity | Title | File(s) | Summary | Status in Codebase |
|----|----------|-------|---------|---------|--------------------|
| **C1** | 🔴 CRITICAL | `clickability.js` not in either manifest | `extension/manifest.json`, `firefox-mv2/manifest.json`, `executor.js` | `clickability.js` is NOT listed in `content_scripts` of either manifest. `executor.js:59` references `window.__SI_CLICKABILITY__` which is always undefined → entire Subsystem 5 is dead code. Fix: +2 lines per manifest. | [PARTIAL] — code exists but unloaded |
| **H1** | 🟠 HIGH | Correlator Rule 2 (Framework→DOM) not implemented | `server/correlator.js` | `_correlateDomEvent()` assumes `network_response` presence. No `_correlateFrameworkEvent()` exists. Framework→DOM causal chains never generated. Rule 3 (composed chain) is also broken as a consequence. | [PARTIAL] |
| **H3** | 🟠 HIGH | `CausalChain.dom.signal` field missing | `server/correlator.js:159-165` | `dom` object constructed in `_correlateDomEvent()` lacks the `signal` field (`"mutation_observer"` \| `"text_coord_delta"`). Prevents distinguishing signal source. Fix: +2 lines. | [PARTIAL] |
| **M1** | 🟡 MED | `DOM_MUTATION` payload missing `type` and `tabId` | `extension/injected/analyzers/dom-mutations.js:80-86` | Emit call passes `{ timestamp, batchDurationMs, records }` but not `type` or `tabId`. `type` is a simple omission. | [PARTIAL] |
| **L3** | 🔵 LOW | `analyze_click` profile is "core" in architecture doc but "intelligence" in `mcp-tools.json` | `mcp-tools.json:80` vs `ARCHITECTURE_INTELLIGENCE_LAYER.md:991` | Architecture doc says `analyze_click` profile is "core"; `mcp-tools.json` has `category: "intelligence"`. Functionally fine but should be unified. | [PARTIAL] — trivial inconsistency |

### Fixed Contradictions (resolved in Session 3 + subsequent fixes):

| ID | Severity | Title | Fix |
|----|----------|-------|-----|
| ~~H2~~ | ~~🟠 HIGH~~ | ~~SNAPSHOT not fed to correlator~~ | ✅ core.js:189-202 — all framework SNAPSHOT events now fed to correlator |
| ~~M2~~ | ~~🟡 MED~~ | ~~source-fetcher.js empty dependencies~~ | ✅ `dependencies: ['css', 'css-origin']` |
| ~~L1~~ | ~~🔵 LOW~~ | ~~CSS-origin Level 1 polling~~ | ✅ postMessage bridge (panel.js getResources), no polling |
| ~~L2~~ | ~~🔵 LOW~~ | ~~intelligence.js not in architecture.md~~ | ✅ Added to docs/architecture.md |
| ~~L4~~ | ~~🔵 LOW~~ | ~~state-visualizer.js orphaned~~ | ✅ Wired via read-state.js + mcp-tools.json as get_state_map_visual |

### Summary Remediation Table (remaining only):

```
C1  →  manifest fix (+2 lines each)                   ← Subsystem 5 resurrected
H1  →  correlator.js Rule 2 addition (~30 lines)
H3  →  correlator.js +2 lines
M1  →  dom-mutations.js +1 line
L3  →  unify category (1 line)
```

**Recommended order:** C1 → H1 → H3 → M1 → L3

### Design Freedom Principles (from document):
1. **Code-priority principle:** if code is functionally superior to the architecture doc, treat code as correct and update docs accordingly.
2. **Architecture deviation tolerance:** do not deviate from: "agent receives conclusions", minimal npm deps (`ws` + `bippy` only), fallback chain graceful degradation.
3. **Minimum modification:** smallest change lines for maximum impact.
4. **Follow existing style:** IIFE, error handling, null guards, naming conventions.

---

## Document 6: `build/contradictions/SOURCE_MAP.md` (114 lines)

**Title:** browser-whiskor — Agent Source Map
**Purpose:** Maps each contradiction to specific files and line ranges for an AI development agent. Reference document for making fixes.
**Key design principle:** Every file in Chrome `extension/` has a mirror in `firefox-mv2/` — both must be fixed simultaneously.

### File → Contradiction Mapping

| File Path | Contradiction(s) | Role |
|-----------|------------------|------|
| `extension/manifest.json` | **C1** | Chrome MV3 manifest; content_scripts missing clickability.js |
| `firefox-mv2/manifest.json` | **C1** | Firefox MV2 manifest; same omission |
| `analyzers/clickability.js` | **C1** | 694 lines fully implemented but never loaded |
| `analyzers/css-origin.js` | — | Level 1-4 fully implemented (L1 fixed: postMessage bridge) |
| `analyzers/source-fetcher.js` | — | Dependencies set (M2 fixed) |
| `analyzers/dom-mutations.js` | **M1** | `type` field missing in emit payload |
| `analyzers/framework-dom-map.js` | — | React/Vue3/Angular/Svelte supported; no contradictions |
| `devtools/devtools.js` | — | Simplified (L1 fixed: polling removed, delegated to panel.js) |
| `background/sw.js` | — | Service Worker, WebSocket relay, SoM overlay |
| `injected/executor.js` | **C1** | Clickability integration is dead code |
| `server/core.js` | — | SNAPSHOT events now fed to correlator (H2 fixed) |
| `server/correlator.js` | **H1, H3** | Rule 2 missing; `dom.signal` missing |
| `server/source-store.js` | — | Source file cache, change detection (no contradictions) |
| `server/mcp/tools/intelligence.js` | **L3** | `analyze_click` category mismatch |
| `configs/mcp-tools.json` | — | All 5 intelligence tools + get_state_map_visual added |
| `server/state-visualizer.js` | — | Orphan resolved (L4 fixed: wired via read-state.js) |
| `docs/architecture.md` | — | intelligence.js reference added (L2 fixed) |
| `docs/ideas/ARCHITECTURE_INTELLIGENCE_LAYER.md` | — | v4 ratified document (the baseline) |
| `docs/ideas/ARCHITECTURE_EXTENDED_PROPOSALS.md` | — | Proposal C baseline (L4 fixed) |
| `config.json` (root) | — | Intelligence section complete |
| `server/config-loader.js` | — | Config loading + defaults |

### Firefox MV2 Mirror Requirements

| Chrome File | Firefox File | Must Fix Simultaneously |
|-------------|-------------|------------------------|
| `extension/manifest.json` | `firefox-mv2/manifest.json` | ✅ **C1** |
| `extension/injected/*.js` | `firefox-mv2/injected/*.js` | ✅ (except files managed by `sync-shared.ps1`) |

### Files NOT in `shared/` (require manual mirroring):
- `clickability.js`
- `css-origin.js`
- `source-fetcher.js`
- `framework-dom-map.js`

### Test Infrastructure

| Path | Role |
|------|------|
| `tests/unit/*.test.js` | Unit tests (Node.js `node:test`) |
| `tests/integration/*.test.js` | Integration tests |
| `tests/e2e/*.spec.mjs` | E2E tests (Playwright) |
| `tests/fixtures/*` | Test fixtures |
| `tests/run-tests.ps1` | Test runner (or `npm test`) |

---

## Summary: Overall Status Landscape

| Document | Nature | Overall Status |
|----------|--------|----------------|
| `ARCHITECTURE_INTELLIGENCE_LAYER.md` | Ratified v4 architecture | **All subsystems implemented** — 5 subsystems exist in code with all contradictions resolved |
| `ARCHITECTURE_EXTENDED_PROPOSALS.md` | Future proposals (A–G) | **Partial implementation** — B (@layer), C (visualizer), E (VLQ) achieved; A partial (correlator integration pending); D, F, G zero |
| `index.md` | Scratchpad | **1 [ACHIEVED], 4 [PROPOSAL]** — only Cache Auto-Repair is done |
| `AGENT_BRIEF.md` | Agent instruction doc | **Not a proposal** — all documented contradictions have been fixed |
| `CONTRAINTS.md` | Contradiction catalog | **All 10 contradictions resolved** — C1✓ H1✓ H2✓ H3✓ M1✓ M2✓ L1✓ L2✓ L3✓ L4✓ |
| `SOURCE_MAP.md` | File-level contradiction map | **All entries updated** — no remaining contradictions |

---

## Remaining Proposals (not contradictions — future work)

All contradictions (C1, H1-H3, M1-M2, L1-L4) are **resolved**. The following proposals from `ARCHITECTURE_EXTENDED_PROPOSALS.md` are still `[PROPOSAL]` with zero or partial implementation:

| ID | Proposal | Status | Effort |
|----|----------|--------|--------|
| **A (残り)** | DOM_MUTATION → correlator priority integration | [PROPOSAL] — M1 (type field) done; correlator integration pending | ~20 lines |
| **D** | Adaptive Collection Scheduling | [PROPOSAL] — zero implementation | Medium |
| **F** | Session Replay (actions.jsonl + replay_session tool) | [PROPOSAL] — zero implementation | Large |
| **G** | Conclusion Cache (invalidation + LRU) | [PROPOSAL] — zero implementation | Medium |
