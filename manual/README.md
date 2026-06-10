# browser-whiskor 手動テストマニュアル

全 API / MCP を**人間が手で触りながら**テストするためのリファレンスです。

---

## ⚡ どのツールを使うべきか？

```
MCP 対応アプリ (Claude Code 等) が使える？
  └─ YES → mcp__whiskor__* ツールを直接使う          ✅ 最推奨
        例: mcp__whiskor__get_sessions

MCP 非対応アプリ / スクリプトから呼び出したい？
  └─ YES → manual/mcp-client.js を使う               🔶 準推奨
        例: node manual/mcp-client.js call get_sessions

人間が手で動作確認したい？
  ├─ Python OK → manual/mcp-shell.py (対話型)         🧪 テスト専用
  └─ PS だけ  → manual/mcp.ps1 (ワンライナー)          🧪 テスト専用
                ※ Claude Code の自動実行環境では動作しません
```

## スクリプト一覧

| スクリプト | 言語 | 推奨度 | 説明 | 制限 |
|-----------|------|--------|------|------|
| `mcp-client.js` | Node.js | 🔶 準推奨 | 非対話型・スクリプト向けCLI | なし |
| `mcp-shell.py` | Python | 🧪 テスト専用 | 対話型シェル (AT/MT モード) | Windows 文字コード注意 (`chcp 65001` 必須) |
| `mcp.ps1` | PowerShell | 🧪 テスト専用 | MCP ワンライナー (生JSON-RPC) | NonInteractive 環境では動作不可 |
| `notes.ps1` | PowerShell | - | テストメモ帳 | - |

### `mcp-client.js` — 非対話型 MCP CLI (準推奨)

> MCP 対応アプリが使えない場合の代替手段。スクリプト・CI からの自動呼び出しに。

```powershell
# 疎通確認
node manual/mcp-client.js ping

# ツール一覧
node manual/mcp-client.js list

# プロファイル状態
node manual/mcp-client.js profiles

# ツール呼び出し (引数なし)
node manual/mcp-client.js call get_sessions

# ツール呼び出し (JSON引数あり)
node manual/mcp-client.js call get_text_coords '{"tabId":1234,"search":"ログイン"}'
node manual/mcp-client.js call capture_screenshot '{"tabId":1234}'
```

---

### `mcp-shell.py` — 対話型 MCP シェル (テスト専用)

```powershell
python manual/mcp-shell.py
```

人間が AI の席に座って MCP プロトコルを直接操作できる対話型シェルです。
- **AT (Auto)**: ツール名 + `key=val` 形式で入力。結果は色付きで整形表示
- **MT (Manual)**: 生の JSON-RPC リクエスト/レスポンスがそのまま見える

シェル内で `mode mt` / `mode at` で切替。`help` でコマンド一覧。

### `mcp.ps1` — MCP MT ワンライナー

```powershell
.\manual\mcp.ps1 -call get_sessions
.\manual\mcp.ps1 -call get_text_coords -json '{"tabId":1666822684}'
.\manual\mcp.ps1 -list
```

呼び出しごとにプロセスを起動→JSON-RPC送信→生レスポンス表示→終了。
AI が受け取るのと**全く同じ JSON-RPC** がそのままターミナルに流れます。

### `notes.ps1` — テストメモ帳

```powershell
.\manual\notes.ps1 note "気づいたこと"
.\manual\notes.ps1 list
.\manual\notes.ps1 set myKey "myValue"
.\manual\notes.ps1 get myKey
```

データは `notes.json` に保存。

---



## 準備

```powershell
# 1. サーバー起動 (別窓で起動しっぱなし)
.\start.ps1

# 2. 起動確認
Invoke-RestMethod http://localhost:7892/health
# → {"ok": true, "wsConnections": 1, ...}

# 3. 文字化け対策 (必ず1回実行)
chcp 65001
```

---

## 基本ワークフロー

```
① スクリーンショットで今の画面を確認
  → capture_screenshot / POST /api/screenshot

② 画面のテキスト/UI要素を取得
  → get_text_coords / get_ui_catalog / GET /api/sessions/:tabId

③ 要素を操作
  → click / type_text / select_option / check_box ...

④ 状態変化を確認
  → capture_screenshot / get_delta / refresh_data
```

---

# HTTP API リファレンス (全22エンドポイント)

サーバーが port 7892 で提供。`Invoke-RestMethod` で直接叩けます。

## システム

### `GET /health` — ヘルスチェック

