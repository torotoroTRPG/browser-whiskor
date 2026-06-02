# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**browser-whiskor** (v0.4.5) はAIエージェントにブラウザの「知覚能力」を与えるChrome/Firefox拡張機能 + Node.jsサーバー。拡張側がページ内のDOM・フレームワーク状態・ネットワーク・テキスト座標などを収集し、サーバーがHTTP APIとMCP (Model Context Protocol) stdioの両方でAIエージェントに公開する。

## Commands

```bash
# サーバー起動
npm start                         # 通常起動 (HTTP:7892 + WS:7891)
node server/index.js --mock       # モックデータで起動
node server/index.js --verbose    # 全メッセージをログ出力
node server/index.js --mcp        # MCPスタンドアロンモード (stdio)
npm run stop                      # 7891/7892 を握る whiskor サーバーを停止
npm run restart                   # 停止→(可能なら)拡張再ビルド→再起動。コード変更の反映用

# テスト
npm test                          # 全テスト (unit + integration + stress)
npm run test:unit                 # unit のみ
npm run test:integration          # integration のみ
npm run test:stress               # stress のみ
npm run test:e2e                  # E2E (Playwright)
npm run test:coverage             # カバレッジ付き

# 開発支援
npm run download-model            # MiniLM ONNX モデルを手動DL (.model-cache/ に保存)
npm run check-version             # manifestsのバージョンがpackage.jsonと一致するか検証
npm run sync-version              # manifestsをpackage.jsonのバージョンに合わせる
.\scripts\validate.ps1            # push前チェック (YAML lint + shared同期 + バージョン整合 + 構造確認)
.\scripts\sync-shared.ps1         # shared/injected/ を両拡張機能に同期 (後述)
```

### バージョン管理

`package.json` の `version` が**唯一の真実**。`extension/manifest.json` と `firefox-mv2/manifest.json` はこれに追従し、`npm run check-version`（実体は `scripts/_check-version.js`）が一致を検証する。CI (`ci.yml` の `verify-sync`) と `validate.ps1` の両方がこのチェックを走らせるため、ズレたまま push すると落ちる。

バージョンを上げるときは `npm version patch`（/`minor`/`major`）を使う。`package.json` と `package-lock.json` が更新され、`version` ライフサイクルスクリプトが両manifestを自動同期してコミット＆タグに含める。`git push --follow-tags` で `release.yml` が起動する。`package-lock.json` は npm が管理するためチェック対象外（`npm version`/`npm install` で自然に揃う）。

## Architecture

