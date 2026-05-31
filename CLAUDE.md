# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**browser-whiskor** (v0.3.4) はAIエージェントにブラウザの「知覚能力」を与えるChrome/Firefox拡張機能 + Node.jsサーバー。拡張側がページ内のDOM・フレームワーク状態・ネットワーク・テキスト座標などを収集し、サーバーがHTTP APIとMCP (Model Context Protocol) stdioの両方でAIエージェントに公開する。

## Commands

```bash
# サーバー起動
npm start                         # 通常起動 (HTTP:7892 + WS:7891)
node server/index.js --mock       # モックデータで起動
node server/index.js --verbose    # 全メッセージをログ出力
node server/index.js --mcp        # MCPスタンドアロンモード (stdio)

# テスト
npm test                          # 全テスト (unit + integration + stress)
npm run test:unit                 # unit のみ
npm run test:integration          # integration のみ
npm run test:stress               # stress のみ
npm run test:e2e                  # E2E (Playwright)
npm run test:coverage             # カバレッジ付き

# 開発支援
npm run download-model            # MiniLM ONNX モデルを手動DL (.model-cache/ に保存)
.\scripts\validate.ps1            # push前チェック (YAML lint + shared同期 + 構造確認)
.\scripts\sync-shared.ps1         # shared/injected/ を両拡張機能に同期 (後述)
```

## Architecture

```
AI Agent (Claude / Cursor / etc.)
    │ MCP stdio (JSON-RPC 2.0)  ─OR─  HTTP :7892
    ▼
server/index.js          ← エントリーポイント。HTTP:7892 + WS:7891 を立ち上げ
    ├── server/core.js           ← WhiskorCore: WSメッセージのルーティングと永続化
    ├── server/mcp-server.js     ← MCP層 (55ツール)
    │       ├── mcp/registry.js  ← ツール登録・フィルター・プリセット
    │       ├── mcp/transport.js ← stdio JSON-RPCトランスポート
    │       └── mcp/tools/       ← read / write / capture / control / intelligence
    ├── server/cache-writer.js   ← ディスク永続化 (cache/{tabId}/raw/...)
    ├── server/state-store.js    ← ステートグラフ (LRU + gzip + 後方互換)
    ├── server/state-fingerprint.js ← FNV32ハッシュエンジン
    ├── server/state-navigator.js   ← BFS経路探索 + アクションリプレイ
    ├── server/delta-engine.js   ← スマートデルタ集約・モーションクラスタリング
    ├── server/pattern-registry.js  ← UIパターン保存 + ref ID参照
    ├── server/tool-manager.js   ← 動的プロファイルロード/アンロード
    ├── server/correlator.js     ← TimeSeriesCorrelator (UI変化の因果相関)
    └── server/source-store.js   ← CSSソースキャッシュ + クロスセッションハッシュ

extension/ (Chrome MV3)          firefox-mv2/ (Firefox MV2)
    ├── background/sw.js              background/background.js
    └── injected/                 └── injected/  ← shared/ からコピーされる
            ├── collector.js
            ├── bridge.js
            ├── executor.js
            ├── explorer.js
            ├── state-reporter.js
            ├── plugin-system.js
            ├── adapters/ (React/Vue3/Vue2/Angular/Svelte/Preact/Alpine/Solid/DOM)
            └── analyzers/ (text-coords/ui-catalog/css-analyzer/accessibility/...)
```

### 重要: shared/injected/ の役割

`shared/injected/` が **injectedスクリプトの正規ソース**。Chrome・Firefoxの両ビルドに同じファイルをコピーして使う。

- **injectedスクリプトを変更するときは必ず `shared/injected/` を編集する**
- 変更後に `.\scripts\sync-shared.ps1` を実行して両拡張機能に反映する
- `extension/injected/` と `firefox-mv2/injected/` を直接編集しても `sync-shared.ps1` で上書きされる
- `.\scripts\validate.ps1` が同期ズレを検出する