```powershell
Invoke-RestMethod http://localhost:7892/health
```

### `GET /` or `/dashboard` — ダッシュボードHTML

ブラウザで開く: http://localhost:7892/

### `GET /api/config` — 現在の設定取得

```powershell
Invoke-RestMethod http://localhost:7892/api/config
```

### `POST /api/config` — 設定変更

```powershell
$body = @{
  mode = "always_on"
  plugins = @{
    "react-fiber" = $true
    "css-analyzer" = $false
  }
} | ConvertTo-Json

Invoke-RestMethod http://localhost:7892/api/config `
  -Method POST -ContentType "application/json" -Body $body
```

### `POST /api/plugins/:id/:action` — プラグインON/OFF

```powershell
# 有効化
Invoke-RestMethod "http://localhost:7892/api/plugins/react-fiber/enable" `
  -Method POST

# 無効化
Invoke-RestMethod "http://localhost:7892/api/plugins/css-analyzer/disable" `
  -Method POST
```

## セッション

### `GET /api/sessions` — 全セッション一覧

```powershell
Invoke-RestMethod http://localhost:7892/api/sessions
```

### `GET /api/sessions/:tabId` — 特定セッションの詳細

```powershell
Invoke-RestMethod "http://localhost:7892/api/sessions/1"
```

### `DELETE /api/sessions/:tabId` — セッション削除

```powershell
Invoke-RestMethod "http://localhost:7892/api/sessions/1" -Method DELETE
```

### `POST /api/sessions/:tabId/pin` — セッション固定 (削除防止)

```powershell
Invoke-RestMethod "http://localhost:7892/api/sessions/1/pin" -Method POST
```

### `DELETE /api/sessions/:tabId/pin` — 固定解除

```powershell
Invoke-RestMethod "http://localhost:7892/api/sessions/1/pin" -Method DELETE
```

## データ収集

### `POST /api/collect` — データ収集トリガー

```powershell
$body = @{
  tabId = 1
  plugins = @("text-coords", "ui-catalog", "react-fiber")
} | ConvertTo-Json

Invoke-RestMethod http://localhost:7892/api/collect `
  -Method POST -ContentType "application/json" -Body $body
```

省略すると全プラグイン:

```powershell
Invoke-RestMethod http://localhost:7892/api/collect `
  -Method POST -ContentType "application/json" `
  -Body '{"tabId": 1}'
```

### `POST /api/screenshot` — スクリーンショット

```powershell
$body = @{ tabId = 1; marks = $true } | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/screenshot `
  -Method POST -ContentType "application/json" -Body $body
```

戻り値に `filePath` (画像ファイルのパス) と `image` (base64) が含まれます。
`marks = $true` で要素に番号マーカーが重畳されます。

### `POST /api/embed` — ベクトル埋め込み

```powershell
$body = @{ texts = @("ログインボタン", "検索フォーム") } | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/embed `
  -Method POST -ContentType "application/json" -Body $body
```

## アクション実行

### `POST /api/action` — 汎用アクション

```powershell
# クリック
$body = @{
  tabId = 1
  action = @{ type = "click"; selector = "#submit-btn" }
  timeoutMs = 15000
} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body

# テキスト入力
$body = @{
  tabId = 1
  action = @{ type = "type"; selector = "#search-input"; value = "test" }
} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body

# スクロール
$body = @{
  tabId = 1
  action = @{ type = "scroll"; y = 500 }
} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body

# ページ遷移
$body = @{
  tabId = 1
  action = @{ type = "navigate"; url = "https://example.com" }
} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body
```

### `POST /api/action` — エクスプローラー制御

```powershell
# 探索開始
$body = @{
  tabId = 1
  action = @{ type = "trigger_explorer"; active = $true; strategy = "breadth_first" }
} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body

# 探索停止
$body = @{ tabId = 1; action = @{ type = "trigger_explorer"; active = $false } } | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body
```

### `POST /api/action` — ステート遷移

```powershell
# 特定のステートに遷移
$body = @{
  tabId = 1
  action = @{
    type = "navigate_to_state"
    hash = "abc1234"
    timeoutMs = 30000
  }
} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body

# パスを事前確認 (ドライラン)
$body = @{
  tabId = 1
  action = @{ type = "get_navigation_path"; fromHash = "abc1234"; toHash = "def5678" }
} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body
```

### `POST /api/action` — ツールプロファイル

