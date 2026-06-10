# Future Ideas

> Scratchpad for features not yet prioritized.
> Created: 2026-05-22
> Last updated: 2026-05-27 (v0.3.3)

## Network Directory (いつか)

- Capture network requests/responses as a browsable directory structure
- Each request → file with headers, body, timing
- Useful for debugging, replay, and AI analysis
- Integration with cache-integrity for consistency

**Status:** 🔮 未実装 (将来)

## Cache Auto-Repair & Disk Management

- [x] `server/cache-integrity.js` — standalone checker
- [x] Runs at server startup via `setImmediate`
- [x] Validates `_index.json` structure
- [x] Auto-repairs: removes orphaned references, rebuilds minimal index
- [x] Reports: sessions count, healthy/repaired/corrupted
- [x] **v0.3.3:** LRU-based disk size enforcement (`enforceDiskLimit`)
- [x] **v0.3.3:** Automatic cleanup when exceeding `stateGraph.maxDiskMB`

**Status:** ✅ 実装済み (v0.3.0 + v0.3.3 enhancements)

## Semantic Search

- [x] MiniLM ONNX model for multilingual semantic similarity
- [x] Fuzzy text matching with token Jaccard + character bigram
- [x] Background worker pool for async embedding
- [x] Automatic model download (~50MB) on first server start (`intelligence.miniLM.downloadOnStart`)

**Status:** ✅ 実装済み (v0.3.2)

## Misc

- FileMaker integration (de-prioritized)
- WebAssembly for cache validation (not needed — Node.js fs is sufficient)
- Linux cross-platform E2E (already compatible with current config)
