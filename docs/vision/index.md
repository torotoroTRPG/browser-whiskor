# browser-whiskor Vision

> 将来実装予定の機能群の全体像とロードマップ。
> 各機能の詳細はそれぞれのディレクトリを参照。

```
browser-whiskor v3 (現在)          browser-whiskor v4+ (未来)
══════════════════════════════════  ══════════════════════════════════
  LLM Agent                           LLM Agent
  ───────────                         ───────────
  MCP Server (61 tools)               MCP Server (85+ tools)
  │                                    │
  ├─ Read (21)                         ├─ Read (21)
  ├─ Write (16)                        ├─ Write (17)
  │                                    │   └─ open_tab (新規タブ)
  ├─ Capture (3)   ← SoM basic        ├─ Capture (6+)  ← SoM多色+スライス
  ├─ Intelligence (5)                  ├─ Intelligence (12+)
  │   └─ explain_element              │   ├─ explain_element (cached)
  │   └─ why_did_this_change          │   ├─ why_did_this_change
  │   └─ analyze_click                │   ├─ analyze_click
  │   └─ get_source_file              │   ├─ 👁️ get_slice_xml         [NEW]
  │   └─ detect_site_updates          │   ├─ 👁️ get_cheat_sheet      [NEW]
  └─ Control (10)                     │   ├─ 👁️ replay_session      [NEW]
                                       │   ├─ 👁️ get_state_map_visual[NEW]
  Server Core                          │   ├─ 👁️ focus_pointer       [NEW]
  ───────────                          │   └─ 👁️ search_focus_context[NEW]
  ├─ HTTP :7892                        ├─ Tab Management (6+)
  ├─ WebSocket :7891                   │   ├─ 📋 list_tabs           [NEW]
  ├─ Cache (JSON)                      │   ├─ 🔀 switch_tab         [NEW]
  ├─ State Graph (L1-L3)              │   ├─ ❌ close_tab           [NEW]
  └─ Config Manager                   │   ├─ 📦 archive_tab         [NEW]
                                       │   ├─ 🔄 restore_archive    [NEW]
  Extension (Chrome MV3)              │   └─ 🔍 search_archives    [NEW]
  ───────────────────                 └─ Control (10) (既存)
  ├─ Background SW
  │   ├─ WS Client                    Server Core
  │   ├─ Command Router               ───────────
  │   └─ SoM (OffscreenCanvas)        ├─ HTTP :7892
  ├─ Injected (MAIN world)            ├─ WebSocket :7891
  │   ├─ 9 Framework Adapters         ├─ Cache (JSON)
  │   ├─ 15 Analyzers                 ├─ State Graph (L1-L3)
  │   └─ Explorer                     ├─ 🧠 Correlator              [NEW]
  └─ Firefox MV2 Mirror               ├─ 🧠 Source Map Resolver     [NEW]
                                       ├─ 🧠 Adaptive Scheduler      [NEW]
                                       ├─ 🧠 Conclusion Cache        [NEW]
                                       ├─ 🧠 Zoom Engine             [NEW]
                                       ├─ 🧠 Overlap Analyzer        [NEW]
                                       ├─ 🧠 Source Line Collector   [NEW]
                                       ├─ 🧠 Transient Context       [NEW]
                                       ├─ 📋 Tab Manager             [NEW]
                                       ├─ 📦 Archive Store           [NEW]
                                       └─ Config Manager

                                       Extension (Chrome MV3)
                                       ───────────────────
                                       ├─ Background SW
                                       │   ├─ WS Client
                                       │   ├─ Command Router
                                       │   ├─ SoM (OffscreenCanvas)
                                       │   ├─ 🎨 多色SoM適応彩色    [NEW]
                                       │   └─ 🎯 動的crop (focus)  [NEW]
                                       ├─ Injected (MAIN world)
                                       │   ├─ 9 Framework Adapters
                                       │   ├─ 15 Analyzers
                                       │   ├─ 16th: 🆕 DOM_Mutation [NEW]
                                       │   ├─ 17th: 🆕 Slice Engine [NEW]
                                       │   └─ Explorer
                                       └─ Firefox MV2 Mirror
```

## 機能一覧

