# browser-whiskor — Test Specification

This document defines all tests needed for browser-whiskor v3.4.
Tests should be written by the developer who knows the full codebase context.

---

## Test Architecture

```
tests/
├── integration/    # Server ↔ Extension ↔ Dashboard full-flow tests
├── stress/         # Performance, memory, large-data tests
├── e2e/            # Dashboard UI verification (⚠️ Not full pipeline E2E)
├── unit/           # Individual module tests (server-side only)
└── fixtures/       # Test data, mock pages, sample responses
```

> **Note on E2E:** The `e2e/` directory currently contains UI verification tests for the dashboard (canvas rendering, state management). These tests verify that the dashboard works correctly in a real browser but do not simulate the full extension-to-server-to-dashboard pipeline. True E2E tests would require a live extension environment and are deferred for now to maintain test speed and stability.

---

## 1. Server Core (server/index.js)

### 1.1 WebSocket Connection Management
**File:** `tests/unit/server-ws.test.js`

| Test | Input | Expected Output | Constraints |
|------|-------|-----------------|-------------|
| SW connects | Extension SW connects to ws://localhost:7891 | `swSockets.size === 1`, `SET_CONFIG` sent | Must handle rapid reconnect |
| Dashboard connects | Browser navigates to /dashboard | `dashboardSockets.size === 1`, `INIT` with sessions | Must not interfere with SW |
| Multiple SWs | Two extensions connect | Both in `swSockets`, both receive broadcasts | No cross-tab data leak |
| SW disconnects | SW closes WebSocket | `swSockets.size === 0`, no crash | Cleanup must be complete |
| Dashboard disconnects | Dashboard tab closes | `dashboardSockets.size === 0`, no crash | Must not affect SW connection |
| Mixed disconnect | SW disconnects, dashboard stays | Dashboard still receives nothing (no SW data) | No stale data delivery |

### 1.2 HTTP API
**File:** `tests/unit/server-http.test.js`

| Test | Endpoint | Input | Expected | Constraints |
|------|----------|-------|----------|-------------|
| Health | `GET /health` | — | `{ ok: true, wsConnections, sessions }` | 200 status |
| Config get | `GET /api/config` | — | Full config object | Must match server state |
| Config set | `POST /api/config` | `{ mode: 'manual' }` | `{ ok: true }`, config updated | Must broadcast to SW |
| Sessions list | `GET /api/sessions` | — | Array of session objects | Empty array if none |
| Session detail | `GET /api/sessions/{tabId}` | Valid tabId | Session index with files | 404 if not found |
| Session file | `GET /api/sessions/{tabId}/raw/...` | Valid path | JSON content | 404 if file missing |
| Collect trigger | `POST /api/collect` | `{ tabId: N }` | `{ ok: true }` | Must send MANUAL_COLLECT to SW |
| Screenshot | `POST /api/screenshot` | `{ tabId: N }` | `{ ok: true, dataUrl, filePath }` | Requires connected SW |
| Action execute | `POST /api/action` | `{ tabId: N, action: { type: 'click', ... } }` | Promise resolves with result | 15s timeout default |
| CORS preflight | `OPTIONS /api/*` | — | 204 with CORS headers | Must allow all origins |

### 1.3 Message Routing
**File:** `tests/unit/server-routing.test.js`

| Test | Message Type | Routing | Side Effects |
|------|-------------|---------|-------------|
| TEXT_COORDS | → cache + broadcastToDashboard | File saved, dashboard updated |
| VIEWPORT_UPDATE | → cache + broadcastToDashboard | File saved, dashboard updated |
| TEXT_COORD_DELTA | → broadcastToDashboard only | NOT cached, only forwarded |
| ACTION_RESULT | → action-executor | Pending promise resolved |
| SCREENSHOT_RESULT | → screenshot-manager | Pending promise resolved |
| EXPLORER_STATE_UPDATE | → cache + stateMachine + broadcastToDashboard | Node added, next action sent |
| REACT_TRANSITION | → stateMachine + broadcastToDashboard | Edge added |
| STATE_HASH_REPORT | → stateNavigator + broadcastToDashboard | Hash verification |
| Unknown type | → logged if verbose | No crash, no broadcast |

