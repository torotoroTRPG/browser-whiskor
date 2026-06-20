# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**browser-whiskor** はAIエージェントにブラウザの「知覚能力」を与えるChrome/Firefox拡張機能 + Node.jsサーバー（バージョンは `package.json` が真実）。拡張側がページ内のDOM・フレームワーク状態・ネットワーク・テキスト座標などを収集し、サーバーがHTTP APIとMCP (Model Context Protocol) stdioの両方でAIエージェントに公開する。

## Commands

```bash
# サーバー起動
npm start                         # 通常起動 (HTTP:7892 + WS:7891)。supervisor配下で自動再起動つき（後述「クラッシュ耐性」）
npm run start:raw                 # supervisorなしで生起動（クラッシュを調べたい時など）
node server/index.js --mock       # モックデータで起動
node server/index.js --verbose    # 全メッセージをログ出力
node server/index.js --mcp        # MCPスタンドアロンモード (stdio)
npm run stop                      # 7891/7892 を握る whiskor サーバーを停止
npm run restart                   # 停止→(可能なら)拡張再ビルド→再起動。コード変更の反映用

# セットアップ / CLI (whk)
.\scripts\setup.ps1               # 初回ブートストラップ: whk/whiskor をグローバル登録(npm link) → whk setup に委譲
whk setup                         # 拡張を管理dir(~/.whiskor/)へ配置/更新 → サーバー起動。稼働中なら拡張に自己リロードを依頼（後述「管理ディレクトリと拡張の自動更新」）
whk setup --no-start              # 拡張ファイルの同期のみ
whk                               # = whk restart。拡張ファイル更新 → 拡張リロード依頼 → 旧サーバー停止 → 新規起動（未稼働なら単に起動）
whk restart [--no-sync]           # 同上（--no-sync で拡張ファイル更新をスキップ）。restart.ps1 のクロスプラットフォーム版
whk stop                          # 稼働中サーバーを graceful 停止（POST /api/shutdown。flush して exit 0 → supervisor も停止）
whk shell                         # 人間用の全画面TUIシェル（出力ペイン+候補ポップアップ+ラインエディタ+ステータスバー）。実体は server/tui/、ゼロ依存
whk shell --classic               # 旧インラインプロンプト版（server/cli-shell.js）。非TTY（パイプ）は常に行REPL
whk server / whk mcp / whk GET /health  # CLIエントリ (server/cli.js。bin: whk / whiskor)。server は素の起動（ポート使用中なら失敗）

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
    ├── server/mcp-server.js     ← MCP層 (68ツール)
    │       ├── mcp/registry.js        ← ツール登録・フィルター・プリセット
    │       ├── mcp/transport.js       ← stdio JSON-RPCトランスポート
    │       └── mcp/tools/
    │               ├── read-basic.js / read-data.js / read-state.js (+read.js/read-helpers.js) ← 23 readツール (search_all_tabs 含む)
    │               ├── write.js       ← 17 writeツール (type_secret 含む。click/type等は observe オプションで操作後の状態ハッシュ安定を観測可能)
    │               ├── tabs.js        ← 4 タブ管理ツール (list_tabs/switch_tab/open_tab/close_tab)
    │               ├── capture.js / capture-element.js  ← 5 captureツール (capture_packed_som / get_element_thumbnail 含む)
    │               ├── control.js     ← 10 controlツール (navigate_to_state / get_navigation_path / メタ4種含む)
    │               ├── intelligence.js← 6 intelligenceツール (analyze_click / get_state_map_visual 含む)
    │               ├── ocr.js         ← ocr_region (ピクセルからのOCR読取。canvas/WebGL・アイコンのみ要素向け)
    │               ├── source.js      ← get_source_context (アップロード済ソースのスライス)
    │               └── replay.js      ← replay_session
    ├── server/tool-manager.js   ← 動的プロファイルロード/アンロード (ALWAYS_VISIBLE_TOOLS)
    ├── server/cache-writer.js   ← ディスク永続化 (cache/sessions/{tabId}/raw/...)
    ├── server/cache-integrity.js← 起動時キャッシュ検証・自動修復
    ├── server/action-executor.js← アクション実行ルーター (type_secret の ref→値解決もここ)
    ├── server/screenshot-manager.js ← スクリーンショット + 要素キャプチャ + packed SoM + マスク適用
    ├── server/secret-guard.js   ← 秘匿ガード (サーバー側 redaction、privacy.secretGuard)
    ├── server/som-stats.js      ← packed SoM クリック統計 (時間減衰スコア・並べ替え)
    ├── server/som-cache.js      ← packed SoM フレッシュネス連動LRUキャッシュ
    ├── server/som-thumbnails.js ← per-element サムネイルキャッシュ (view-aware無効化)
    ├── server/source-index.js   ← アップロード済ソース保存・スライス・symbol検索
    ├── server/source-correlation.js ← 実行時観測↔ソース相関 (debug-source優先)
    ├── server/zip-writer.js / zip-reader.js ← 依存ゼロ ZIP I/O (/export・source upload)
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
    ├── server/session-search.js     ← 全セッション横断テキスト検索 (GET /api/search ＋ MCP search_all_tabs で共有)
    ├── server/session-list.js       ← セッション一覧のソート/検索/ページング (GET /api/sessions ＋ MCP get_sessions で共有)
    ├── server/session-replay.js     ← actions.jsonl記録 + リプレイエンジン
    ├── server/config-loader.js      ← config.json + .env + mcp-tools.json読み込み
    ├── server/cli.js                ← whk / whiskor CLIエントリ (setup / restart / stop / shell / server / mcp / HTTPクライアント / skills)
    ├── server/cli-shell.js          ← whk shell --classic / 非TTY行REPL + 共有エンジン (catalog/filter/parse/request)
    ├── server/tui/                  ← whk shell 全画面TUI: app.js (本体) + term.js (ANSI/東アジア文字幅) + editor.js + scrollback.js + highlight.js
    ├── server/extension-installer.js← 拡張の管理dir(~/.whiskor/)配置・更新 (staged swap)
    ├── server/config-change-log.js  ← エージェント設定変更追跡・自動リバート
    └── server/services/
            ├── ocr-service.js       ← native OCRエンジン結合 (bring-your-own バイナリ。Tesseract互換出力)
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

`shared/injected/` が **injectedスクリプトの正規ソース**。ただし**カバレッジは部分的**で、`shared/` にあるファイルだけを Chrome・Firefoxの両ビルドへコピーする。

- **`shared/` にあるファイルを変更するときは必ず `shared/injected/` を編集する**（collector / executor / explorer / state-reporter / 全 adapters / 8 analyzers: accessibility・console-logger・css・dom-mutations・dom-snapshot・perf・shadow-dom・storage-reader / lib）
- 変更後に `.\scripts\sync-shared.ps1` を実行して両拡張機能に反映する。`sync-shared.ps1` は **`shared/` に存在するファイルのみ**を両拡張へコピーする（下記の shared 外ファイルは認識せず、上書きも削除もしない＝破壊しない）
- **shared 外のファイルは `extension/injected/` と `firefox-mv2/injected/` を直接・両方編集する**必要がある：7 analyzers（`text-coords` / `network` / `css-origin` / `source-fetcher` / `ui-catalog` / `framework-dom-map` / `clickability`）と `plugin-system.js` / `bridge.js`。これらは Chrome/Firefox 間で既存実装が乖離している箇所もあるため、編集前に両者を確認すること
- `.\scripts\validate.ps1` が（shared 対象ファイルの）同期ズレを検出する

### サーバーの2モード

1. **通常モード** (`npm start`): HTTP:7892 と WS:7891 の両方を開く。ブラウザ拡張機能がWS:7891に接続し、ダッシュボードは http://localhost:7892/ で閲覧可能
2. **MCPモード** (`--mcp`): stdioでJSON-RPC 2.0を処理。ポート:7892が既に使用中の場合は**Proxyモード**に自動切替し、既存サーバーへ全操作を透過的に転送する（ポート競合なし）

### クラッシュ耐性（自動再起動 + 無損失な引き継ぎ）

「稀に落ちる」ワーカーを綺麗に復帰させる仕組み。役割が2プロセスに分かれている（重い処理＝ワーカー／エージェントと喋る軽いMCPプロキシ）構造を利用している。

- **`scripts/supervisor.js`**（`npm start` と `start.ps1` のデフォルト。生起動は `npm run start:raw` / `start.ps1 -NoSupervisor`）: ワーカー（`server/index.js`）を子プロセスで起動・監視し、**非ゼロ終了＝クラッシュのときだけ**バックオフ再起動する。シグナル由来のクリーン終了（code 0）では再起動しない。クラッシュループ保護つき（60秒で5回落ちたら停止）。ゼロ依存CommonJS。MCP起動（`node server/index.js --mcp`）はsupervisorを通さない（エージェント側が握るため）
- **アトミック書き込み**: `cache-writer.js` の `writeJson`/`writeJsonAsync` は `tmp書き込み→rename` で書く。クラッシュが書き込み途中に当たっても旧ファイルが残り、半端JSONは生まれない
- **クラッシュ時flush**: `index.js` の `uncaughtException`/`unhandledRejection`/SIGTERM/SIGINT ハンドラ（`shutdown()`）が `cache.flushAllSync()` でメモリ上のnetwork/consoleバッファを同期保存してから `exit`（クラッシュは非ゼロ→supervisorが再起動）
- **起動時リカバリ**: 既存の `checkAndRepair`（壊れた`_index.json`の自動修復）に加え、`cleanupTempFiles()` がクラッシュで残った孤立 `.tmp` を掃除する
- **プロキシのリトライ（第3層・ダウン中の指示の無損失化）**: Proxyモードの `requestServer()` が、ワーカー再起動中の接続レベル失敗（ECONNREFUSED等）を `resilience.proxyRetry` の設定（既定: 最大15秒バックオフ）まで再試行する。エージェント↔MCPプロキシは別プロセスなのでワーカーのクラッシュが届かず、ツール呼び出しは「少し待たされて成功」になる。**接続拒否はワーカーに届いていないため再送で操作の二重実行は起きない**。HTTPエラー応答（ワーカーが処理済み）は再試行せずそのまま返す
- 守るのは「ワーカーが落ちる」ケース（実際に稀に起きる重い側）。MCPプロキシ自体の再起動はエージェント（Claude/Cursor）側が握るため対象外だが、プロキシは「HTTP転送するだけ」の軽量プロセスでまず落ちない

### ステートグラフのハッシュ方式

- `reactHash`: Reactコンポーネントツリー形状 + routerパス + storeキー (FNV32)
- `domHash`: URLパス名 + インタラクティブ要素のシグネチャ
- `compositeHash`: React利用可能時は `FNV32(reactHash + domHash)`、それ以外は `domHash`
- 非確定的な値 (timestamp, UUID, loadingフラグ) はハッシュ計算から除外される

### MCPツールプロファイル

常時公開は17ツールの `core` プロファイルのみ。他のプロファイルはキーワード自動検出またはAIの明示的なロードで動的に有効化・無効化される。`search_tools` / `load_profile` / `unload_profile` / `profile_status` / `analyze_click` の5つは常時公開される「メタツール」（`server/tool-manager.js` の `ALWAYS_VISIBLE_TOOLS`）。

| プロファイル | ツール数 | 主なツール | 自動トリガーキーワード | アイドル解除 |
|---|---|---|---|---|
| **core** (17) | 常時 | get_sessions, search_all_tabs, get_index, get_text_coords, get_viewport, get_framework_state, get_ui_catalog, get_network, find_target, refresh_data, capture_screenshot, capture_element_screenshot, capture_packed_som, get_element_thumbnail, click, type_text, navigate_to | — | なし |
| **debug** (+6) | 自動 | get_console_logs, get_storage, get_perf_metrics, get_css_analysis, get_dom_snapshot, get_accessibility | "console", "debug", "error" | 10ターン |
| **state-nav** (+9) | 自動 | get_state_map, list_states, search_states, get_state_detail, pin_state, navigate_to_state, get_navigation_path, get_state_map_visual, replay_session | "state", "graph", "navigate", "replay" | 8ターン |
| **delta** (+3) | 自動 | get_delta, list_patterns, lookup_pattern | "delta", "change", "scroll" | 6ターン |
| **advanced-actions** (+12) | 自動 | drag, hover, select_option, check_box, mouse_scroll, right_click, press_key, type_secret, go_back, go_forward, reload_page, scroll_page | "drag", "hover", "select" | 5ターン |
| **tabs** (+4) | 自動 | list_tabs, switch_tab, open_tab, close_tab | "switch tab", "new tab", "popup", "redirect" | 6ターン |
| **intelligence** (+6) | 自動 | explain_element, why_did_this_change, get_source_file, detect_site_updates, get_source_context, ocr_region | "explain", "why", "source", "cause", "ocr", "canvas" | 5ターン |
| **admin** (+4) | 自動 | set_config, get_config_changes, trigger_collect, trigger_explorer | "config", "collect" | 3ターン |
| **power** (+2) | 自動 | execute_js, wait_for_element | "execute", "wait" | 2ターン |

プロファイル定義は `server/configs/tool-profiles.json`。ツール有効/無効設定は `server/configs/mcp-tools.json`。

動的なツール増減は MCP の `notifications/tools/list_changed` で通知される（`tools/call` の前後で可視ツール集合が変わったとき。capabilities で `tools.listChanged: true` を宣言。実体は `mcp/transport.js` の `handleLine`）。通知に追従しないクライアント向けには `mcpServer.staticTools: true`（または `--static-tools`）で全プロファイル常時公開の**静的モード**にできる（`tool-manager.js` の `setStaticMode`）。なお MCP stdio 動作中は `console.log`/`console.info` が stderr へリダイレクトされる（stdout は JSON-RPC 専用チャネルのため。`transport.js` の `startMcpServer` 冒頭）。

MCPを使わないエージェント向けには、HTTP APIだけでブラウザを知覚・操作する同梱スキルが `skills/browser-whiskor-http/` にある（コピーして使う。`skills/README.md` 参照）。

## Extension Setup

**Chrome/Edge:**
`chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」→ `extension/` フォルダを選択