```powershell
# プロファイル読み込み
$body = @{ tabId = 1; action = @{ type = "load_profile"; profile = "debug" } } | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body

# プロファイル解放
$body = @{ tabId = 1; action = @{ type = "unload_profile"; profile = "debug" } } | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body
```

### `POST /api/action` — 要素スクリーンショット

```powershell
$body = @{
  tabId = 1
  action = @{ type = "capture_element_screenshot"; selector = "#main-content" }
} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action `
  -Method POST -ContentType "application/json" -Body $body
```

## ステートグラフ

### `GET /api/sessions/:tabId/states` — 全ステート一覧

```powershell
Invoke-RestMethod "http://localhost:7892/api/sessions/1/states"
```

### `GET /api/sessions/:tabId/states/:hash` — 特定ステート詳細

```powershell
Invoke-RestMethod "http://localhost:7892/api/sessions/1/states/abc1234"
```

### `GET /api/graphs` — 全グラフ一覧

```powershell
Invoke-RestMethod http://localhost:7892/api/graphs
```

## データファイル (raw)

### `GET /api/sessions/:tabId/:filename` — raw データ取得

```powershell
# UIカタログ
Invoke-RestMethod "http://localhost:7892/api/sessions/1/ui-catalog.json"

# テキスト座標
Invoke-RestMethod "http://localhost:7892/api/sessions/1/text-coords.json"

# React コンポーネントツリー
Invoke-RestMethod "http://localhost:7892/api/sessions/1/react-fiber.json"

# ネットワークログ
Invoke-RestMethod "http://localhost:7892/api/sessions/1/network-hook.json"

# コンソールログ
Invoke-RestMethod "http://localhost:7892/api/sessions/1/console-logger.json"

# DOMスナップショット
Invoke-RestMethod "http://localhost:7892/api/sessions/1/dom-snapshot.json"

# アクセシビリティツリー
Invoke-RestMethod "http://localhost:7892/api/sessions/1/accessibility.json"

# CSS解析
Invoke-RestMethod "http://localhost:7892/api/sessions/1/css-analyzer.json"

# ストレージ
Invoke-RestMethod "http://localhost:7892/api/sessions/1/storage-reader.json"
```

### `GET /api/sessions/:tabId/raw/delta/smart.json` — スマートデルタ

```powershell
Invoke-RestMethod "http://localhost:7892/api/sessions/1/raw/delta/smart.json"
```

### `GET /api/sessions/:tabId/raw/delta/patterns.json` — パターンレジストリ

```powershell
Invoke-RestMethod "http://localhost:7892/api/sessions/1/raw/delta/patterns.json"
```

## ツール・プロファイル情報

### `GET /api/sessions/:tabId/profiles` — プロファイル状態

```powershell
Invoke-RestMethod "http://localhost:7892/api/sessions/1/profiles"
```

### `GET /api/sessions/:tabId/tools` — 可視ツール一覧

```powershell
Invoke-RestMethod "http://localhost:7892/api/sessions/1/tools"
```

---

# MCP ツールリファレンス (全66ツール)

MCP は Model Context Protocol。stdio 経由の JSON-RPC で動作します。

**起動方法:**
```powershell
node server/index.js --mcp
```

**手動呼び出し例:**
```powershell
# 別窓から JSON-RPC を送信
$req = @{
  jsonrpc = "2.0"; id = 1
  method = "tools/call"
  params = @{
    name = "get_sessions"
    arguments = @{}
  }
} | ConvertTo-Json -Compress