| # | 機能 | ディレクトリ | 優先度 | 現状 |
|---|------|-------------|--------|------|
| 1 | **Slice XML Pipeline** — スクリーンショットをDOM構造に基づいてスライスし、XMLメタデータを付与 | [`slice-xml-pipeline/`](slice-xml-pipeline/) | 高 | 🔮 未実装 (v4+) |
| 2 | **Transparent Overlay** — Dashboard上で要素の矩形を透明パネルとして可視化 | [`transparent-overlay/`](transparent-overlay/) | 高 | 🔮 未実装 (v4+) |
| 3 | **Dynamic Focus** — AIの注視指示でポインタ中心に拡大＋重なるコード行を切り出し | [`dynamic-focus/`](dynamic-focus/) | 高 | 🔮 未実装 (v4+) |
| 4 | **Tab Lifecycle & Archive** — タブ管理(一覧/切替/追加/閉鎖) + アーカイブ(状態保存→復元) | [`tab-archive/`](tab-archive/) | 高 | 🟡 **タブ管理は実装済み** (list_tabs/switch_tab/open_tab/close_tab)。アーカイブ系(状態保存→復元)は 🔮 未実装 (v4+) |
| 5 | **Context Brain / Intelligence Layer** — Correlator, Source Map, Conclusion Cache等 | [`context-brain/`](context-brain/) | — | ✅ **実装済み (v0.3.x)** |
| 6 | **SoM Variants** — 背景適応型6色SoM、モデル別統計、Agent向けチートシート | [`som-variants/`](som-variants/) | 中 | 🔮 未実装 (v4+) |
| 7 | **Extended Proposals** — Proposals A–G (B, C, E, F, G実装済み; A部分実装; D未実装) | [`extended-proposals/`](extended-proposals/) | — | ✅ **大半実装済み (v0.3.x)** |

## 推奨実装順序

```
凡例: ✅ = 実装済み (v0.3.x)  |  🔮 = 未実装 (v4+)

Phase 1 (高優先度 — 新規機能)
  ├── 🔮 Slice XML Pipeline       — MCPツール追加、SW実装完了
  ├── 🔮 Transparent Overlay      — Dashboard UX改善
  ├── 🔮 Dynamic Focus Core       — ポインタ注視＋拡大画像生成
  ├── ✅ Tab Management           — list_tabs / switch_tab / open_tab / close_tab (実装済み)
  └── 🔮 Tab Archive              — archive_tab / restore_archive / search

Phase 2 (中優先度)
  ├── 🔮 Dynamic Focus Code       — Overlap Analyzer + Source Line Collector
  ├── 🔮 多色SoM適応彩色          — 背景に応じたマーカー色自動選択
  └── 🔮 Agent Cheat Sheet        — 座標＋要素情報の同時提供

Phase 3 (低優先度)
  ├── 🟡 Adaptive Scheduling      — 定常オーバーヘッド削減 (Proposal D)。SW側 CollectionScheduler 実装済み・デフォルト無効 (adaptiveCollection.enabled)
  ├── 🔮 Transient Context Search — コード断片の横断検索
  └── 🔮 選択的キャプチャ最適化    — ぼかし・2値記録

✅ v0.3.x 実装済み (Intelligence Layer):
  ├── ✅ DOM_MUTATION Event       — server/core.js + correlator.js (Proposal A 完全実装)
  ├── ✅ CSS @layer解決           — css-origin.js (buildLayerRegistry) (Proposal B)
  ├── ✅ Source Map Resolver      — server/source-map-resolver.js + css-origin.js VLQ (Proposal E)
  ├── ✅ Correlator               — server/correlator.js (Rule 1-3, Framework→DOM)
  ├── ✅ Conclusion Cache         — server/conclusion-cache.js (Proposal G)
  ├── ✅ State Visualizer         — server/state-visualizer.js (Proposal C)
  ├── ✅ Session Replay           — server/session-replay.js (Proposal F)
  ├── ✅ Cache Disk Management    — server/cache-integrity.js (LRU eviction, v0.3.3)
  └── ✅ Semantic Search          — MiniLM ONNX model (v0.3.2)
```

## 全体のファイル構成

```
docs/vision/
├── index.md                          ← このファイル（全体像＋ロードマップ）
├── architecture-future.md            ← 統合アーキテクチャ図（現在＋未来）
├── slice-xml-pipeline/               ← スライス＋XMLメタデータ
├── transparent-overlay/              ← 透明パネルオーバーレイ
├── dynamic-focus/                    ← 動的注視＋コード収集
├── tab-archive/                      ← タブ管理＋アーカイブ
├── context-brain/                    ← Intelligence Layer拡張
├── som-variants/                     ← SoM多モード＋チートシート
└── extended-proposals/               ← 拡張Proposal A–G
```
