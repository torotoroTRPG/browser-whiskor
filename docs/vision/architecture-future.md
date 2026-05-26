# browser-whiskor v4 — Future Architecture (Integrated)

> 現在のv3アーキテクチャに将来の全機能を重ねた統合図。
> 実線: 現状実装済み / 破線: 将来追加予定

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                    browser-whiskor v4 (Future Architecture)                  ║
║               Agent-Grade Browser Instrumentation + Intelligence            ║
╚══════════════════════════════════════════════════════════════════════════════╝


┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 0 : LLM Agent                                                         │
│                                                                              │
│    Claude, GPT, Gemini, Cursor, Windsurf, or any MCP-compatible client.     │
│    New tools available in v4:                                                │
│      get_slice_xml, get_cheat_sheet, get_state_map_visual, replay_session,  │
│      detect_site_updates (enhanced)                                         │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │  MCP stdio (JSON-RPC 2.0)
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 1 : MCP Server  ( server/mcp/ )                                       │
│                                                                              │
│    70+ tools — existing 55 + new intelligence/capture tools:                 │
│                                                                              │
│    ┌──────────────────┬──────────────────────────────────────────────────┐  │
│    │  READ (21)       │ (unchanged)                                       │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  WRITE (16)      │ (unchanged)                                       │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  CAPTURE (5)     │ capture_screenshot (± SoM marks), refresh_data,   │  │
│    │                  │ capture_element_screenshot,                       │  │
│    │                  │ ══ get_slice_xml  [NEW] ══                       │  │
│    │                  │ ══ get_cheat_sheet [NEW] ══                      │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  INTELLIGENCE (9)│ explain_element, why_did_this_change,            │  │
│    │                  │ analyze_click, get_source_file, detect_site_     │  │
│    │                  │ updates,                                          │  │
│    │                  │ ══ replay_session      [NEW] ══                 │  │
│    │                  │ ══ get_state_map_visual [NEW] ══                │  │
│    │                  │ ══ get_causal_chain     [NEW] ══                │  │
│    ├──────────────────┼──────────────────────────────────────────────────┤  │
│    │  CONTROL (10)    │ (unchanged)                                       │  │
│    └──────────────────┴──────────────────────────────────────────────────┘  │
│                                                                              │
│    Presets extended:  full_intelligence (adds intelligence tools),           │
│                       capture_advanced (adds slice/cheat-sheet)             │
│    Conclusion Cache:  avoids redundant collection on explain_element       │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │  callbacks → index.js
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 2 : Server Core  ( server/index.js )                                  │
│                                                                              │
│    HTTP API server (port 7892) — serves cached data to DevTools panel.      │
│    WebSocket server (port 7891) — bridges extension ↔ server.               │
│    Cache writer — persists collected data to disk as JSON.                  │
│    Config manager — validates, logs, and auto-reverts changes.              │
│                                                                              │
│    ══ New subsystems: ════════════════════════════════════════════════════  │
│    ══ correlator.js              — Time-series Correlator (ring buffer)   │
│    ══ source-map-resolver.js     — Source Map → original file/line        │
│    ══ state-visualizer.js        — Text-based state graph renderer        │
│    ══ adaptive-scheduler.js      — EMA-based analyzer collection freq     │
│    ══ session-replay.js          — Action sequence replay engine           │
│    ══ conclusion-cache.js        — Invalidation-key based conclusion cache │
│    ═══════════════════════════════════════════════════════════════════════  │
│                                                                              │
│    Message handlers extended:                                                │
│      DOM_MUTATION         → correlator.push(event)       [NEW]              │
│      SLICE_REQUEST/REPLY  → serve sliced XML data        [NEW]              │
└──────┬───────────────────────────────────────┬───────────────────────────────┘
       │ HTTP :7892                            │ WebSocket :7891
       ▼                                       ▼
┌─────────────────────┐           ┌────────────────────────────────────────────┐
│  LAYER 3a : Cache   │           │  LAYER 3b : State Graph Store              │
│                     │           │                                            │
│  cache/             │◄──────────┤  server/state-store.js (L1-L3)             │
│  {tabId}/           │  JSON     │    (unchanged)                              │
│    _index.json      │  files    │                                            │
│    raw/visual/      │           │  New storage:                               │
│    raw/network/     │           │    cache/sessions/.../raw/intelligence/    │
│    raw/ui/          │           │      causal-chains.json   [NEW]            │
│    raw/accessibility│           │      conclusion-cache/    [NEW]            │
│    raw/storage/     │           │    cache/sessions/.../raw/replay/          │
│    raw/console/     │           │      actions.jsonl        [NEW]            │
│    raw/perf/        │           │    cache/sources/                          │
│    raw/css/         │           │      hashes.json          [NEW]            │
│    raw/dom/         │           │    cache/graphs/snapshots/                 │
│    raw/react_*.json │           │      visualizer exports   [NEW]            │
│    raw/slices/      │  [NEW]    │                                            │
│    ...              │           │                                            │
└─────────────────────┘           └──────────────┬─────────────────────────────┘
                                                  │
                                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 4 : Extension (Chrome MV3)                                            │