**Firefox:**
`about:debugging` → この Firefox → 一時的なアドオンを読み込む → `firefox-mv2/manifest.json` を選択 (Firefox は `extensions.experiments.enabled = true` が必要)

### 管理ディレクトリと拡張の自動更新（whk setup）

リポジトリ外で使う場合（npm グローバル / リリース配布）は `whk setup` が同梱の `extension/`・`firefox-mv2/` を**管理ディレクトリ `~/.whiskor/`**（`WHISKOR_MANAGED_DIR` で変更可）へコピーし、ユーザーはそこから一度だけ unpacked で読み込む。以後の `whk setup` は同じ場所をin-placeで更新する（staged swap＝コピー途中のクラッシュで半端な拡張が残らない。実体は `server/extension-installer.js`）。

更新の伝搬は2経路:
- **稼働中サーバーあり**: `whk setup` がファイル同期後に `POST /api/extension/reload` を呼び、サーバーが WS 経由で `RELOAD_EXTENSION` を送る → 拡張が `runtime.reload()` でディスクから再読込
- **バージョン不一致検出**: 拡張は WS 接続時に `EXT_HELLO`（manifest バージョン＋ブラウザ種別）を申告する。サーバーバージョンと違えば一度だけリロードを依頼する（`extensionUpdate.autoReload`、古いバージョンごとにプロセス内1回＝ファイルが古いままでもループしない）。接続中の拡張バージョンは `GET /health` の `extensions` で見える

