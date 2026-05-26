# Context Brain / Intelligence Layer

> 生データを収集するだけでなく、時系列相関・因果関係の推定・ソースマップ解決・結論キャッシュの各サブシステム。
> 中核5サブシステムは v3 で実装済み。Adaptive Scheduling のみ未実装の拡張提案。

詳細な設計は `docs/ideas/ARCHITECTURE_INTELLIGENCE_LAYER.md`（実装済み設計書）を参照。

## サブシステム一覧

```
Intelligence Layer (server/)
├── correlator.js           — 時系列相関エンジン
├── source-map-resolver.js  — Source Map 解決
├── state-visualizer.js     — 状態グラフ可視化
├── session-replay.js       — セッションリプレイ
├── conclusion-cache.js     — 結論キャッシュ
└── adaptive-scheduler.js   — 適応的収集スケジューリング
```

## 1. Time-series Correlator

### 目的
「どのネットワークレスポンスが、どのDOM変異を引き起こしたか」を確率付きで推定。

### 機構
- イベントリングバッファ (200件 / tab, 5秒保持)
- 3つの相関ルール:
  1. Network → DOM (信頼度0.70–0.85)
  2. Framework update → DOM (信頼度0.85–1.00)
  3. Network → Framework → DOM (合成, 信頼度 min+0.05)
- 偽陽性対策: ポーリング検出, スクロール除外, 信頼度フロア0.50

### CausalChain スキーマ

```json
{
  "id": "sha256(events)[0..8]",
  "rule": 1 | 2 | 3,
  "confidence": 0.50...1.00,
  "network": { "url": "...", "status": 200, "deltaMs": 45 },
  "framework": { "type": "react", "components": ["App"], "deltaMs": 12 },
  "dom": { "affectedCount": 3, "sampleSelectors": ["..."] }
}
```

### ストレージ
`cache/sessions/.../raw/intelligence/causal-chains.json`
最大500チェーン/セッション (LRU)

## 2. Source Map Resolver

### 目的
コンパイル済みCSS/JSのファイル・行番号を、元のソースファイル・行番号に解決。

### 解決フロー
1. Inline data URI → 即時デコード
2. 外部 .map ファイルを fetch (4MB制限, cache: force-cache)
3. VLQデコード → ソート済みセグメント配列に索引化
4. 二分探索で (generatedLine, generatedColumn) → originalFile/Line

### 連携
- CSS Origin Tracker: Level 3 (fetch) 取得成功後、sourceMappingURL を解決
- Framework↔DOM Mapper: React `_debugSource` の解決

## 3. State Graph Visualizer

### 目的
状態グラフをテキストベースで可視化。Agentが現在位置を把握。

### 出力例
```
session: tab 4  /dashboard  (12 nodes, 18 edges)
──────────────────────────────────────────────────────
○ Home  (1bca3f2)
  │
  ├─ ○ Login  (4a9d871)
  │    └─ ○ Settings  (7f3c120)
  │
  └─ ○ Dashboard  (9c14e3b)
       ├─ ● Reports  (0d82f11)  ← current
       │    ?  Export button (unvisited)
       └─ ○ Analytics  (8b71c04)
```

### MCPツール
`get_state_map_visual(tabId, maxNodes=40, width=80, rootHash?)`

## 4. Session Replay

### 目的
過去のAgent操作を再実行。デバッグ・訓練用。

### 記録
- 各 ACTION_RESULT に `{ seq, preStateHash, postStateHash, ok, errorType }` を追記
- 保存: `cache/sessions/.../raw/replay/actions.jsonl`

### MCPツール
`replay_session(tabId, sourceTabId, fromSeq?, toSeq?, stopOnDivergence?)`

## 5. Conclusion Cache

### 目的
`explain_element` の冗長な再計算を防止。

### 無効化キー
SHA-256(compositeHash + CSS_ORIGIN_MAP.contentHash + FRAMEWORK_DOM_MAP.contentHash)

### 容量
100エントリ/tab, LRU, 非永続化

## 6. Adaptive Collection Scheduling

### 目的
アナライザーの収集頻度を変化率に応じて動的調整。

### EMAモデル
`ema = 0.3 * magnitude + 0.7 * ema_prev`

| ema値 | 分類 | 収集間隔 |
|-------|------|---------|
| 0 | quiescent | 停止 |
| >0, ≤low | low activity | 通常間隔 |
| >low | active | 通常間隔 × activeDiv |
| >high | high activity | 通常間隔 × activeDiv² |

## 実装状況

| サブシステム | 状態 | ファイル |
|-------------|------|---------|
| Correlator | 実装済み | server/correlator.js |
| Source Map Resolver | 実装済み | server/source-map-resolver.js |
| Conclusion Cache | 実装済み | server/conclusion-cache.js |
| State Visualizer | 実装済み | server/state-visualizer.js |
| Session Replay | 実装済み | server/session-replay.js |
| Adaptive Scheduling | **未実装 (Proposal D)** | — |