# stdin に流し込む
$req | node server/index.js --mcp
```

## READ (22 ツール) — 情報取得

### 基本セッション

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `get_sessions` | (なし) | 全アクティブセッション一覧 |
| `get_index` | `tabId` | セッション内のデータ一覧 + 鮮度 |

### 画面テキスト

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `get_text_coords` | `tabId` | 画面上の全テキスト + 座標。`search` / `match` で絞り込み可 |
| `get_viewport` | `tabId` | ビューポートサイズ + スクロール位置 |

### UI要素

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `get_ui_catalog` | `tabId` | 全操作可能要素 (ボタン・リンク・入力欄) |
| `find_target` | `tabId`, `query` | 説明文 ("検索ボックス", "送信") からクリック候補をランク付きで解決 |
| `get_accessibility` | `tabId` | ARIA アクセシビリティツリー |
| `get_dom_snapshot` | `tabId` | DOM ツリー (role/tag/text で絞り込み可) |

### フレームワーク

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `get_framework_state` | `tabId` | React/Vue/Angular 等のコンポーネントツリーと状態 |

### ネットワーク・コンソール

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `get_network` | `tabId` | HTTP リクエスト/レスポンス一覧 |
| `get_console_logs` | `tabId` | console.log/warn/error の履歴 |

### パフォーマンス・CSS・ストレージ

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `get_perf_metrics` | `tabId` | Web Vitals (LCP, FCP, CLS, etc.) |
| `get_css_analysis` | `tabId` | CSS カスタムプロパティ・計算済みスタイル |
| `get_storage` | `tabId` | localStorage / sessionStorage / cookies |

### ステートグラフ

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `get_state_map` | (なし, 任意: `siteVersion`) | ステート遷移グラフ |
| `list_states` | (なし) | 全ステート一覧 (フィルター可) |
| `search_states` | `query` | ステートを自然言語検索 |
| `get_state_detail` | `hash` | 特定ステートの詳細 |
| `pin_state` | `hash` | ステート固定 + カスタムラベル |

### パターン・デルタ

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `lookup_pattern` | `id` | 既知UIパターンの詳細 |
| `list_patterns` | `tabId` | タブの全既知パターン一覧 |
| `get_delta` | `tabId` | 最新のUI変更差分 (smart delta) |

## WRITE (17 ツール) — 画面操作

### ナビゲーション

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `navigate_to` | `tabId`, `url` | URL遷移 |
| `go_back` | `tabId` | ブラウザ戻る |
| `go_forward` | `tabId` | ブラウザ進む |
| `reload_page` | `tabId` | ページ再読み込み |
| `execute_js` | `tabId`, `code` | 任意JS実行 |

### クリック・マウス

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `click` | `tabId` | クリック (selector/text/座標) |
| `right_click` | `tabId` | 右クリック |
| `hover` | `tabId` | ホバー (マウスオーバー) |
| `drag` | `tabId` | ドラッグ&ドロップ |
| `mouse_scroll` | `tabId` | ホイールスクロール |

### フォーム操作

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `type_text` | `tabId`, `text` | テキスト入力 (1文字ずつ) |
| `type_secret` | `tabId`, `ref` | 登録済み秘密値を ref 名で入力 (値は agent に見えない。secret guard 有効時) |
| `press_key` | `tabId`, `key` | キーボードショートカット |
| `select_option` | `tabId`, `selector` | セレクトボックス選択 |
| `check_box` | `tabId`, `selector` | チェックボックスON/OFF |
| `scroll_page` | `tabId` | ページ/要素スクロール |
| `wait_for_element` | `tabId` | 要素出現まで待機 |

> **`observe` オプション:** `click` / `type_text` / `press_key` / `hover` / `scroll_page` / `mouse_scroll` / `drag` / `select_option` / `check_box` / `right_click` は `observe: true` を受け付ける。操作後に状態ハッシュが安定するまで監視し、レスポンスに `_observation: { available, fromHash, toHash, hashChanged, settled, elapsedMs }` を付与する（UIが変化したかを `refresh_data` 無しで確認できる）。ハッシュ未報告時は `available: false`。

## TABS (4 ツール) — タブ管理

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `list_tabs` | (なし) | 全ブラウザタブ一覧 (whiskor未収集タブも含む)。`get_sessions` を補完 |
| `switch_tab` | `tabId` | タブをアクティブ化 + ウィンドウをforeground化 |
| `open_tab` | (なし) | 新規タブを開く (`url` / `active` 任意)。新 `tabId` を返す |
| `close_tab` | `tabId` | タブを閉じる |

## CAPTURE (5 ツール) — 取得

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `capture_screenshot` | `tabId` | スクリーンショット (全画面) |
| `capture_element_screenshot` | `tabId` | 要素スクリーンショット (切り抜き) |
| `capture_packed_som` | `tabId` | インタラクティブ要素だけを1枚に詰めた番号付き画像 (パックドSoM)。キャッシュ付き |
| `get_element_thumbnail` | `tabId`, `selector` | 単一要素の低解像度サムネイル (`maxPx` 既定96) |
| `refresh_data` | `tabId` | データ収集をリフレッシュ |

## CONTROL (10 ツール) — 制御

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `set_config` | (なし) | 設定変更 |
| `get_config_changes` | (なし) | 設定変更履歴 |
| `trigger_collect` | (なし) | データ収集トリガー |
| `trigger_explorer` | `tabId`, `active` | 自動探索開始/停止 |
| `navigate_to_state` | `tabId`, `hash` | ステート遷移実行 |
| `get_navigation_path` | `toHash` | ステート遷移パス事前確認 |
| `load_profile` | `profile` | ツールプロファイル読み込み |
| `unload_profile` | `profile` | ツールプロファイル解放 |
| `search_tools` | (なし) | ツール検索 |
| `profile_status` | (なし) | プロファイル状態確認 |

## INTELLIGENCE (6 ツール) — 解析

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `analyze_click` | `tabId` | クリック可能性の事前分析 (ドライラン) |
| `explain_element` | `tabId`, `selector` | 要素の総合説明 (CSS由来・フレームワーク・変更原因) |
| `why_did_this_change` | `tabId`, `selector` | 要素変更の因果連鎖 |
| `get_source_file` | `tabId`, `url` | CSS/JS ソースファイル取得 |
| `detect_site_updates` | (なし) | 前回訪問からの更新検出 |
| `get_state_map_visual` | (なし) | ASCII ステートグラフ |

## SOURCE (1 ツール) — アップロード済ソース

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `get_source_context` | (いずれか) | アップロード済ソースのスライス取得。`component`(観測コンポーネント名) / `file`+`line` / `symbol` で引ける |

## REPLAY (1 ツール) — リプレイ

| ツール | 必須パラメータ | 説明 |
|--------|---------------|------|
| `replay_session` | `tabId`, `sourceSessionDir` | 過去のアクションをリプレイ実行 |

---

## 代表的なテストシナリオ

### シナリオ1: ページ偵察 → 操作 → 確認

```powershell
# ① スクリーンショット
$ss = Invoke-RestMethod http://localhost:7892/api/screenshot `
  -Method POST -ContentType "application/json" -Body '{"tabId":1,"marks":true}'
