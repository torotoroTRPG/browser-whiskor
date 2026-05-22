# browser-whiskor — Test Runner Setup

## Test Strategy & Scope

**Current Status:** 304 automated tests (Unit, Integration, Stress) + UI verification.

| Category | Count | Scope | Notes |
|----------|-------|-------|-------|
| **Unit** | 273 | Core logic, routing, WS messaging, MCP tools | Event-driven, zero sleep where possible |
| **Integration** | 20 | Server ↔ Client flows, error recovery, multi-tab | Uses in-process server fixture |
| **Stress** | 11 | Large payloads, long sessions | Verifies stability under load |
| **E2E (Playwright)** | 8 | Dashboard UI, Canvas rendering, State management | ⚠️ **Note:** Currently tests UI components and internal state, not the full extension-to-server pipeline. See below. |

### E2E Test Limitations
`tests/e2e/dashboard.spec.js` verifies that the dashboard UI renders correctly and responds to state changes (e.g., canvas updates on scroll). However, it **does not** simulate the full end-to-end flow (Extension → Server → Dashboard) automatically. It injects state directly into the dashboard's internal object (`window.__dash`) to verify rendering logic. This is a pragmatic choice to keep tests fast and stable, but true E2E coverage would require a live extension environment.

## Test Framework

**Node.js built-in `node:test` + `node:assert`** — zero dependencies, matches project philosophy.

```bash
node --test tests/**/*.test.js
```

## Directory Structure

```
tests/
├── TEST-SPEC.md          # Test specification (what to test)
├── test-runner.js        # Main test runner
├── helpers/              # Shared test utilities
│   ├── server-fixture.js    # Start/stop test server
│   ├── ws-client.js         # Mock WebSocket client
│   ├── mock-extension.js    # Simulated extension SW
│   └── fixtures.js          # Load test fixtures
├── unit/                 # Unit tests
│   ├── server-ws.test.js
│   ├── server-http.test.js
│   ├── server-routing.test.js
│   ├── canvas-viewport.test.js
│   ├── canvas-render.test.js
│   ├── canvas-interact.test.js
│   ├── canvas-animation.test.js
│   ├── canvas-history.test.js
│   ├── beacon.test.js
│   ├── delta-flow.test.js
│   ├── mcp-write.test.js
│   ├── mcp-read.test.js
│   ├── mcp-capture.test.js
│   ├── mcp-control.test.js
│   ├── executor-resolve.test.js
│   ├── executor-actions.test.js
│   ├── bridge.test.js
│   ├── sw.test.js
│   ├── state-store.test.js
│   ├── state-navigator.test.js
│   ├── config-loader.test.js
│   └── config-change-log.test.js
├── integration/          # Integration tests
│   ├── full-flow.test.js
│   ├── error-recovery.test.js
│   └── dashboard-canvas.test.js
├── stress/               # Stress tests
│   ├── large-data.test.js
│   └── long-session.test.js
└── fixtures/             # Test data
    ├── test-page.html
    ├── mock-text-coords.json
    ├── mock-network.json
    └── mock-state-graph.json
```

## Running Tests

```bash
# All tests
node --test tests/**/*.test.js

# Unit only
node --test tests/unit/*.test.js

# Integration only
node --test tests/integration/*.test.js

# Stress tests (may take longer)
node --test tests/stress/*.test.js

# With coverage (Node 20+)
node --test --experimental-test-coverage tests/**/*.test.js

# Specific test file
node --test tests/unit/server-ws.test.js
```

## Package.json Scripts

```json
{
  "scripts": {
    "test": "node --test tests/**/*.test.js",
    "test:unit": "node --test tests/unit/*.test.js",
    "test:integration": "node --test tests/integration/*.test.js",
    "test:stress": "node --test tests/stress/*.test.js",
    "test:coverage": "node --test --experimental-test-coverage tests/**/*.test.js"
  }
}
```

## Test Server Mode

For integration tests, server runs on test ports:
- WS: 17891
- HTTP: 17892
- Cache: `tests/tmp/cache/`

Each test gets a fresh server instance that shuts down after the test.

## Mock Data

- `mock-extension.js` simulates extension SW behavior
- `ws-client.js` provides mock WebSocket connections
- Fixtures in `tests/fixtures/` provide realistic test data
