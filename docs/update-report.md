# Update Report — browser-whiskor v3.6.0

> This report is outdated. For the latest changes, see [CHANGELOG.md](changelog.md).
> Current version: 3.11.0 (2026-05-24)

**Date:** 2026-05-22
**Previous version:** 3.5.0
**New version:** 3.6.0

---

## Summary

Dynamic tool profile manager for MCP, shared code infrastructure for Chrome/Firefox extensions, HOST binding security fix, and scroll-triggered text collection with IntersectionObserver.

## New Modules

| File | Lines | Purpose |
|------|-------|---------|
| `server/tool-manager.js` | ~250 | Dynamic MCP tool profile management: load/unload, auto-detection, idle timeout |
| `server/configs/tool-profiles.json` | ~120 | 7 tool profile definitions with triggers and idle timeouts |
| `shared/injected/` | 19 files | Common code shared between Chrome and Firefox extensions |
| `scripts/sync-shared.ps1` | ~100 | Script to sync shared/ files to both extensions |
| `.github/workflows/ci.yml` | ~150 | GitHub Actions CI: tests, extension sync check, size comparison |
| `tests/unit/seen-text-tracker.test.js` | ~200 | Unit tests for IntersectionObserver scroll-triggered collection |

## Modified Modules

| File | Change |
|------|--------|
| `server/index.js` | Fixed HOST binding: WebSocketServer and httpServer now bind to configured HOST (127.0.0.1) instead of 0.0.0.0 |
| `extension/injected/analyzers/text-coords.js` | Added scroll-triggered text collection via IntersectionObserver, seenTexts continuous monitoring loop |
| `server/cache-writer.js` | Merge incoming TEXT_COORDS with existing cache to retain offscreen texts |
| `tests/run-tests.ps1` | Updated to run all categories and generate summary table |

## Removed Duplicates

19 files moved from `extension/injected/` and `firefox-mv2/injected/` to `shared/injected/`:
- `collector.js`, `executor.js`, `explorer.js`, `state-reporter.js`
- `adapters/`: alpine, angular, dom-generic, preact, react, solid, svelte, vue2, vue3
- `analyzers/`: accessibility, console-logger, css, dom-mutations, perf, storage-reader

## Bugs Fixed

- **HOST binding security issue** — WebSocketServer and httpServer were binding to 0.0.0.0 regardless of config.json host setting. Now correctly binds to configured HOST (default: 127.0.0.1).
- **Scroll-triggered text collection not working** — IntersectionObserver detected elements but didn't trigger collection. Added debounced collect() call when new elements enter viewport.

## MCP Tool Count

- Previous: 45 tools
- Current: 49 tools (+4 tool profile management tools: load_profile, unload_profile, search_tools, profile_status)

## Tool Profiles

| Profile | Tools | Auto-load Trigger | Idle Timeout |
|---------|-------|-------------------|--------------|
| `core` | 12 | Always loaded | N/A |
| `debug` | +6 | Debug-related tool calls | 10 turns |
| `state-nav` | +7 | State-related tool calls | 15 turns |
| `delta` | +3 | After page interactions | 8 turns |
| `advanced-actions` | +10 | Complex action requests | 5 turns |
| `admin` | +4 | Config changes (requires allowAgentConfig) | 20 turns |
| `power` | +2 | JS execution requests (requires allowExecuteJs) | 2 turns |

## CI Pipeline

Push/PR triggers:
1. **Change detection** — Identifies which paths changed (extension/server/shared/tests)
2. **Extension sync check** — Compares Chrome vs Firefox file sizes, warns on >100B drift
3. **Shared sync verification** — Verifies shared/ files match both extensions
4. **Test execution** — Runs unit/integration/stress tests with per-category summary

## Breaking Changes

None. All changes are backward compatible.

## Security Notes

- Default HOST binding is now `127.0.0.1` (localhost only)
- `allowExecuteJs` remains `false` by default
- Tool profiles with security-sensitive tools (`admin`, `power`) require explicit config flags