注意: 拡張は自分のインストールパスをAPIで取得できない（ブラウザの設計）ため「拡張に場所を聞く」方式は不可能で、whk が置き場所を所有するこの方式になっている。管理パスは HTTP/MCP に一切公開されない。すでに開いているタブの content script はリロードでは再注入されない（タブの再読み込みが必要）。

初回ブートストラップは `.\scripts\setup.ps1`（`whk` 未登録なら `npm link` で登録 → `whk setup` に委譲）。

### whk shell TUI

`whk shell`（全画面、既定）はカテゴリをフォルダのように扱うナビゲーション付き。`server/cli-shell.js` の `baseCatalog()` が各エントリに `cat`（`action`/`capture`/`session`/`state`/`server`/`shell`）を持ち、ルート表示は `action/`・`capture/` … というフォルダ行（`categoriesOf()`）になる。Enter/Tab/ダブルクリックでフォルダに入り、Esc・`..`選択・空行でのBackspaceで戻る。ルートでの入力は全体検索（フォルダ内のコマンドもヒットする）、フォルダ内では絞り込みのみ。候補ポップアップは選択位置を中心に自動スクロール（`popupStart`）。

入力欄が空のとき、←→はフォルダ/フィールド編集の階層ナビになる（`server/tui/app.js`）:
- **→** — ハイライト中の行がフォルダなら開く。コマンドが `"selector":""` / `"text":""` / `"url":"https://"` のような自由入力プレースホルダーを持つ場合は「フィールド編集」オーバーレイを開く（`detectFields()`）
- **←** — フィールド編集中はキャンセルして候補リストへ戻る。フォルダ内ならルートへ戻る
- フィールド編集: 1フィールドずつ自前の `LineEditor` で値を入力、Tab/Enterで次のフィールドへ。最後のフィールドでEnter → `substituteFields()` が全値をテンプレートへ埋め込み入力欄にセット（**この時点では未送信**、見直して再度Enterで送信）。空欄のまま進めたフィールドは元のプレースホルダーを保持。Esc / 空フィールドでのBackspaceでキャンセル

