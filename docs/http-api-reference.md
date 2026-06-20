# browser-whiskor HTTP API リファレンス

ベースURL: `http://127.0.0.1:7892`

> MCPを使わずにHTTP経由でサーバーを直接操作できます。
> MCP経由での操作と機能的に等価ですが、`POST /api/action` のみアクションタイプの指定方法が異なります。

---

## 目次

1. [サーバー管理](#サーバー管理)
2. [設定](#設定)
3. [プラグイン](#プラグイン)
4. [セッション](#セッション)
5. [状態グラフ](#状態グラフ)
6. [デルタ・パターン](#デルタパターン)
7. [アクション実行](#アクション実行)
8. [スクリーンショット](#スクリーンショット)
9. [パックドSoM・要素サムネイル](#パックドsom要素サムネイル)
10. [ソースアップロード](#ソースアップロード)
11. [埋め込み・エクスポート](#埋め込みエクスポート)
12. [ツール管理](#ツール管理)
13. [ファイルアクセス](#ファイルアクセス)
14. [ダッシュボード](#ダッシュボード)

---

## サーバー管理

### `GET /health`

サーバーの死活確認。

**レスポンス**
```json
{
  "ok": true,
  "wsConnections": 1,
  "sessions": 3,
  "pendingActions": 0
}
```

| フィールド | 説明 |
|---|---|
| `wsConnections` | 接続中の拡張機能の数 |
| `sessions` | アクティブなタブセッション数 |
| `pendingActions` | 実行待ちアクション数 |

---

## 設定

### `GET /api/config`

現在の `config.json` の全設定値を返す。

**レスポンス**: `config.json` の内容がそのまま返る。

---

### `POST /api/config`

設定を動的に変更する。変更は即座に拡張機能へ push される。

> `agentControl.allowAgentConfig` が `false`（デフォルト）の場合、この操作は拒否されます。

**リクエストボディ** (変更したいキーのみ指定)
```json
{
  "react": { "maxDepth": 40 },
  "textCoords": { "level": "blocks" }
}
```

**レスポンス**
```json
{
  "ok": true,
  "config": { /* 変更後の全設定 */ }
}
```

**エージェントが変更可能なパス** (`agentWritablePaths`)
```
updateFrequencies[].valueMs
updateFrequencies[].enabled
textCoords.level / includeHidden / includeOffscreen / maxWords
react.debounceMs / maxDepth / maxProps / maxHooks
collection.maxConsoleLogs / maxNetworkRequests / networkBodyMaxBytes
```

セキュリティ・サーバー設定・権限設定は読み取り専用です (`agentReadOnlyPaths`)。

---

## プラグイン

### `POST /api/plugins/:id/enable`
### `POST /api/plugins/:id/disable`

個別プラグインの有効/無効を切り替える。変更は即座に拡張機能へ push される。

**パスパラメータ**

| パラメータ | 説明 |
|---|---|
| `:id` | プラグインID（例: `react-fiber`, `accessibility`, `css-origin`） |

**利用可能なプラグインID**

`react-fiber` / `vue3` / `vue2` / `angular` / `svelte` / `preact` / `alpine` / `solid` / `dom-generic` / `text-coords` / `network-hook` / `css-analyzer` / `ui-catalog` / `perf-analyzer` / `dom-mutations` / `accessibility` / `console-logger` / `storage-reader` / `css-origin` / `source-fetcher` / `framework-dom-map`

**レスポンス**
```json
{
  "ok": true,
  "pluginId": "accessibility",
  "enabled": false
}
```

---

## セッション

### `GET /api/sessions`

接続中の全タブセッション一覧。

**レスポンス** (配列)
```json
[
  {
    "tabId": 1234,
    "url": "https://example.com/app",
    "title": "My App",
    "siteVersion": "abc123",
    "sessionId": "sess_xyz",
    "dataFreshness": { "textCoords": 1200, "network": 800 },
    "isStale": false
  }
]
```

---

### `GET /api/sessions/:tabId`

特定タブの詳細データ（`_index.json` の内容）。

**パスパラメータ**

| パラメータ | 説明 |
|---|---|
| `:tabId` | タブID（`get_sessions` で取得） |

**レスポンス**: セッションの `_index.json` の内容（収集済みデータの概要、フレッシュネス情報など）。

**エラー** `404`: セッションが存在しない場合。

---

### `POST /api/sessions/:tabId/pin`

セッションを保持フラグ付きにする（サーバー再起動やLRU退避から保護）。

**レスポンス**
```json
{ "ok": true, "tabId": 1234, "keep": true }
```

---

### `DELETE /api/sessions/:tabId/pin`

保持フラグを解除する。

**レスポンス**
```json
{ "ok": true, "tabId": 1234, "keep": false }
```

---

### `DELETE /api/sessions/:tabId`

セッションをキャッシュから完全に削除する。

**レスポンス**
```json
{ "ok": true, "tabId": 1234 }
```

---

## 状態グラフ

### `GET /api/graphs`

記録済みの全状態グラフ一覧（siteVersion単位）。

**レスポンス**: 状態グラフのメタデータ配列。

---

### `GET /api/sessions/:tabId/states`

特定タブの状態グラフに記録された全ノード一覧。

**レスポンス** (配列、最大999件)
```json
[
  {
    "hash": "a1f3c8e2",
    "label": "Cart page (2 items, $49.99 total)",
    "tags": ["authenticated", "cart-open"],
    "url": "https://example.com/cart",
    "visitCount": 3,
    "keyState": { "cart.items.length": 2, "cart.total": 49.99 },
    "capturedAt": 1716000000000
  }
]
```

---

### `GET /api/sessions/:tabId/states/:hash`

特定の状態ノードの詳細情報。

**パスパラメータ**

| パラメータ | 説明 |
|---|---|
| `:hash` | 状態のcompositeHash（例: `a1f3c8e2`） |

**レスポンス**: ノードの全メタデータ（エッジ情報・アクション記録含む）。

**エラー** `404`: 指定ハッシュの状態が存在しない場合。

---

## デルタ・パターン

### `GET /api/sessions/:tabId/raw/delta/smart.json`

直近のUI変化をスマートデルタ形式で取得（インメモリ、キャッシュファイルなし）。

**レスポンス**
```json
{
  "elapsed_ms": 1500,
  "frame_count": 5,
  "scroll": { "vector": { "x": 0, "y": -500 }, "affected_elements": 15 },
  "motion_groups": [
    { "ref": "pat-a1b2c3d4", "vector": { "x": 0, "y": -500 }, "count": 8 }
  ],
  "appearances": [
    { "ref": "pat-e5f6g7h8", "id": "toast-1", "text": "Saved!" }
  ],
  "_patterns": {
    "new": [{ "ref": "pat-e5f6g7h8", "def": { "type": "appearance" } }],
    "known": [{ "ref": "pat-a1b2c3d4" }]
  }
}
```

データが存在しない場合は `{ "elapsed_ms": 0, "frame_count": 0, "motion_groups": [] }` が返る。

---

### `GET /api/sessions/:tabId/raw/delta/patterns.json`

タブで観測された全UIパターンの一覧。

**レスポンス**
```json
{
  "patterns": [
    {
      "ref": "pat-a1b2c3d4",
      "type": "motion",
      "def": { /* パターン定義 */ },
      "seenCount": 12
    }
  ]
}
```

---

## アクション実行

### `POST /api/collect` (エイリアス: `POST /api/gather`)

拡張機能にデータ収集を手動でトリガーする。

**リクエストボディ**
```json
{
  "tabId": 1234,
  "plugins": ["text-coords", "network-hook"]
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| `tabId` | 任意 | 省略時は全タブを対象 |
| `plugins` | 任意 | 収集するプラグインを絞る。省略時は全プラグイン |

**レスポンス**
```json
{ "ok": true, "collected": true }
```

---

### `POST /api/action`

ブラウザ操作・ナビゲーション・探索などを実行する。

**共通フィールド**
```json
{
  "tabId": 1234,
  "action": { "type": "<アクションタイプ>", ...オプション },
  "timeoutMs": 15000
}
```

---

#### ブラウザ操作アクション

| `type` | 必須フィールド | 任意フィールド | 説明 |
|---|---|---|---|
| `navigate` | `url` | — | URLへ遷移 |
| `click` | — | `selector`, `text`, `x`, `y`, `double`, `button` | クリック |
| `right_click` | — | `selector`, `text`, `x`, `y` | 右クリック |
| `type` | `text` | `selector`, `clear`, `pressEnter` | テキスト入力 |
| `press_key` | `key` | — | キー入力（例: `"Enter"`, `"Escape"`, `"Tab"`） |
| `hover` | — | `selector`, `text` | ホバー |
| `scroll` | — | `selector`, `x`, `y`, `deltaX`, `deltaY` | スクロール |
| `mouse_scroll` | `x`, `y` | `deltaX`, `deltaY` | 座標指定ホイールイベント |
| `drag` | `fromX`, `fromY`, `toX`, `toY` | `selector` | ドラッグ |
| `select_option` | `selector`, `value` | `label` | `<select>` 値変更 |
| `check` | `selector` | `checked` | チェックボックス操作 |
| `execute_js` | `code` | `captureConsole` | 任意JS実行（`allowExecuteJs: true` 必須） |
| `wait_for_element` | `selector` | `timeoutMs`, `visible` | 要素出現待機 |
| `go_back` | — | — | ブラウザ履歴を戻る |
| `go_forward` | — | — | ブラウザ履歴を進む |
| `reload` | — | `hard` | ページリロード |

**クリック例**
```json
{
  "tabId": 1234,
  "action": {
    "type": "click",
    "text": "Sign In"
  }
}
```

**テキスト入力例**
```json
{
  "tabId": 1234,
  "action": {
    "type": "type",
    "selector": "input[type=email]",
    "text": "user@example.com",
    "clear": true,
    "pressEnter": false
  }
}
```

---

#### 状態ナビゲーションアクション

##### `navigate_to_state`

記録済みアクションをBFSで再実行して指定状態へ遷移する。

```json
{
  "tabId": 1234,
  "action": {
    "type": "navigate_to_state",
    "hash": "a1f3c8e2",
    "timeoutMs": 30000
  }
}
```

**レスポンス**
```json
{
  "ok": true,
  "hash": "a1f3c8e2",
  "steps": 3,
  "divergences": []
}
```

---

##### `get_navigation_path`

パスが存在するか確認するドライラン（実際には遷移しない）。

```json
{
  "tabId": 1234,
  "action": {
    "type": "get_navigation_path",
    "fromHash": "b2c4d6e8",
    "toHash": "a1f3c8e2"
  }
}
```

**レスポンス**: パスのステップ一覧と推定ステップ数。

---

#### 探索アクション

##### `trigger_explorer`

自律探索エンジンを開始/停止する。

```json
{
  "tabId": 1234,
  "action": {
    "type": "trigger_explorer",
    "active": true,
    "strategy": "bfs"
  }
}
```

| `strategy` | 説明 |
|---|---|
| `"bfs"` | 幅優先（デフォルト） |
| `"dfs"` | 深さ優先 |
| `"random"` | ランダム |

**レスポンス**
```json
{ "ok": true, "explorer": "activated" }
```

---

#### ツールプロファイルアクション

##### `load_profile`

MCPツールプロファイルをロードする。

```json
{
  "tabId": 1234,
  "action": {
    "type": "load_profile",
    "profile": "debug"
  }
}
```

利用可能なプロファイル: `core` / `debug` / `state-nav` / `delta` / `advanced-actions` / `admin` / `power`

---

##### `unload_profile`

プロファイルをアンロードする。

```json
{
  "tabId": 1234,
  "action": { "type": "unload_profile", "profile": "debug" }
}
```

---

## スクリーンショット

### `POST /api/screenshot`

スクリーンショットを撮影する。オプションでSet-of-Marks（番号付きマーカー）を重畳できる。

**リクエストボディ**
```json
{
  "tabId": 1234,
  "marks": false
}
```

| フィールド | デフォルト | 説明 |
|---|---|---|
| `tabId` | — | 対象タブ |
| `marks` | `false` | `true` にするとインタラクティブ要素に番号マーカーを重畳 |

**レスポンス** (marks: false)
```json
{
  "ok": true,
  "dataUrl": "data:image/png;base64,..."
}
```

**レスポンス** (marks: true)
```json
{
  "ok": true,
  "dataUrl": "data:image/png;base64,...",
  "elements": {
    "1": { "tag": "button", "text": "Sign In", "center": { "x": 450, "y": 320 }, "selector": "#login-btn" },
    "2": { "tag": "input",  "text": "Enter email...", "center": { "x": 450, "y": 260 }, "selector": "input[type=email]" }
  }
}
```

---

#### `capture_element_screenshot`（`POST /api/action` 経由）

要素単位のスクリーンショット。

```json
{
  "tabId": 1234,
  "action": {
    "type": "capture_element_screenshot",
    "selector": ".product-card:first-child",
    "padding": 8,
    "format": "png",
    "quality": 90
  }
}
```

| フィールド | 説明 |
|---|---|
| `selector` | CSS セレクタ |
| `padding` | 余白px（省略可） |
| `format` | `"png"` or `"jpeg"` |
| `quality` | JPEG品質 1〜100 |

---

## パックドSoM・要素サムネイル

### `POST /api/packed-som`

インタラクティブ要素だけを実スクリーンショットから切り出し、1枚に詰めて番号を振った Set-of-Marks 画像を返す。フルスクショよりピクセル・トークンが大幅に少ない。ページ変化シグナル（遷移・DOM変異）で無効化されるワーカー側キャッシュ付き（ヒット時 `_cached: true`）。

**リクエストボディ**
```json
{ "tabId": 1234 }
```

**レスポンス**
```json
{
  "dataUrl": "data:image/png;base64,...",
  "marks": [
    { "n": 1, "text": "Sign In", "selector": "#login-btn", "rect": { "x": 442, "y": 313, "w": 96, "h": 28 } }
  ],
  "width": 800,
  "height": 120,
  "_cached": false
}
```

`marks` はクリック統計（時間減衰スコア）により可能性順に並ぶ。画像上の番号 `n` は不変。`rect` はページ上の実座標なので、`n` 番をクリックするには `rect` 中心へ `click(x, y)` する。

### `POST /api/element-thumbnail`

単一要素の低解像度サムネイルを取得する。切り出しと縮小は拡張側 canvas で1回の drawImage で行われる。view-aware キャッシュ付き。

**リクエストボディ**
```json
{ "tabId": 1234, "selector": "#login-btn", "maxPx": 96 }
```

| フィールド | デフォルト | 説明 |
|---|---|---|
| `selector` | — | CSS セレクタ |
| `maxPx` | `96` | 長辺の上限ピクセル |

---

## OCR（ピクセルからのテキスト読取）

### `POST /api/ocr`

DOM ベースの `get_text_coords` が拾えないテキスト — canvas/WebGL アプリ（Unity 等は DOM が `<canvas>` 1枚でテキストノードが無い）や、テキストノードを持たないアイコンのみのボタン — を、native OCR エンジンでピクセルから読む。`selector`/`rect` を省略するとタブ全体、指定するとその領域をクロップして OCR にかける。出力は `get_text_coords` と同じ Tesseract 互換の word 配列（`level/page_num/block_num/.../left/top/width/height/conf` ＋ `x/y/w/h` エイリアス）。

OCR エンジンは**同梱しない（bring-your-own）**。解決順は `intelligence.ocr.binPath`（明示パス）→ 環境変数 `WHISKOR_OCR_PATH` → PATH 上の `tesseract`。見つからなければ `{ ok:false, error:"ocr_unavailable" }` と導入手順を返すだけで、サーバーは落ちない。

**リクエストボディ**
```json
{ "tabId": 1234, "selector": "#score-canvas", "lang": "eng+jpn", "psm": 6 }
```

| フィールド | デフォルト | 説明 |
|---|---|---|
| `tabId` | （必須） | 対象タブ |
| `selector` | — | CSS セレクタ（その要素をクロップして OCR。`rect` より優先） |
| `rect` | — | `{x,y,w,h}`（CSS px）。`selector`・`rect` 両方省略でタブ全体 |
| `lang` | `intelligence.ocr.lang`（既定 `eng`） | Tesseract 言語コード。`+` 連結で `eng+jpn`。**エンジンに言語データのインストールが必要** |
| `psm` | `intelligence.ocr.psm`（既定 `3`） | ページ分割モード。小領域では 6/7/8/11 が有効なことが多い |
| `padding` | `4` | selector/rect クロップの周囲余白（px） |

**レスポンス（例）**
```json
{ "ok": true, "text": "SCORE 1200\nGAME OVER", "wordCount": 3, "lang": "eng", "engine": "5.5.0",
  "words": [{ "level":5, "text":"SCORE", "left":12, "top":8, "width":60, "height":18, "x":12, "y":8, "w":60, "h":18, "confidence":94 }] }
```

### `GET /api/ocr`

OCR エンジンの可用性を返す（`tabId` 不要）。`{ available:true, binPath, version, lang }`、または未導入なら `{ available:false, reason:"no_engine", hint:"..." }`（`reason:"disabled"` は `intelligence.ocr.enabled:false`）。

---

## ソースアップロード

### `POST /api/source/upload`

対象サイトのプロジェクトソースをアップロードし、実行時観測との相関に使う。`files`（パス＋内容の配列）または `zipBase64`（base64 エンコードした zip、依存ゼロの内蔵リーダーで展開）を受け付ける。node_modules・バイナリは除外され、サイズ上限がある。

**リクエストボディ（どちらか。併用時は files が優先）**
```json
{ "projectId": "my-app", "files": { "src/App.tsx": "...file content..." } }
```
```json
{ "projectId": "my-app", "zipBase64": "UEsDBBQA..." }
```

`projectId` 省略時は `"default"`。

### `POST /api/source/context`

アップロード済みソースから必要分だけのスライスを取得する。行範囲・シンボル名・観測したコンポーネント名のいずれでも引ける（コンポーネント名は dev ビルドの React `_debugSource` があれば exact、なければ名前一致＋confidence）。

**リクエストボディ（例）**
```json
{ "projectId": "my-app", "component": "LoginForm" }
```
```json
{ "projectId": "my-app", "file": "src/App.tsx", "line": 42 }
```

---

## 埋め込み・エクスポート

### `POST /api/embed`

テキストをベクトル埋め込みにする（ローカル MiniLM ONNX）。

```json
{ "texts": ["sign in", "ログイン"] }
```

**レスポンス**: `{ "vectors": [[...], [...]] }`

### `GET /export`

セッションキャッシュ全体を ZIP でダウンロードする（依存ゼロの内蔵 zip-writer）。`?tabId=1234` で単一セッションに限定。

---

## ツール管理

### `GET /api/sessions/:tabId/profiles`

現在ロードされているMCPツールプロファイルの状態を返す。

**レスポンス**
```json
{
  "activeProfiles": ["core", "debug"],
  "idleTurns": { "debug": 3 }
}
```

MCPセッション外からアクセスした場合は `hint` メッセージのみ返る。

---

### `GET /api/sessions/:tabId/tools`

現在表示されているMCPツールの一覧（プロファイルによるフィルタ適用後）。

**レスポンス**
```json
{
  "tools": [
    { "name": "get_sessions", "profile": "core" },
    { "name": "get_console_logs", "profile": "debug" }
  ],
  "total": 55,
  "visible": 18
}
```

---

## ファイルアクセス

### `GET /api/sessions/:tabId/:filepath`

セッションキャッシュ内の任意のJSONファイルを直接取得する。

パストラバーサル（`../`）は自動的に除去されます。

**主なファイルパス**

| パス | 内容 |
|---|---|
| `raw/visual/text-coords.json` | テキスト座標 |
| `raw/visual/viewport.json` | ビューポート情報 |
| `raw/network/requests.json` | ネットワークリクエスト |
| `raw/ui/elements.json` | UIカタログ（ボタン・リンク・フォーム） |
| `raw/accessibility/tree.json` | アクセシビリティツリー |
| `raw/storage/data.json` | localStorage / sessionStorage / Cookie |
| `raw/console/logs.json` | コンソールログ |
| `raw/perf/metrics.json` | Web Vitals |
| `raw/css/analysis.json` | CSS解析 |
| `raw/dom/snapshot.json` | DOMスナップショット |
| `raw/react_snapshot.json` | Reactコンポーネントツリー |
| `raw/intelligence/css-origin-map.json` | CSS起源マップ |
| `raw/intelligence/framework-dom-map.json` | フレームワーク-DOMマッピング |
| `raw/intelligence/causal-chains.json` | 因果チェーン |
| `raw/replay/actions.jsonl` | セッションリプレイ記録 |

**例**
```
GET http://127.0.0.1:7892/api/sessions/1234/raw/network/requests.json
```

---

## ダッシュボード

### `GET /` または `GET /dashboard`

ブラウザで開くと視覚的なダッシュボードUIが表示される。セッション一覧・リアルタイムデータ・状態グラフの確認が可能。

---

## エラーレスポンス

全エンドポイント共通のエラー形式:

```json
{ "error": "Session not found", "path": "/api/sessions/9999" }
```

| ステータス | 状況 |
|---|---|
| `404` | セッション・ファイル・状態が存在しない |
| `500` | サーバー内部エラー（`error` フィールドにメッセージ） |

---

## Windows (PowerShell) での注意

`curl` は PowerShell では `Invoke-WebRequest` のエイリアスです。JSONを送る場合は `Invoke-RestMethod` を推奨します。

```powershell
# ✓ 推奨
Invoke-RestMethod -Uri http://127.0.0.1:7892/api/action `
  -Method Post `
  -ContentType application/json `
  -Body '{"tabId":1234,"action":{"type":"navigate","url":"https://example.com"}}'

# ✓ bash / curl
curl -s http://127.0.0.1:7892/health
curl -s -X POST http://127.0.0.1:7892/api/collect \
  -H "Content-Type: application/json" \
  -d '{"tabId":1234}'
```
