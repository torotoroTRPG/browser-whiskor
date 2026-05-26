# browser-whiskor — Agent Source Map

> 開発エージェント向け: 各 contradiction に関連するファイルの責任範囲と修正位置

---

## Extension Side (Chrome MV3) — `extension/`

### Manifests

| ファイル | 役割 | Contradiction |
|----------|------|---------------|
| `extension/manifest.json` | Chrome MV3 エントリ。content_scripts に全 analyzer を列挙 | **C1** (clickability.js 欠落) |
| `firefox-mv2/manifest.json` | Firefox MV2 エントリ。同上 | **C1** (clickability.js 欠落) |

### Injected analyzers (MAIN world, `document_start`)

| ファイル | 役割 | Contradiction |
|----------|------|---------------|
| `analyzers/clickability.js` | Subsystem 5: クリック可否分析、自動解除、事後診断。694行、全6チェック + 自動解除パイプライン + 事後診断が完全実装済みだが未ロード | **C1** |
| `analyzers/css-origin.js` | Subsystem 1: CSS ルール由来追跡。Level 2-4 実装済み、Level 1 は devtools.js ポーリングと連携 | **L1** |
| `analyzers/source-fetcher.js` | Subsystem 2: ソースファイル取得。`dependencies` が空 (`['sources']` が正) | **M2** |
| `analyzers/dom-mutations.js` | DOM 変更検出。`type` フィールド欠落 | **M1** |
| `analyzers/framework-dom-map.js` | Subsystem 4: フレームワーク→DOM マッピング。React/Vue3/Angular/Svelte 対応 | — |

### DevTools

| ファイル | 役割 | Contradiction |
|----------|------|---------------|
| `devtools/devtools.js` | DevTools パネル。CSS Level 1 ブリッジ (inspectedWindow.eval ポーリング) | **L1** |

### Background

| ファイル | 役割 | Contradiction |
|----------|------|---------------|
| `background/sw.js` | Service Worker。WebSocket 中継、SoM オーバーレイ | — |

### Executor

| ファイル | 役割 | Contradiction |
|----------|------|---------------|
| `injected/executor.js` | アクション実行。clickability.js が読み込まれないため全 clickability 統合がデッドコード | **C1** |

---

## Server Side — `server/`

### Core

| ファイル | 役割 | Contradiction |
|----------|------|---------------|
| `core.js` | メッセージルーター。172-192 行目が SNAPSHOT 系イベントを correlator に feed していない | **H2** |

### Intelligence

| ファイル | 役割 | Contradiction |
|----------|------|---------------|
| `correlator.js` | 時系列相関エンジン。Rule 2 未実装、`dom.signal` なし | **H1**, **H3** |
| `source-store.js` | ソースファイルキャッシュ。変更検知 | — |

### MCP Tools

| ファイル | 役割 | Contradiction |
|----------|------|---------------|
| `mcp/tools/intelligence.js` | 5つの intelligence ツール。`analyze_click` のカテゴリ不一致 | **L3** |
| `configs/mcp-tools.json` | ツール可視性設定。全5ツール + intelligence カテゴリ追加済み | — |

### Orphaned

| ファイル | 役割 | Contradiction |
|----------|------|---------------|
| `state-visualizer.js` | ASCII 状態グラフ描画 (Proposal C)。どのモジュールからも参照されていない | **L4** |

---

## Firefox MV2 — `firefox-mv2/`

firefox-mv2 は `extension/` のミラー。修正が必要なファイルは両方同時に修正すること:

| Chrome | Firefox | 要同時修正 |
|--------|---------|-----------|
| `extension/manifest.json` | `firefox-mv2/manifest.json` | ✅ **C1** |
| その他 injected/*.js | `firefox-mv2/injected/*.js` | ✅ (sync-shared.ps1 で一元管理されるファイルは除く) |

**shared/ で管理されているファイル** (`scripts/sync-shared.ps1` が同期):
- `shared/injected/` から `extension/injected/` と `firefox-mv2/injected/` に自動コピー
- clickability.js, css-origin.js, source-fetcher.js, framework-dom-map.js は shared/ に含まれていないため手動コピーが必要

---

## Config / Document

| ファイル | 役割 | Contradiction |
|----------|------|---------------|
| `config.json` (ルート) | サーバー設定。intelligence セクション完備 | — |
| `server/config-loader.js` | 設定読み込み + デフォルト値 | — |
| `docs/architecture.md` | v3 アーキテクチャ文書。intelligence.js の記載なし | **L2** |
| `docs/ideas/ARCHITECTURE_INTELLIGENCE_LAYER.md` | v4 インテリジェンス層アーキテクチャ (ratified) | 基準文書 |
| `docs/ideas/ARCHITECTURE_EXTENDED_PROPOSALS.md` | 拡張提案 A–G (proposal ステータス) | L4 の基準 |
| `docs/agent-knowledge.md` | エージェント向け知識ベース。File Locations に intelligence 関連の追記が必要 | — |

---

## テスト

| ファイル | 役割 |
|----------|------|
| `tests/unit/*.test.js` | ユニットテスト (Node.js built-in `node:test`) |
| `tests/integration/*.test.js` | 結合テスト |
| `tests/e2e/*.spec.mjs` | E2E テスト (Playwright) |
| `tests/fixtures/*` | テストフィクスチャ |
| `tests/run-tests.ps1` | テストランナー |

テスト実行: `.\tests\run-tests.ps1` または `npm test`
