---
name: browser-whiskor
description: >
  Use this skill whenever Claude (browser AI / Claude in Chrome) needs to perceive
  or control a browser tab using the browser-whiskor extension WITHOUT MCP.
  Triggers: any request to "look at the page", "click X", "fill in the form",
  "take a screenshot", "read the DOM", "check the network", "navigate to",
  "find elements on screen", or any browser automation task where the user has
  browser-whiskor installed and running locally.
  Do NOT use this skill for MCP-based workflows; it covers the pure HTTP API path only.
compatibility: "Claude in Chrome, Claude Desktop (with browser access), any surface where fetch() to localhost is permitted"
version: "3.2.0"
---

# browser-whiskor — HTTP API Skill (MCP不使用・ネイティブ操作)

## 概要

browser-whiskorはChrome/Firefox拡張機能 + Node.jsサーバーで構成される、AI向けブラウザ認知・操作ツールです。
このSkillはMCPを一切使わず、**HTTP REST API（`http://127.0.0.1:7892`）だけ**でClaudeがブラウザを操作する方法を定義します。HTTP-API-SKILL(haha).md

```
AI (Claude in Chrome)
        │  fetch() / XMLHttpRequest
        ▼
http://127.0.0.1:7892   ← browser-whiskor サーバー``
        │  WebSocket :7891
        ▼
ブラウザ拡張機能（Chrome MV3 / Firefox MV2）
        │
        ▼
実際のブラウザタブ（認知・操作）
```

---

## 前提条件チェック（必ず最初に実行）

タスク開始前に必ずヘルスチェックを行う：

```javascript
const res = await fetch("http://127.0.0.1:7892/health");
const health = await res.json();
// health.ok === true かつ health.wsConnections >= 1 を確認
```

| フィールド | 意味 |
|---|---|
| `ok: true` | サーバー起動済み |
| `wsConnections >= 1` | 拡張機能がブラウザに接続済み |
| `sessions >= 1` | 操作対象のタブが存在する |

**失敗した場合の対処：**
- `fetch` が失敗 → `node server/index.js` でサーバーを起動してもらう
- `wsConnections === 0` → ブラウザに拡張機能をインストールし、対象ページを開いてもらう

---

## Step 1: タブ（セッション）の特定

```javascript
const res = await fetch("http://127.0.0.1:7892/api/sessions");
const sessions = await res.json();
// sessions[0].tabId を以降の操作で使用
```

レスポンス例：
```json
[
  {
    "tabId": 1234,
    "url": "https://example.com/app",
    "title": "My App",
    "isStale": false
  }
]
```

複数タブある場合はURLやtitleでユーザーに確認するか、最初のタブを使用。
**以降の全操作で `tabId` が必要**。

---

## Step 2: ページの知覚（Perception）

### 2-A. スクリーンショット（最も汎用的）

```javascript
// 通常スクリーンショット
const res = await fetch("http://127.0.0.1:7892/api/screenshot", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tabId: 1234 })
});
const { dataUrl } = await res.json();
// dataUrl は "data:image/png;base64,..." 形式

// Set-of-Marks付き（番号マーカーで操作対象を特定）
const res2 = await fetch("http://127.0.0.1:7892/api/screenshot", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tabId: 1234, marks: true })
});
const { dataUrl: markedUrl, elements } = await res2.json();
// elements["1"] = { tag, text, center: {x, y}, selector }
```

**SoMマーカーの推奨用途：** クリック対象が曖昧なとき。`elements["3"].selector` でCSSセレクタが取れる。

### 2-B. テキスト座標（テキスト検索・クリック位置特定）

```javascript
const res = await fetch("http://127.0.0.1:7892/api/sessions/1234/raw/visual/text-coords.json");
const textData = await res.json();
// textData.words[] / textData.blocks[] にテキストとピクセル座標
```

### 2-C. UIカタログ（ボタン・リンク・フォームの一覧）

```javascript
const res = await fetch("http://127.0.0.1:7892/api/sessions/1234/raw/ui/elements.json");
const { buttons, links, inputs } = await res.json();
```

### 2-D. アクセシビリティツリー（構造的把握）

```javascript
const res = await fetch("http://127.0.0.1:7892/api/sessions/1234/raw/accessibility/tree.json");
const tree = await res.json();
```

### 2-E. ネットワーク・コンソール・ストレージ

```javascript
// ネットワークリクエスト
fetch("http://127.0.0.1:7892/api/sessions/1234/raw/network/requests.json")
// コンソールログ
fetch("http://127.0.0.1:7892/api/sessions/1234/raw/console/logs.json")
// localStorage / sessionStorage / Cookie
fetch("http://127.0.0.1:7892/api/sessions/1234/raw/storage/data.json")
// DOMスナップショット（構造）
fetch("http://127.0.0.1:7892/api/sessions/1234/raw/dom/snapshot.json")
// Reactコンポーネントツリー（Reactサイト）
fetch("http://127.0.0.1:7892/api/sessions/1234/raw/react_snapshot.json")
```