---

## 2. Canvas & Viewport (dashboard.html)

### 2.1 Viewport Consistency
**File:** `tests/unit/canvas-viewport.test.js`

| Test | Scenario | Expected | Constraints |
|------|----------|----------|-------------|
| Initial load | First text-coords load | `S.liveVp` set from snapshot viewport | No `S.viewport` dependency |
| Live VP update | VIEWPORT_UPDATE received | `S.liveVp` updated, canvas re-rendered | Must not reset zoom/pan |
| VP dimension update | New snapshot loaded | `S.liveVp.width/height` updated, scroll preserved | Must not overwrite scrollX/Y |
| VP overlay position | Page mode + overlay | Green dashed rect matches live scroll position | Must use `S.liveVp`, not snapshot |
| In-view calculation | Word at edge of viewport | Correct `inView` boolean | Must use `S.liveVp.scrollX/Y` |
| Auto-fit centering | `zoom === null` on render | Canvas centered on live viewport | Not top-left of page |

### 2.2 Canvas Rendering
**File:** `tests/unit/canvas-render.test.js`

| Test | Scenario | Expected | Constraints |
|------|----------|----------|-------------|
| DPR awareness | devicePixelRatio changes | Canvas pixel dimensions updated | No blurry rendering |
| Resize skip | Same CSS size, same DPR | No canvas.width/height reassignment | Performance optimization |
| Area cache | First render | Cache computed from word bounds | Must include all words |
| Area cache invalidation | VIEWPORT_UPDATE | Cache invalidated, recomputed on next render | Must not use stale bounds |
| Crop viewport | `crop === 'viewport'` | Only viewport area rendered | Correct scroll offset |
| Crop page | `crop === 'page'` | Full page area rendered | Bounds from words |
| Frustum cull | Word outside canvas | Not drawn | Must not throw |
| Max draw limit | 10000 words | Only 6000 drawn | No freeze |

### 2.3 Canvas Interaction (INTERACT mode)
**File:** `tests/unit/canvas-interact.test.js`

| Test | Scenario | Expected | Constraints |
|------|----------|----------|-------------|
| Click send | INTERACT on, click canvas | POST /api/action with `{ type: 'click', x, y }` | Correct page coordinates |
| Drag send | INTERACT on, drag >5px | POST /api/action with `{ type: 'drag', fromX, fromY, toX, toY }` | Must distinguish from pan |
| Right-click send | INTERACT on, right-click | POST /api/action with `{ type: 'right_click', x, y }` | Default context menu suppressed |
| Scroll send | INTERACT on, wheel | POST /api/action with `{ type: 'mouse_scroll', x, y, deltaX, deltaY }` | Must not zoom canvas |
| Pan (non-interact) | INTERACT off, drag | Canvas pans, no action sent | Must not send click |
| Zoom (non-interact) | INTERACT off, wheel | Canvas zooms towards cursor | Must not send action |
| Coordinate transform | Click at canvas edge | Correct page coordinates accounting for zoom/pan | Must use `S.canvas.panX/Y` and zoom |

### 2.4 Animation
**File:** `tests/unit/canvas-animation.test.js`

| Test | Scenario | Expected | Constraints |
|------|----------|----------|-------------|
| FOCUS VP animation | Click FOCUS VP | Smooth zoom+pan over ~250ms | Ease-out cubic |
| Animation cancel | User interacts during animation | Animation stops immediately | No conflict |
| Animation cancel on resize | Window resize | Animation stops, canvas resizes | No stale state |
| rAF cleanup | Component unmount | No pending animation frames | No memory leak |

### 2.5 Undo/Redo
**File:** `tests/unit/canvas-history.test.js`

| Test | Scenario | Expected | Constraints |
|------|----------|----------|-------------|
| Push history | Action sent | Added to `actionHistory`, future cleared | Max 50 entries |
| Undo | Ctrl+Z | Last action removed from history, added to future | UI updates |
| Redo | Ctrl+Shift+Z | Last future action re-sent | Must re-execute |
| Undo empty | No history | No-op | No crash |
| Redo empty | No future | No-op | No crash |
| New action after undo | Undo then new action | Future cleared | Standard undo behavior |

---