TUI専用ビルトイン:
- `logs [n]` — `GET /api/logs` で直近のサーバーログ（リングバッファ最大2000件、`core.js` の `broadcastLog`/`_logBuffer`）を表示
- `export [path]` — このシェルのトランスクリプトをファイル保存（既存ファイルは上書きしない）。`formatTranscript()` がヘッダ（exported時刻・サーバーアドレス・バージョン）を付与
- `map [tabId]` — `GET /api/sessions/:tabId/map` でアクティブタブ（省略時は最新セッション）のステートグラフをASCIIツリー表示。データが無ければ「No state graph found」、セッションのsiteVersionに紐づくグラフが空ならノード数最大のグラフへフォールバック
- `mouse` — マウスキャプチャのON/OFF切替（OFFにすると端末のテキスト選択/コピーが効く）

`whk shell --classic`（旧インラインプロンプト、`server/cli-shell.js`）も同じ `cat`/フォルダ判定ロジックを共有するが、フォルダUIは持たない。

## Configuration

`config.json` がメイン設定。`.env` ファイルや環境変数で `WHISKOR_<SECTION>_<KEY>=<value>` 形式で上書き可能。**ネストキーも可**：各 `_` 区切りが1階層を下り、キー名は大文字小文字・アンダースコアを無視して照合する（例：`WHISKOR_PRIVACY_SECRETGUARD_ENABLED=true` → `privacy.secretGuard.enabled`、`WHISKOR_AGENTCONTROL_PACKEDSOM_PREFETCHONNAVIGATE=true`）。既存キーに一致しない env は無視される（キーを新設しない）。実体は `config-loader.js` の `applyEnvOverrides`。