### 2-F. データ鮮度の確認と更新

データが古い場合（`isStale: true` or 30秒以上）は手動収集をトリガー：

```javascript
await fetch("http://127.0.0.1:7892/api/collect", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tabId: 1234 })
});
// その後再取得する
```

---

## Step 3: ページの操作（Action）

全アクションは `POST /api/action` に統一されている。

### 共通フォーマット

```javascript
const result = await fetch("http://127.0.0.1:7892/api/action", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tabId: 1234,
    action: { type: "<アクションタイプ>", /* ... */ },
    timeoutMs: 15000  // 省略可（デフォルト15秒）
  })
});
const { ok } = await result.json();
```

### クリック

```javascript
// テキストで指定（最も安全）
{ type: "click", text: "Sign In" }

// CSSセレクタで指定
{ type: "click", selector: "#login-btn" }

// 座標で指定（SoMマーカーのcenterを使う）
{ type: "click", x: 450, y: 320 }

// ダブルクリック
{ type: "click", selector: ".item", double: true }

// 右クリック
{ type: "right_click", selector: ".context-menu-trigger" }
```

### テキスト入力

```javascript
// フォームに入力（clearで既存テキストを消去）
{ type: "type", selector: "input[type=email]", text: "user@example.com", clear: true }

// 入力後Enterを送信
{ type: "type", selector: "input[name=search]", text: "検索ワード", pressEnter: true }
```

### キー入力・ホバー・スクロール

```javascript
{ type: "press_key", key: "Escape" }
{ type: "press_key", key: "Tab" }
{ type: "press_key", key: "Enter" }

{ type: "hover", selector: ".dropdown-trigger" }

// ページスクロール（deltaY: 正=下, 負=上）
{ type: "scroll", deltaY: 500 }

// 特定要素をスクロール
{ type: "scroll", selector: ".scroll-container", deltaY: 300 }

// 座標指定ホイール
{ type: "mouse_scroll", x: 400, y: 300, deltaY: 200 }
```

### ナビゲーション

```javascript
{ type: "navigate", url: "https://example.com/login" }
{ type: "go_back" }
{ type: "go_forward" }
{ type: "reload" }
{ type: "reload", hard: true }  // キャッシュクリア
```

### フォーム操作

```javascript
// セレクトボックス
{ type: "select_option", selector: "select#country", value: "JP" }
// ラベルで選択する場合
{ type: "select_option", selector: "select#lang", value: "ja", label: "日本語" }

// チェックボックス
{ type: "check", selector: "input#agree", checked: true }
```

### ドラッグ

```javascript
{ type: "drag", fromX: 100, fromY: 200, toX: 400, toY: 200 }
```

### 要素待機（アクション前の安全確認）

```javascript
{ type: "wait_for_element", selector: ".modal-dialog", timeoutMs: 5000, visible: true }
```

### 任意JavaScript実行（要設定有効化）

```javascript
// config.json の security.allowExecuteJs が true のときのみ動作
{
  type: "execute_js",
  code: "return document.title",
  captureConsole: true
}
```

> ⚠️ デフォルトは `allowExecuteJs: false`。ユーザーに有効化を確認してから使うこと。

---

## 標準ワークフロー

### 基本的な知覚→操作サイクル

```
1. GET /health                           → サーバー・拡張機能の確認
2. GET /api/sessions                     → tabId を取得
3. POST /api/screenshot { marks: true }  → 現在の画面とインタラクティブ要素を把握
4. POST /api/action { type: "click", ... } → 操作
5. POST /api/collect { tabId }           → データ更新
6. POST /api/screenshot { marks: true }  → 結果確認
7. 3〜6を繰り返す
```

### フォーム入力ワークフロー

```javascript
const BASE = "http://127.0.0.1:7892";
const tabId = 1234;
const post = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(r => r.json());

// 1. メールアドレス入力
await post("/api/action", { tabId, action: { type: "type", selector: "input[type=email]", text: "user@example.com", clear: true } });
// 2. パスワード入力
await post("/api/action", { tabId, action: { type: "type", selector: "input[type=password]", text: "password123", clear: true } });
// 3. ログインボタンクリック
await post("/api/action", { tabId, action: { type: "click", text: "ログイン" } });
// 4. 結果確認（モーダルやリダイレクト待ち）
await post("/api/action", { tabId, action: { type: "wait_for_element", selector: ".dashboard", timeoutMs: 5000 } });
// 5. スクリーンショットで確認
const screenshot = await post("/api/screenshot", { tabId });
```

### デバッグ・調査ワークフロー