## 3. Beacon System (text-coords.js)

### 3.1 Beacon Tracking
**File:** `tests/unit/beacon.test.js`

| Test | Scenario | Expected | Constraints |
|------|----------|----------|-------------|
| Beacon start | First TEXT_COORDS collect | `_beaconRunning = true`, beaconWords populated | Subset only (every Nth, max 200) |
| Beacon stop | Plugin teardown | `_beaconRunning = false`, timers cleared | No dangling listeners |
| Viewport state change | Scroll moves words in/out | `inView` updated correctly | Must use `isInViewport()` |
| Throttled scan | Rapid scroll events | Scan runs once after 500ms debounce | Not every scroll event |
| Delta flush | Words changed view state | `TEXT_COORD_DELTA` posted with deltas | Batched, includes `inView` |
| Off-screen skip | Word far outside viewport | Not checked with elementFromPoint | Performance optimization |
| Beacon query | `__SI_BEACON_QUERY__.getViewState()` | `{ total, inView, outOfView }` | O(1) after scan |
| Beacon subset | 5000 words | Only ~200 beacons tracked | Memory safe |

### 3.2 Delta Message Flow
**File:** `tests/integration/delta-flow.test.js`

| Test | Scenario | Flow | Expected |
|------|----------|------|----------|
| Delta not cached | TEXT_COORD_DELTA sent | Bridge → SW → Server → Dashboard | NOT written to cache |
| Dashboard receives delta | TEXT_COORD_DELTA arrives | Word positions updated | Canvas re-rendered |
| Delta with viewStateOnly | Beacon scan result | Dashboard updates inView state | Word list opacity updated |
| Delta on wrong tab | Delta from different tabId | Ignored by dashboard | No crash |

---

## 4. MCP Tools (42 tools)

### 4.1 Write Tools
**File:** `tests/unit/mcp-write.test.js`

| Tool | Test | Input | Expected | Constraints |
|------|------|-------|----------|-------------|
| `click` | By selector | `{ selector: '#btn' }` | Element clicked | Full mouse event sequence |
| `click` | By text | `{ text: 'Submit' }` | Matching element clicked | Case-insensitive partial match |
| `click` | By coords | `{ x: 100, y: 200 }` | Element at coords clicked | Page coordinates |
| `click` | Double click | `{ double: true }` | dblclick event fired | Full sequence ×2 |
| `click` | Right button | `{ button: 'right' }` | Right mouse events | button=2 |
| `right_click` | By selector | `{ selector: '#el' }` | contextmenu event fired | button=2 |
| `right_click` | By coords | `{ x: 100, y: 200 }` | contextmenu at coords | |
| `type_text` | Basic type | `{ text: 'hello', selector: '#input' }` | Text typed char-by-char | React synthetic events |
| `type_text` | Clear + type | `{ text: 'new', clear: true }` | Old value cleared, new typed | |
| `type_text` | Press enter | `{ text: 'go', pressEnter: true }` | Enter keydown/keyup + submit | |
| `type_text` | No selector | `{ text: 'hello' }` | Types into activeElement | |
| `press_key` | Simple key | `{ key: 'Enter' }` | keydown/keypress/keyup fired | |
| `press_key` | Combo | `{ key: 'Control+a' }` | ctrlKey=true in events | |
| `drag` | By coords | `{ fromX, fromY, toX, toY }` | mousedown→mousemove→mouseup | dragenter/dragover/drop |
| `drag` | By selector | `{ fromSelector: '#item', toX, toY }` | Drag from element center | |
| `mouse_scroll` | By coords | `{ x, y, deltaX, deltaY }` | WheelEvent at position | |
| `mouse_scroll` | By lines | `{ selector, lines: 3 }` | WheelEvent with deltaY=300 | 1 line ≈ 100px |
| `hover` | By selector | `{ selector: '#menu' }` | mouseover/enter/move fired | |
| `scroll_page` | By delta | `{ deltaY: 500 }` | Window scrolled | |
| `scroll_page` | To element | `{ toElement: '#footer' }` | Element scrolled into view | |
| `select_option` | By value | `{ selector, value: 'opt1' }` | Option selected, change fired | |
| `select_option` | By label | `{ selector, label: 'Option 1' }` | Matching option selected | Partial match |
| `check_box` | Check | `{ selector, checked: true }` | Checkbox checked, change fired | |
| `check_box` | Uncheck | `{ selector, checked: false }` | Checkbox unchecked | |
| `execute_js` | Simple | `{ code: '1+1' }` | Returns 2 | |
| `execute_js` | Async | `{ code: 'await fetch(...)' }` | Promise resolved | Console captured |
| `wait_for_element` | Selector | `{ selector: '#loaded', timeoutMs: 5000 }` | Resolves when found | Polls every 100ms |
| `wait_for_element` | Timeout | `{ selector: '#never', timeoutMs: 100 }` | Returns { ok: false } | |