主要な設定項目:
- `security.allowExecuteJs`: デフォルト `false`。`execute_js` ツールを使うには `true` が必要
- `mcpServer.staticTools`: デフォルト `false`。`true` で全MCPツールプロファイルを常時公開（動的load/unload無効）。`tools/list` を一度しか取得しないMCPクライアント向け。`--static-tools` フラグでも有効化可。requiresConfigゲートと `mcp-tools.json` の enabled は引き続き適用（可視範囲を広げるだけで権限は広げない）
- `agentControl.allowAgentConfig`: デフォルト `false`。AIエージェントによる `set_config` 呼び出しを許可するか
- `agentControl.screenshotMarks`: Set-of-Marks (要素番号オーバーレイ) の有効化
- `agentControl.autoSwitchTab`: デフォルト `true`。アクション/スクリーンショット/packed SoM/要素キャプチャの対象タブが非アクティブなら、実行前に拡張がそのタブへ自動切り替えする（タブのみ。OSウィンドウフォーカスは奪わない）。`captureVisibleTab` はアクティブタブしか写せないため、これが無いとバックグラウンドタブのスクショは別タブの画になる。タブ管理系アクション（list/switch/open/close_tab）は対象外。実体は両 background の `ensureTabActive`
- `agentControl.input.highFidelity`: デフォルト `off`。`click`/`type_text`/`press_key` を CDP (`chrome.debugger`) 経由の trusted 入力にする。`off`=synthetic（従来）/ `fallback`=synthetic を試し `no_state_change` の click だけ CDP 再試行 / `always`=常に CDP。**Chrome専用**（Firefox は `inputMode` を無視し常に synthetic）。CDP アタッチ中は「デバッグしています」バナーが出る。実体は `extension/background/sw.js` の `executeHighFidelity`、manifest に `debugger` 権限（Chrome のみ追加済み）
- `agentControl.argTriggerDetection`: デフォルト `true`。プロファイル自動ロードのトリガー判定でツール引数のテキストも走査するか（whole-wordマッチ）。`false` でツール名のみ判定に戻す
- `adaptiveCollection.enabled`: デフォルト `false`。アダプティブ収集スケジューラ（SW側 `CollectionScheduler`）の有効化
- `extensionUpdate.autoReload`: デフォルト `true`。拡張が古いバージョンで接続してきたとき（`EXT_HELLO` 申告がサーバーと不一致）、一度だけ `RELOAD_EXTENSION` で自己リロードを依頼する。古いバージョンごとにプロセス内1回のガードつき（リロードしてもファイルが古いままなら警告のみ）。`false` でログ警告のみ。agent からは read-only（`permissions.agentReadOnlyPaths`）
- `privacy.secretGuard.enabled`: デフォルト `false`。秘匿ガード（サーバー側 redaction）。`secrets.local.json` / `WHISKOR_SECRETS` の既知値＋パターン（email/クレカ/JWT。ssn/ipv4/phone は `patterns` で個別opt-in）＋キー名ベース置換。`type_secret` は ref 名のみで実値はワーカーが解決。スクショは拡張canvas上で黒塗り
- `agentControl.packedSom.prefetchOnNavigate` / `prefetchThumbs`: デフォルト `false`。遷移後の packed SoM 先回りキャプチャ／packed キャプチャ時の per-element サムネイル温め
- `intelligence.miniLM.downloadOnStart`: 起動時のモデル自動DL (初回のみ、~50MB)
- `intelligence.ocr`: native OCR (`ocr_region` ツール / `POST /api/ocr`)。DOM ベースの `get_text_coords` が拾えない「ピクセルにしかないテキスト」用＝canvas/WebGL アプリ (Unity 等) やテキストノードを持たないアイコンのみの要素。**bring-your-own バイナリ**で重い npm 依存は同梱しない。エンジン解決順は `binPath`（明示パス）→ 環境変数 `WHISKOR_OCR_PATH` → PATH 上の `tesseract`。見つからなければ `ocr_region` は `ocr_unavailable`（導入手順つき）を返すだけで無害。`lang`（Tesseract 言語コード、`'eng+jpn'` のように `+` 連結。エンジンに言語データのインストールが必要）/ `psm`（ページ分割モード、既定3）。出力は `get_text_coords` と同じ Tesseract 互換スキーマ。実体は `server/services/ocr-service.js`（エンジン解決＋認識）＋ `index.js` の `ocrCapture`（キャプチャ→認識、MCP直結/HTTP/proxy で共有）
- `identity.instanceId` / `identity.name`: インスタンスの説明的ラベル（**セキュリティではない**）。`GET /health` と MCP `serverInfo` で公開。狙いは「自前のブラウザ自動化ツールに whiskor を**組み込んでもグローバルを汚染しない**」こと＝埋め込み側が自分の whiskor を他の（グローバルな）whiskor と取り違えずに済む。`instanceId` が `null` のとき `whiskor-<hostname>-<httpPort>` に自動導出（host:port単位で一意＝共有デフォルト衝突なし。埋め込み時は専用ポート＋`WHISKOR_IDENTITY_INSTANCEID` 推奨）。タブ単位の実分離が要るなら `appIsolation` を併用。実体は `server/index.js` の `IDENTITY` 構築 → `core.js`(/health) と `mcp/transport.js`(serverInfo)