```
AI Agent (Claude / Cursor / etc.)
    │ MCP stdio (JSON-RPC 2.0)  ─OR─  HTTP :7892
    ▼
server/index.js          ← エントリーポイント。HTTP:7892 + WS:7891 を立ち上げ
    ├── server/core.js           ← WhiskorCore: WSメッセージのルーティングと永続化
    ├── server/mcp-server.js     ← MCP層 (62ツール)
    │       ├── mcp/registry.js        ← ツール登録・フィルター・プリセット
    │       ├── mcp/transport.js       ← stdio JSON-RPCトランスポート
    │       └── mcp/tools/
    │               ├── read.js / read-basic.js / read-data.js / read-state.js / read-helpers.js
    │               ├── write.js       ← 16 writeツール (click/type等は observe オプションで操作後の状態ハッシュ安定を観測可能)
    │               ├── tabs.js        ← 4 タブ管理ツール (list_tabs/switch_tab/open_tab/close_tab)
    │               ├── capture.js / capture-element.js  ← 3 captureツール
    │               ├── control.js     ← 6 controlツール (+ 4メタツールはtool-manager)
    │               ├── intelligence.js← 5 intelligenceツール
    │               └── replay.js      ← replay_session
    ├── server/tool-manager.js   ← 動的プロファイルロード/アンロード (ALWAYS_VISIBLE_TOOLS)
    ├── server/cache-writer.js   ← ディスク永続化 (cache/sessions/{tabId}/raw/...)
    ├── server/cache-integrity.js← 起動時キャッシュ検証・自動修復
    ├── server/action-executor.js← アクション実行ルーター
    ├── server/screenshot-manager.js ← スクリーンショット + 要素キャプチャ管理
    ├── server/app-registry.js   ← マルチアプリ分離 (appIsolation設定で有効化)
    ├── server/state-store.js    ← ステートグラフ (LRU + gzip + 後方互換コア)
    ├── server/state-machine.js  ← state-store.js への後方互換ラッパー
    ├── server/state-persistence.js ← ステートグラフのディスクI/O
    ├── server/state-fingerprint.js ← FNV32ハッシュエンジン
    ├── server/state-semantic.js ← ラベル生成・タグ抽出・keyState・検索
    ├── server/state-navigator.js   ← BFS経路探索 + アクションリプレイ
    ├── server/state-visualizer.js  ← ASCIIステートグラフレンダリング
    ├── server/delta-engine.js   ← スマートデルタ集約・モーションクラスタリング
    ├── server/pattern-registry.js  ← UIパターン保存 + ref ID参照
    ├── server/correlator.js     ← TimeSeriesCorrelator (UI変化の因果相関)
    ├── server/source-store.js   ← CSSソースキャッシュ + クロスセッションハッシュ
    ├── server/source-map-resolver.js ← VLQ sourcemap解決・LRUキャッシュ
    ├── server/conclusion-cache.js   ← explain_element結果キャッシュ (SHA-256無効化)
    ├── server/session-replay.js     ← actions.jsonl記録 + リプレイエンジン
    ├── server/config-loader.js      ← config.json + .env + mcp-tools.json読み込み
    ├── server/config-change-log.js  ← エージェント設定変更追跡・自動リバート
    └── server/services/
            ├── embed-service.js     ← セマンティック検索オーケストレーション
            ├── embed-store.js       ← 埋め込みベクトルLRUキャッシュ
            ├── embed-worker.js      ← Transformers.js ONNX実行
            ├── embed-worker-pool.js ← ワーカースレッドプール管理
            └── load-monitor.js      ← イベントループ遅延検知

extension/ (Chrome MV3)          firefox-mv2/ (Firefox MV2)
    ├── background/sw.js              background/background.js
    └── injected/                 └── injected/  ← shared/ からコピーされる
            ├── plugin-system.js      ← ホットリロード可能なプラグインレジストリ
            ├── collector.js          ← プラグイン出力アグリゲーター
            ├── bridge.js             ← ISOLATED world中継
            ├── executor.js           ← アクション実行 (click/type/key/scroll/JS)
            ├── explorer.js           ← 自律ページ探索 (compositeHash)
            ├── state-reporter.js     ← REQUEST_STATE_HASH ハンドラ
            ├── adapters/             ← フレームワーク状態抽出 (9アダプター)
            │   react.js + react-hooks.js + react-state-managers.js
            │   vue3.js / vue2.js / angular.js / svelte.js
            │   preact.js / alpine.js / solid.js / dom-generic.js
            └── analyzers/            ← ページデータ収集 (15アナライザー)
                text-coords.js / network.js / css.js / css-origin.js
                source-fetcher.js / ui-catalog.js / perf.js
                dom-mutations.js / shadow-dom.js / dom-snapshot.js
                clickability.js / framework-dom-map.js
                accessibility.js / console-logger.js / storage-reader.js
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

常時公開は14ツールの `core` プロファイルのみ。他のプロファイルはキーワード自動検出またはAIの明示的なロードで動的に有効化・無効化される。`search_tools` / `load_profile` / `unload_profile` / `profile_status` / `analyze_click` の5つは常時公開される「メタツール」（`server/tool-manager.js` の `ALWAYS_VISIBLE_TOOLS`）。

| プロファイル | ツール数 | 主なツール | 自動トリガーキーワード | アイドル解除 |
|---|---|---|---|---|
| **core** (14) | 常時 | get_sessions, get_index, get_text_coords, get_viewport, get_framework_state, get_ui_catalog, get_network, find_target, refresh_data, capture_screenshot, capture_element_screenshot, click, type_text, navigate_to | — | なし |
| **debug** (+6) | 自動 | get_console_logs, get_storage, get_perf_metrics, get_css_analysis, get_dom_snapshot, get_accessibility | "console", "debug", "error" | 10ターン |
| **state-nav** (+9) | 自動 | get_state_map, list_states, search_states, get_state_detail, pin_state, navigate_to_state, get_navigation_path, get_state_map_visual, replay_session | "state", "graph", "navigate", "replay" | 8ターン |
| **delta** (+3) | 自動 | get_delta, list_patterns, lookup_pattern | "delta", "change", "scroll" | 6ターン |
| **advanced-actions** (+11) | 自動 | drag, hover, select_option, check_box, mouse_scroll, right_click, press_key, go_back, go_forward, reload_page, scroll_page | "drag", "hover", "select" | 5ターン |
| **tabs** (+4) | 自動 | list_tabs, switch_tab, open_tab, close_tab | "switch tab", "new tab", "popup", "redirect" | 6ターン |
| **intelligence** (+4) | 自動 | explain_element, why_did_this_change, get_source_file, detect_site_updates | "explain", "why", "source", "cause" | 5ターン |
| **admin** (+4) | 自動 | set_config, get_config_changes, trigger_collect, trigger_explorer | "config", "collect" | 3ターン |
| **power** (+2) | 自動 | execute_js, wait_for_element | "execute", "wait" | 2ターン |

プロファイル定義は `server/configs/tool-profiles.json`。ツール有効/無効設定は `server/configs/mcp-tools.json`。

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
- `agentControl.argTriggerDetection`: デフォルト `true`。プロファイル自動ロードのトリガー判定でツール引数のテキストも走査するか（whole-wordマッチ）。`false` でツール名のみ判定に戻す
- `adaptiveCollection.enabled`: デフォルト `false`。アダプティブ収集スケジューラ（SW側 `CollectionScheduler`）の有効化
- `intelligence.miniLM.downloadOnStart`: 起動時のモデル自動DL (初回のみ、~50MB)

## Coding Style

- **CommonJS** (`'use strict'`, `require`/`module.exports`)。ESMは使わない
- **拡張機能側はゼロ依存**のバニラJS
- ESLint設定 (`.eslintrc.json`): `ecmaVersion: 2022`、`no-var: warn`、`prefer-const: warn`
- コメントは英語・日本語の両方で書かれることが多い (`_comment_en` / `_comment_ja` フィールド)

## Known Issues / Notes

- `plugin-system.js` の `dependencies` フィールドは `source-fetcher` / `css-origin` / `framework-dom-map` の3件のみ設定済み。他のプラグインは `|| []` フォールバックで動作するが、厳密な依存順序は未保証
- `start.ps1` のバナー内バージョン表示が `v0.3.0` と古い（`mcp-server.js` コメントも `v0.3.0` / 55ツール表記が残っている）—実際のバージョンは `v0.4.5`、62ツール（正は `package.json`）
- アダプティブ収集スケジューリング（Proposal D）は **実装済みだがデフォルト無効**。実体は `extension/background/sw.js` の `CollectionScheduler` クラス（two-speed cadence: active/quiescent）。`config.json` の `adaptiveCollection.enabled: true` で有効化する。SW（長寿命）側に置かれているのは、ナビゲーションごとに破棄される MAIN-world の `collector.js` ではタイマーが保持できないため

## Key Ports & Endpoints

| | |
|---|---|
| `WS :7891` | 拡張機能との通信ブリッジ |
| `HTTP :7892` | REST API + ダッシュボード |
| `GET /health` | 接続確認 |
| `GET /` | ダッシュボード |
| `GET /api/config` | 現在の設定取得 |
| `POST /api/config` | 設定変更 |
| `GET /api/sessions` | セッション一覧 |
| `GET /api/sessions/:tabId` | 特定セッションの詳細 |
| `DELETE /api/sessions/:tabId` | セッション削除 |
| `GET /api/sessions/:tabId/states` | ステート一覧 |
| `GET /api/graphs` | ステートグラフ一覧 |
| `POST /api/action` | ブラウザ操作 (click/type/navigate 等) |
| `POST /api/screenshot` | スクリーンショット取得 |
| `POST /api/collect` | データ収集トリガー |
| `POST /api/embed` | テキストベクトル埋め込み (MiniLMモデル) |
| `POST /api/plugins/:id/:action` | プラグインON/OFF (`enable`/`disable`) |

## CI / GitHub Actions

`.github/workflows/` に2つのワークフローがある:
- **ci.yml** (push/PR → main): `shared/injected/` が変更されていれば両拡張機能に自動同期コミット、その後テスト実行
- **release.yml** (`v*` タグ or 手動): Chrome・Firefox・フルバンドルの ZIP をビルドし GitHub Release を作成

リリース手順: `npm version patch`（package.json/lock/manifestを揃えてコミット＆タグ生成）→ `git push --follow-tags`。タグから `release.yml` がバージョンを取得する。既存リリースの上書きは guard でブロックされる（意図的に上書きする場合は注釈付きタグメッセージに `re-release` を含めるか、手動実行で `force_release=true`）

## Manual Testing

`manual/` ディレクトリに手動テスト用ツールがある。詳細は `manual/README.md` 参照。

```powershell
# 非対話型 MCP CLI (推奨 — スクリプト・CI向け)
node manual/mcp-client.js ping
node manual/mcp-client.js call get_sessions
node manual/mcp-client.js call capture_screenshot '{"tabId":1234}'
node manual/mcp-client.js list     # ツール一覧
node manual/mcp-client.js profiles # プロファイル状態

# 対話型MCPシェル (Windows は事前に chcp 65001 が必要)
python manual/mcp-shell.py

# ワンライナーMCP呼び出し (NonInteractive環境では不可)
.\manual\mcp.ps1 -call get_sessions
.\manual\mcp.ps1 -call capture_screenshot -json '{"tabId":1234}'
```
