# Update Report — browser-whiskor v3.2.0

**Date:** 2026-05-20
**Previous version:** 3.1.0
**New version:** 3.2.0

---

## Summary

State graph system with semantic labels, unified composite hashing, and agent-driven state navigation. The autonomous explorer now builds a navigable graph of UI states that agents can query, search, and traverse.

## New Modules

| File | Lines | Purpose |
|------|-------|---------|
| `server/state-fingerprint.js` | ~130 | FNV32 hash engine, non-deterministic value filter, composite hash computation |
| `server/state-store.js` | ~350 | State graph management: nodes, edges, gzip persistence, LRU eviction, snapshot storage |
| `server/state-semantic.js` | ~280 | Auto-generated labels, semantic tags, keyState extraction, fuzzy state search |
| `server/state-navigator.js` | ~230 | BFS shortest path finding, action replay with hash verification, URL fallback |
| `extension/injected/state-reporter.js` | ~80 | REQUEST_STATE_HASH handler, watchMode for continuous hash reporting |

## Modified Modules

| File | Change |
|------|--------|
| `server/state-machine.js` | Converted to backward-compat wrapper delegating to state-store.js |
| `server/index.js` | Added REACT_TRANSITION handler (was swallowed), STATE_HASH_REPORT handler, extended EXPLORER_STATE_UPDATE |
| `server/mcp-server.js` | Added 6 new tools: list_states, search_states, get_state_detail, pin_state, navigate_to_state, get_navigation_path |
| `extension/manifest.json` | Added state-reporter.js to content scripts, version → 3.2.0 |
| `firefox-mv2/manifest.json` | Added state-reporter.js to content scripts, version → 3.2.0 |
| `extension/injected/explorer.js` | Replaced computeStateHash() with unified compositeHash (FNV32, reactHash + domHash) |
| `extension/injected/adapters/react.js` | Added window.__SI_REACT_HASH__ write on each onCommitFiberRoot |
| `config.json` | Added stateGraph section: hash settings, storage limits, semantic config, navigation config |

## Bugs Fixed

- **REACT_TRANSITION events were swallowed** — server/index.js had no handler for this message type. React state transitions are now recorded as state graph edges.
- **Hash inconsistency between explorer and React adapter** — explorer.js used djb2 while react.js used a different FNV variant. Both now use FNV32 with identical input structure.

## MCP Tool Count

- Previous: 29 tools
- Current: 35 tools (+6 state navigation tools)

## Storage Format

- State graphs are now stored as gzip-compressed JSON (`cache/graphs/{siteVersion}.json.gz`)
- Full snapshots stored separately (`cache/graphs/snapshots/{siteVersion}/{hash}.snap.json.gz`)
- LRU eviction moves unused nodes to `cache/graphs/{siteVersion}/evicted/`

## Breaking Changes

None. state-machine.js maintains backward-compatible API. Existing callers (index.js, mcp-server.js) continue to work without modification.