## Coding Style

- **CommonJS** (`'use strict'`, `require`/`module.exports`)。ESMは使わない
- **拡張機能側はゼロ依存**のバニラJS
- ESLint設定 (`.eslintrc.json`): `ecmaVersion: 2022`、`no-var: warn`、`prefer-const: warn`
- コメントは英語・日本語の両方で書かれることが多い (`_comment_en` / `_comment_ja` フィールド)

## Known Issues / Notes

- `plugin-system.js` の `dependencies` フィールドは `source-fetcher` / `css-origin` / `framework-dom-map` の3件のみ設定済み。他のプラグインは `|| []` フォールバックで動作するが、厳密な依存順序は未保証
- バージョン表記は `package.json` が唯一の真実。`start.ps1` バナーは package.json から動的に読む（再 stale 化しない）、`mcp-server.js` のヘッダコメントはハードコードを廃止済み
- アダプティブ収集スケジューリング（Proposal D）は **実装済みだがデフォルト無効**。実体は `extension/background/sw.js` の `CollectionScheduler` クラス（two-speed cadence: active/quiescent）。`config.json` の `adaptiveCollection.enabled: true` で有効化する。SW（長寿命）側に置かれているのは、ナビゲーションごとに破棄される MAIN-world の `collector.js` ではタイマーが保持できないため

