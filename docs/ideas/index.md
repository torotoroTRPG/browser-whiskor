# Future Ideas

> Scratchpad for features not yet prioritized.
> Created: 2026-05-22

## Network Directory (いつか)

- Capture network requests/responses as a browsable directory structure
- Each request → file with headers, body, timing
- Useful for debugging, replay, and AI analysis
- Integration with cache-integrity for consistency

## Cache Auto-Repair (Done in v3)

- [x] `server/cache-integrity.js` — standalone checker
- [x] Runs at server startup via `setImmediate`
- [x] Validates `_index.json` structure
- [x] Auto-repairs: removes orphaned references, rebuilds minimal index
- [x] Reports: sessions count, healthy/repaired/corrupted

## Misc

- FileMaker integration (de-prioritized)
- WebAssembly for cache validation (not needed — Node.js fs is sufficient)
- Linux cross-platform E2E (already compatible with current config)