### 4.2 Read Tools
**File:** `tests/unit/mcp-read.test.js`

| Tool | Test | Expected | Constraints |
|------|------|----------|-------------|
| `get_sessions` | No sessions | Empty array | |
| `get_sessions` | Active session | Session with freshness | |
| `get_text_coords` | With search | Filtered results | Fuzzy matching |
| `get_text_coords` | With match | Similarity-sorted results | Score 0.0–1.0 |
| `get_text_coords` | No data | Warning: STALE_DATA | |
| `get_framework_state` | React app | Fiber tree with hooks | |
| `get_framework_state` | No framework | Generic DOM fallback | Warning: NO_FRAMEWORK |
| `get_network` | With requests | Request list with tokens | |
| `get_state_map` | After exploration | Graph with nodes and edges | |
| `list_states` | Multiple states | States with labels, tags | |
| `search_states` | Fuzzy search | Matching states by label/tags | |
| `get_state_detail` | Valid hash | Full metadata | |
| `pin_state` | New pin | State bookmarked | |

### 4.3 Capture Tools
**File:** `tests/unit/mcp-capture.test.js` → **archived** (`tests/archive/mcp-capture.test.js`)
This was an inline-implementation stub: it tested hardcoded mock objects rather than the real `capture_screenshot` / `refresh_data` handlers. It served as a documentation sketch of the intended API but did not detect regressions. The real `capture_screenshot` integration is covered by `tests/integration/full-flow.test.js`.

| Tool | Test | Expected | Constraints |
|------|------|----------|-------------|
| `capture_screenshot` | Basic | dataUrl + filePath | |
| `capture_screenshot` | With marks | dataUrl + elements map | SoM overlay |
| `capture_screenshot` | No browser | Error: no browser | |
| `refresh_data` | Basic | Fresh data summary | Waits for collection |
| `refresh_data` | Specific plugins | Only specified plugins run | |

### 4.4 Control Tools
**File:** `tests/unit/mcp-control.test.js`

| Tool | Test | Expected | Constraints |
|------|------|----------|-------------|
| `set_config` | Mode change | Config updated, broadcast | |
| `set_config` | Plugin toggle | Plugin enabled/disabled | |
| `set_config` | Non-recommended | Warning returned | |
| `get_config_changes` | After changes | Change log | |
| `trigger_collect` | All plugins | Collection triggered | |
| `trigger_collect` | Specific plugins | Only specified plugins | |
| `trigger_explorer` | Start | Explorer running | |
| `trigger_explorer` | Stop | Explorer stopped | |
| `navigate_to_state` | Valid path | Actions replayed, hash verified | |
| `navigate_to_state` | No path | URL fallback or error | |
| `get_navigation_path` | Dry run | Path without execution | |

---

## 5. Executor (executor.js)

### 5.1 Element Resolution
**File:** `tests/unit/executor-resolve.test.js`

| Test | Method | Input | Expected |
|------|--------|-------|----------|
| findBySelector | Valid CSS | `'#submit-btn'` | Element or null |
| findBySelector | Invalid CSS | `'[invalid'` | null (no crash) |
| findByText | Exact match | `'Submit'` | Exact text element |
| findByText | Partial match | `'sub'` | Element containing text |
| findByText | No match | `'xyz123'` | null |
| findByCoords | In viewport | `{ x: 100, y: 200 }` | elementFromPoint result |
| findByCoords | Out of viewport | `{ x: 99999, y: 99999 }` | null |