### サーバーの2モード

1. **通常モード** (`npm start`): HTTP:7892 と WS:7891 の両方を開く。ブラウザ拡張機能がWS:7891に接続し、ダッシュボードは http://localhost:7892/ で閲覧可能
2. **MCPモード** (`--mcp`): stdioでJSON-RPC 2.0を処理。ポート:7892が既に使用中の場合は**Proxyモード**に自動切替し、既存サーバーへ全操作を透過的に転送する（ポート競合なし）

### ステートグラフのハッシュ方式

- `reactHash`: Reactコンポーネントツリー形状 + routerパス + storeキー (FNV32)
- `domHash`: URLパス名 + インタラクティブ要素のシグネチャ
- `compositeHash`: React利用可能時は `FNV32(reactHash + domHash)`、それ以外は `domHash`
- 非確定的な値 (timestamp, UUID, loadingフラグ) はハッシュ計算から除外される

### MCPツールプロファイル

常時公開は12ツールの `core` プロファイルのみ。他のプロファイルはキーワード自動検出またはAIの明示的なロードで動的に有効化・無効化される。`search_tools` / `load_profile` / `unload_profile` / `profile_status` の4つは常時公開される「メタツール」。

## Extension Setup

**Chrome/Edge:**
`chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」→ `extension/` フォルダを選択

**Firefox:**
`about:debugging` → この Firefox → 一時的なアドオンを読み込む → `firefox-mv2/manifest.json` を選択 (Firefox は `extensions.experiments.enabled = true` が必要)

## Configuration

`config.json` がメイン設定。`.env` ファイルで `WHISKOR_<SECTION>_<KEY>=<value>` 形式で上書き可能。

主要な設定項目:
- `security.allowExecuteJs`: デフォルト `false`。`execute_js` ツールを使うには `true` が必要
- `agentControl.allowAgentConfig`: デフォルト `false`。AIエージェントによる `set_config` 呼び出しを許可するか
- `agentControl.screenshotMarks`: Set-of-Marks (要素番号オーバーレイ) の有効化
- `intelligence.miniLM.downloadOnStart`: 起動時のモデル自動DL (初回のみ、~50MB)

## Coding Style

- **CommonJS** (`'use strict'`, `require`/`module.exports`)。ESMは使わない
- **拡張機能側はゼロ依存**のバニラJS
- ESLint設定 (`.eslintrc.json`): `ecmaVersion: 2022`、`no-var: warn`、`prefer-const: warn`
- コメントは英語・日本語の両方で書かれることが多い (`_comment_en` / `_comment_ja` フィールド)

## Known Issues / Notes

- `plugin-system.js` の `dependencies` フィールドは `source-fetcher` / `css-origin` / `framework-dom-map` の3件のみ設定済み。他のプラグインは `|| []` フォールバックで動作するが、厳密な依存順序は未保証
- IMPLEMENTATION-PROGRESS.md に記載された「mcp-tools.json 追記未完了」「Firefox manifest 未登録」の2件は解決済み

## Key Ports & Endpoints

| | |
|---|---|
| `WS :7891` | 拡張機能との通信ブリッジ |
| `HTTP :7892` | REST API + ダッシュボード |
| `GET /health` | 接続確認 |
| `GET /` | ダッシュボード |
| `POST /api/action` | ブラウザ操作 (click/type/navigate 等) |
| `POST /api/screenshot` | スクリーンショット取得 |
| `POST /api/collect` | データ収集トリガー |

## Manual Testing

`manual/` ディレクトリに手動テスト用ツールがある。文字化け防止のため `chcp 65001` を事前に実行すること。

```powershell
# 対話型MCPシェル (おすすめ)
python manual/mcp-shell.py

# ワンライナーMCP呼び出し
.\manual\mcp.ps1 -call get_sessions
.\manual\mcp.ps1 -call capture_screenshot -json '{"tabId":1234}'
```