## Key Ports & Endpoints

| | |
|---|---|
| `WS :7891` | 拡張機能との通信ブリッジ |
| `HTTP :7892` | REST API + ダッシュボード |
| `GET /health` | 接続確認 |
| `GET /` | ダッシュボード |
| `GET /export` | セッションキャッシュをZIPでダウンロード（`?tabId=` で単一セッションに限定）。実体は `server/zip-writer.js`（依存ゼロの自前ZIP） |
| `GET /api/config` | 現在の設定取得 |
| `POST /api/config` | 設定変更 |
| `POST /api/extension/reload` | 接続中の拡張に自己リロードを依頼（`whk setup`/`whk restart` のファイル更新後に使用） |
| `POST /api/shutdown` | graceful 停止（flush → exit 0 ＝ supervisor も停止）。`whk stop`/`whk restart` が使用 |
| `GET /api/sessions` | セッション一覧（既定は関連度順の配列）。`?q=&mode=exact\|fuzzy\|semantic&sort=relevant\|recent\|created\|title\|url&minScore=&tabId=&page=&pageSize=&verbose=` で検索/ソート/ページング。enhanced パラメータ指定時は `{sessions,total,page,totalPages,hasMore,...}` を返す。実体は `server/session-list.js`（MCP `get_sessions` と共有） |
| `GET /api/search` | 全 active セッション横断のテキスト検索（`?q=&mode=exact\|fuzzy\|semantic&level=&minScore=&maxPerTab=`）。実体は `server/session-search.js`（MCP `search_all_tabs` と共有） |
| `GET /api/uninstrumented-tabs` | ブラウザに在るがセッションの無いタブ（`restricted`／`reload_needed`）。拡張の `TAB_INVENTORY` push を元に `core.getUninstrumentedTabs` が算出。`get_sessions` が `UNINSTRUMENTED_TABS` 警告として利用（proxy モードはここから取得）。appIsolation 時は空 |
| `GET /api/sessions/:tabId` | 特定セッションの詳細 |
| `DELETE /api/sessions/:tabId` | セッション削除 |
| `GET /api/sessions/:tabId/states` | ステート一覧（セッションの siteVersion でグラフが見つからなければ全グラフ横断にフォールバック） |
| `GET /api/sessions/:tabId/map` | セッションのステートグラフをASCIIツリーで可視化（`state-visualizer.js`。`?maxNodes=`既定40・最大200。session siteVersionにノードが無ければ最大グラフへフォールバック） |
| `GET /api/graphs` | ステートグラフ一覧 |
| `GET /api/graphs/:siteVersion/states` | 指定グラフのノード一覧（`/states/:hash` で単一ノード詳細） |
| `POST /api/action` | ブラウザ操作 (click/type/navigate 等) |
| `POST /api/screenshot` | スクリーンショット取得（`{tabId,marks?,returnImage?,format?,quality?,maxWidth?}`。MCP同様に format/quality/maxWidth を反映。既定で `dataUrl`＋`filePath`＋`url`、`returnImage:false` で base64 省略。既定の有無は `agentControl.screenshot.httpInlineImage`（既定 true。false でテキストファースト＝url/filePath のみ）でも制御） |
| `GET /api/screenshots/:file` | 保存済みスクショ画像のバイナリ配信（`/api/screenshot` 応答の `url`。base64 を避けて画像取得。basename のみ＝traversal 不可） |
| `POST /api/packed-som` | パックド Set-of-Marks キャプチャ |
| `POST /api/element-thumbnail` | per-element サムネイル取得 |
| `POST /api/ocr` | native OCR でピクセルからテキスト読取（`{tabId,selector?,rect?,lang?,psm?,padding?}`。selector/rect 省略でタブ全体、指定でその領域をクロップ。出力は `get_text_coords` 互換の word 配列。実体は `index.js` の `ocrCapture`＋`server/services/ocr-service.js`） |
| `GET /api/ocr` | OCR エンジンの可用性（`{available, binPath?, version?, lang?}` / 未導入なら `reason` ＋導入手順）|
| `POST /api/source/upload` | プロジェクトソースのアップロード (ファイル群 or base64 zip) |
| `POST /api/source/context` | アップロード済ソースのスライス取得 |
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