$ss | ConvertTo-Json

# ② UI要素一覧
$ui = Invoke-RestMethod "http://localhost:7892/api/sessions/1/ui-catalog.json"
$ui | ConvertTo-Json -Depth 5

# ③ テキスト座標
$txt = Invoke-RestMethod "http://localhost:7892/api/sessions/1/text-coords.json"
$txt | ConvertTo-Json -Depth 5

# ④ ボタンをクリック
$click = @{tabId=1; action=@{type="click"; selector=".btn-primary"}} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action`
  -Method POST -ContentType "application/json" -Body $click

# ⑤ データ更新
Invoke-RestMethod http://localhost:7892/api/collect `
  -Method POST -ContentType "application/json" -Body '{"tabId":1}'

# ⑥ 変化を確認
$ss2 = Invoke-RestMethod http://localhost:7892/api/screenshot `
  -Method POST -ContentType "application/json" -Body '{"tabId":1}'
$ss2 | ConvertTo-Json
```

### シナリオ2: フォーム入力テスト

```powershell
# ① 入力欄にテキスト
$body = @{tabId=1; action=@{type="type"; selector="#email"; value="test@example.com"}} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action`
  -Method POST -ContentType "application/json" -Body $body

# ② パスワード欄
$body = @{tabId=1; action=@{type="type"; selector="#password"; value="password123"}} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action`
  -Method POST -ContentType "application/json" -Body $body

# ③ 送信
$body = @{tabId=1; action=@{type="click"; selector="#login-btn"}} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action`
  -Method POST -ContentType "application/json" -Body $body
```

### シナリオ3: 画面変化の因果関係調査

```powershell
# ① 要素が変わった理由を調査
$body = @{
  tabId = 1
  action = @{ type = "why_did_this_change"; selector = ".error-message" }
} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action`
  -Method POST -ContentType "application/json" -Body $body

# ② CSSの由来を調査
$body = @{
  tabId = 1
  action = @{ type = "explain_element"; selector = ".btn-primary"; properties = @("color", "background") }
} | ConvertTo-Json
Invoke-RestMethod http://localhost:7892/api/action`
  -Method POST -ContentType "application/json" -Body $body
```

---

## Tips

- `ConvertTo-Json` の深さが足りないときは `-Depth 5` を付ける
- `tabId` は `get_sessions` または `GET /api/sessions` で確認
- スクリーンショットの `marks: true` は設定で `screenshotMarks: true` が必要
- `execute_js` を使うには `config.json` で `security.allowExecuteJs: true` が必要
- `mcp-shell.py` (対話型MCPシェル) を使うと、MCP プロトコルを直接触りながらテストできます