### 5.2 Action Handlers
**File:** `tests/unit/executor-actions.test.js`

| Handler | Test | Expected Events |
|---------|------|----------------|
| click | Single click | mouseover, mouseenter, mousemove, mousedown, mouseup, click |
| click | Double click | Above ×2 + dblclick |
| click | Right click | Same with button=2 |
| type | Character input | keydown, keypress, input, keyup per char |
| type | Native setter | nativeInputValueSetter called |
| type | Press enter | keydown Enter, keyup Enter, submit |
| press_key | Control+a | ctrlKey=true in all events |
| drag | Full drag | mousedown, mousemove ×2, mouseup, dragenter, dragover, drop |
| mouse_scroll | Wheel | WheelEvent with correct delta |
| right_click | Context menu | contextmenu event |
| scroll | Delta | scrollBy called |
| scroll | To element | scrollIntoView called |
| go_back | — | history.back() |
| go_forward | — | history.forward() |
| reload | Soft | location.reload(false) |
| reload | Hard | location.reload(true) |

---

## 6. Bridge & Message Flow

### 6.1 Bridge (bridge.js)
**File:** `tests/unit/bridge.test.js`

| Test | Direction | Message | Expected |
|------|-----------|---------|----------|
| MAIN → SW | postMessage | `TEXT_COORDS` | Relayed to chrome.runtime |
| MAIN → SW | postMessage | `VIEWPORT_UPDATE` | Relayed to chrome.runtime |
| MAIN → SW | postMessage | `TEXT_COORD_DELTA` | Relayed to chrome.runtime |
| MAIN → SW | postMessage | `CONFIG_UPDATE` | NOT relayed (loop prevention) |
| SW → MAIN | chrome.runtime | `CONFIG_UPDATE` | postMessage to MAIN world |
| SW → MAIN | chrome.runtime | `MANUAL_COLLECT` | postMessage to MAIN world |

### 6.2 Service Worker (sw.js)
**File:** `tests/unit/sw.test.js` → **archived** (`tests/archive/sw.test.js`)
This was an inline-implementation stub: it defined mock functions inline and tested the mock, never importing the real `extension/background/sw.js`. It documented the intended queue & EXECUTE_ACTION behavior but did not detect regressions. Real SW resilience is covered by `tests/integration/error-recovery.test.js` and `tests/stress/long-session.test.js`.

| Test | Scenario | Expected |
|------|----------|----------|
| WS reconnect | Server restarts | Reconnects after 3s |
| Message queue | WS down, messages sent | Queued, sent on reconnect |
| Queue limit | 500+ messages queued | Oldest dropped |
| EXECUTE_ACTION | Click action | executeInPage called |
| EXECUTE_ACTION | Navigate action | chrome.tabs.update called |
| EXECUTE_ACTION | set_viewport | chrome.windows.update called |
| CAPTURE_SCREENSHOT | With marks | Elements collected, overlay drawn |
| EXECUTE_ACTION timeout | Page action hangs | Rejects after 12s |
| Panel port | DevTools connects | Port stored, messages relayed |

---

## 7. State Machine & Navigation

### 7.1 State Store
**File:** `tests/unit/state-store.test.js`

| Test | Scenario | Expected |
|------|----------|----------|
| Add node | New state hash | Node stored |
| Add edge | Transition between states | Edge recorded |
| LRU eviction | Too many states | Oldest evicted |
| Gzip compression | Large graph | Compressed on disk |
| Load from disk | Server restart | Graph restored |

### 7.2 State Navigator
**File:** `tests/unit/state-navigator.test.js`

| Test | Scenario | Expected |
|------|----------|----------|
| BFS path | Linear graph | Shortest path found |
| BFS path | No path | null returned |
| BFS path | Multiple paths | Shortest by edge count |
| Navigate | Valid path | Actions executed, hash verified |
| Navigate | Hash mismatch | Error returned |
| Navigate | Timeout | Partial navigation, error |

---

## 8. Config System

### 8.1 Config Loader
**File:** `tests/unit/config-loader.test.js`