│                                                                              │
│  extension/background/sw.js                                                  │
│    WebSocket client → server                                                 │
│    Routes commands to content scripts                                        │
│    SoM overlay (OffscreenCanvas) — ══ 拡張: 背景適応型6色SoM ══           │
│    ══ Element Slice Engine — DOM-based screenshot slicing [NEW] ══         │
│    Tab lifecycle tracking                                                    │
│                                                                              │
│  extension/injected/bridge.js (ISOLATED world) — (unchanged)                │
│                                                                              │
│  extension/injected/*.js (MAIN world, run at document_start)                 │
│    plugin-system.js  — plugin registry                                       │
│    collector.js      — data aggregation                                      │
│    state-reporter.js — REQUEST_STATE_HASH handler, watchMode                 │
│    explorer.js       — autonomous exploration, composite hash                │
│    executor.js       — action execution ══ + Clickability Analyzer ══      │
│    ══ slice-engine.js      — DOM tree → slices + XML metadata  [NEW] ══   │
│                                                                              │
│  Framework Adapters:  (unchanged — 9 adapters)                               │
│    react-hooks.js + react-state-managers.js + react.js, vue3.js, vue2.js,   │
│    angular.js, svelte.js, preact.js, alpine.js, solid.js, dom-generic.js    │
│                                                                              │
│  Analyzers: 15 existing + ══ 2 new ══                                       │
│    text-coords.js, network.js, css.js, css-origin.js,                        │
│    source-fetcher.js, ui-catalog.js, perf.js, dom-mutations.js,              │
│    shadow-dom.js, dom-snapshot.js, clickability.js,                           │
│    framework-dom-map.js, accessibility.js, console-logger.js,                 │
│    storage-reader,                                                           │
│    ══ dom-mutation-observer.js  — dedicated DOM_MUTATION event  [NEW] ══  │
│    ══ slice-analyzer.js         — slice metadata extractor     [NEW] ══    │
│                                                                              │
│  lib/bippy.iife.js — React Fiber traversal (unchanged)                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

## レイヤー間データフロー (v4)

```
Agent → get_slice_xml
  │
  ▼
MCP → server/index.js
  │
  ├─ WebSocket → extension/sw.js
  │   ├─ chrome.tabs.captureVisibleTab → raw PNG
  │   ├─ scripting.executeScript → slice-engine.js
  │   │     DOM tree traversal → element rects + metadata
  │   │     ══ 新: 背景適応型6色SoMで各スライスに色割当 ══
  │   └─ Assemble slices → send to server
  │
  ├─ server assembles XML: <screenshot><slice><rect>...<metadata>...
  │
  └─ MCP responds: { ok, slices[], xml, elements[] }

Agent → replay_session
  │
  ▼
MCP → session-replay.js
  ├─ Read actions.jsonl
  ├─ For each entry: preStateHash match → execute → postStateHash verify
  └─ Return divergence report

Server → Adaptive Scheduling
  ├─ Per-analyzer EMA of change magnitude
  ├─ quiescent → no collection / active → faster interval
  └─ Reduces redundant collection on stable pages
```

## ファイル追加・変更サマリ

| ファイル | 種別 | 説明 |
|---------|------|------|
| `server/correlator.js` | NEW | 時系列相関エンジン |
| `server/source-map-resolver.js` | NEW | Source Map解決 |
| `server/state-visualizer.js` | NEW | 状態グラフ可視化 |
| `server/session-replay.js` | NEW | セッションリプレイ |
| `server/conclusion-cache.js` | NEW | 結論キャッシュ |
| `server/adaptive-scheduler.js` | NEW | 適応的スケジューリング |
| `server/mcp/tools/capture.js` | MOD | get_slice_xml, get_cheat_sheet追加 |
| `server/mcp/tools/intelligence.js` | MOD | replay, visualizer, causal chain追加 |
| `extension/injected/analyzers/dom-mutation-observer.js` | NEW | MutationObserver専用アナライザー |
| `extension/injected/analyzers/slice-engine.js` | NEW | スライス抽出＋XML生成 |
| `extension/injected/analyzers/slice-analyzer.js` | NEW | スライスメタデータ抽出 |
| `extension/background/sw.js` | MOD | 多色SoM、スライス処理追加 |
| `server/source-store.js` | MOD | ソースハッシュ永続化対応 |
| `server/state-store.js` | MOD | 暗黙的状態ノード対応 |
| `server/intelligence.js` | MOD | 新MCPツール追加 |
| `server/configs/mcp-tools.json` | MOD | 新ツール・プロファイル定義 |