```javascript
// ネットワークエラーの調査
const network = await fetch(`${BASE}/api/sessions/${tabId}/raw/network/requests.json`).then(r => r.json());
const errors = network.requests?.filter(r => r.status >= 400);

// コンソールエラーの確認
const logs = await fetch(`${BASE}/api/sessions/${tabId}/raw/console/logs.json`).then(r => r.json());
const consoleErrors = logs.logs?.filter(l => l.level === "error");

// React状態の確認
const reactState = await fetch(`${BASE}/api/sessions/${tabId}/raw/react_snapshot.json`).then(r => r.json());
```

---

## 状態グラフの活用

browser-whiskorはページの遷移を記録する「状態グラフ」を持つ。記録済みの状態への再現ナビゲーションが可能。

```javascript
// 記録済み状態の一覧
const states = await fetch(`${BASE}/api/sessions/${tabId}/states`).then(r => r.json());
// states[].hash, states[].label, states[].url が含まれる

// 特定状態へナビゲート（記録されたアクションを自動再生）
await post("/api/action", {
  tabId,
  action: { type: "navigate_to_state", hash: "a1f3c8e2", timeoutMs: 30000 }
});

// パスの確認（ドライラン）
await post("/api/action", {
  tabId,
  action: { type: "get_navigation_path", fromHash: "b2c4d6e8", toHash: "a1f3c8e2" }
});
```

---

## プラグインの管理

必要なデータ種別に応じてプラグインを有効/無効化できる：

```javascript
// アクセシビリティ取得を有効化
await fetch(`${BASE}/api/plugins/accessibility/enable`, { method: "POST" });

// 不要なプラグインを無効化（パフォーマンス改善）
await fetch(`${BASE}/api/plugins/perf-analyzer/disable`, { method: "POST" });
```

**利用可能なプラグインID：**
`react-fiber` / `vue3` / `vue2` / `angular` / `svelte` / `preact` / `alpine` / `solid` /
`dom-generic` / `text-coords` / `network-hook` / `css-analyzer` / `ui-catalog` /
`perf-analyzer` / `dom-mutations` / `accessibility` / `console-logger` /
`storage-reader` / `css-origin` / `source-fetcher` / `framework-dom-map`

---

## エラーハンドリング

```javascript
async function whiskorAction(tabId, action) {
  const res = await fetch("http://127.0.0.1:7892/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabId, action, timeoutMs: 15000 })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    // data.error にエラーメッセージ
    throw new Error(`Action failed: ${data.error ?? JSON.stringify(data)}`);
  }
  return data;
}
```

**主なエラーパターン：**

| エラー | 原因 | 対処 |
|---|---|---|
| `fetch` が失敗 | サーバー未起動 | `node server/index.js` |
| `404 Session not found` | tabIdが無効 | `/api/sessions` で再取得 |
| `Action timed out` | 要素が見つからない・ページ遷移中 | `wait_for_element`で待機後再試行 |
| `Execute JS is disabled` | allowExecuteJs=false | config.jsonで有効化 |
| `_warnings: STALE_DATA` | データが30秒以上古い | `/api/collect`でリフレッシュ |

---

## キャッシュファイルパス一覧

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
| `raw/dom/shadow-roots.json` | Shadow DOM |
| `raw/react_snapshot.json` | Reactコンポーネントツリー |
| `raw/vue_snapshot.json` | Vue3コンポーネントツリー |
| `raw/intelligence/causal-chains.json` | 因果チェーン |

アクセス方法：`GET http://127.0.0.1:7892/api/sessions/{tabId}/{パス}`

---

## セキュリティ設定の参照

| 設定キー | デフォルト | 意味 |
|---|---|---|
| `security.allowActions` | `true` | click/type等の操作 |
| `security.allowScreenshots` | `true` | スクリーンショット取得 |
| `security.allowExecuteJs` | **`false`** | 任意JS実行（要明示的な有効化） |
| `security.allowExplorer` | `true` | 自律探索エンジン |
| `agentControl.allowAgentConfig` | `false` | エージェントによる設定変更 |

設定確認：`GET http://127.0.0.1:7892/api/config`

---

## Windows PowerShell での注意

```powershell
# 文字化け防止（非ASCII文字を送る前に実行）
chcp 65001
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

---

## クイックリファレンス

```
サーバー確認:   GET  /health
タブ一覧:       GET  /api/sessions
スクリーンショット: POST /api/screenshot  { tabId, marks? }
データ収集:     POST /api/collect        { tabId, plugins? }
操作実行:       POST /api/action         { tabId, action: { type, ... } }
ファイル取得:   GET  /api/sessions/{tabId}/{filepath}
プラグイン操作: POST /api/plugins/{id}/enable|disable
設定確認:       GET  /api/config
```