| Test | Scenario | Expected |
|------|----------|----------|
| Load config.json | Valid file | Config parsed |
| Load config.json | Invalid JSON | Defaults used |
| Env overrides | WHISKOR_SECURITY_ALLOWEXECUTEJS=false | Security flag overridden |
| MCP tools config | Valid file | Tools + categories loaded |
| MCP tools config | Missing file | Defaults used |
| Preset application | read_only | Write/control disabled |

### 8.2 Config Change Log
**File:** `tests/unit/config-change-log.test.js`

| Test | Scenario | Expected |
|------|----------|----------|
| Log change | Mode change | Entry recorded |
| Validate change | Disable security | Warning generated |
| Auto-revert | Non-recommended + autoRevert=true | Config reverted |

---

## 9. Stress Tests

### 9.1 Large Data
**File:** `tests/stress/large-data.test.js`

| Test | Scenario | Constraint |
|------|----------|------------|
| 10000 words | Canvas renders | No freeze, max 6000 drawn |
| 5000 network requests | Memory usage | < 200MB |
| 100 states in graph | BFS navigation | < 1s |
| 50 dashboard resizes | Canvas re-render | No memory leak |

### 9.2 Long Session
**File:** `tests/stress/long-session.test.js`

| Test | Scenario | Constraint |
|------|----------|------------|
| 24h connection | WS keepalive | No disconnect |
| 10000 actions | History management | Max 50 kept |
| Continuous scroll | Beacon tracking | No performance degradation |

---

## 10. Integration Tests

### 10.1 Full Flow
**File:** `tests/integration/full-flow.test.js`

| Test | Flow | Expected |
|------|------|----------|
| Collect → Read → Act | TEXT_COORDS → get_text_coords → click | Data available, action executed |
| Explore → Navigate → Verify | trigger_explorer → navigate_to_state → get_state_detail | States discovered, navigation works |
| Screenshot → SoM → Click | capture_screenshot(marks) → click element N | Elements mapped, click succeeds |
| Config change → Effect | set_config(mode=off) → collect | No data collected |

### 10.2 Error Recovery
**File:** `tests/integration/error-recovery.test.js`

| Test | Scenario | Expected |
|------|----------|----------|
| Server crash + restart | Extension reconnects | Session restored, data intact |
| Tab closed | Session cleanup | No orphaned cache files |
| Action timeout | Page unresponsive | Error returned, no hang |
| Invalid action | Unknown type | Error returned |

---

## Required Fixtures

### `fixtures/test-page.html`
A test HTML page with:
- Various interactive elements (buttons, links, inputs, selects, checkboxes)
- Nested DOM structure
- Long text content (500+ words)
- Scrollable content
- Drag-and-drop targets
- Context menu targets
- Framework-agnostic (vanilla JS)

### `fixtures/test-input.html`
A focused fixture for the executor's `type` / focus / submit paths. Contains:
- Empty and prefilled `<input>` / `<textarea>` (for `clear` testing)
- `enterkeyhint` variations (send / search / enter / next) — exercises submit-key inference
- A native `<form>` with submit button
- `contenteditable` (empty and rich) — exercises the insertText / composition path
- Adversarial cases: readonly, disabled, blur-on-input, delayed focus-steal
- An on-page event log overlay (focus/blur/input/keydown/submit) for manual observation
- Framework-agnostic (vanilla JS)

### `fixtures/mock-text-coords.json`
Sample TEXT_COORDS data with 1000+ words, including:
- Words in viewport
- Words out of viewport
- Various font sizes and colors
- XPath values

### `fixtures/mock-network.json`
Sample network data with 100+ requests, including:
- Various HTTP methods
- Various status codes
- Token detection results

### `fixtures/mock-state-graph.json`
Sample state graph with 10+ states and edges for navigation testing.

---

## Global Constraints

1. **No CDP dependency** — All tests must work without Chrome DevTools Protocol
2. **MV3 + MV2 parity** — Tests should pass on both Chrome MV3 and Firefox MV2 where applicable
3. **No npm test deps** — Only `ws` is allowed as dependency. Tests should use vanilla Node.js or minimal setup
4. **Isolation** — Each test must be independently runnable
5. **Timeout** — All tests must complete within 30s
6. **Memory** — No test should exceed 500MB RSS
7. **Cleanup** — All tests must clean up temp files, sessions, and connections
