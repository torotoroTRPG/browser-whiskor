# browser-whiskor HTTP API リファレンス

[SKILL.md](SKILL.md) の詳細編。バージョンはリポジトリの `package.json` が唯一の真実。

## エンドポイント一覧

| | |
|---|---|
| `GET /health` | 接続確認（ok / wsConnections / sessions / secretGuard） |
| `GET /` | ダッシュボード |
| `GET /api/config` | 現在の設定取得 |
| `POST /api/config` | 設定変更 |
| `GET /api/sessions` | セッション一覧（既定は軽量＝tabId/url/title/dataAge/isStale/summary を関連度順の配列で。`?verbose=1` で freshnessMap も）。`?q=&mode=exact\|fuzzy\|semantic` で title/url 検索、`?sort=relevant\|recent\|created\|title\|url`、`?tabId=` で1件、`?page=&pageSize=`（`page=all` で全件）でページング。q/tabId/page いずれか指定時は `{sessions,total,page,totalPages,hasMore}` を返す |
| `GET /api/search` | 全 active セッション横断の単語検索（`?q=&mode=exact\|fuzzy\|semantic&level=&minScore=&maxPerTab=`） |
| `GET /api/sessions/:tabId` | 特定セッションの詳細 |
| `DELETE /api/sessions/:tabId` | セッション削除 |
| `GET /api/sessions/:tabId/{path}` | キャッシュファイル取得（下記パス一覧） |
| `GET /api/sessions/:tabId/states` | ステート一覧 |
| `GET /api/graphs` | ステートグラフ一覧 |
| `POST /api/action` | ブラウザ操作（下記アクション一覧） |
| `POST /api/screenshot` | スクリーンショット `{ tabId, marks?, returnImage?, format?, quality?, maxWidth? }`。既定で `dataUrl`(base64)＋`filePath`＋`url` を返す。`returnImage:false` で base64 を省き `url`/`filePath` のみ（トークン節約）。`format`/`quality`/`maxWidth` は MCP と同じく反映。サーバー既定はconfig `agentControl.screenshot.httpInlineImage`（既定 true） |
| `GET /api/screenshots/:file` | 保存済みスクショ画像をバイナリ配信（`/api/screenshot` 応答の `url` で参照。base64 をインラインせず画像を取得する経路） |
| `POST /api/packed-som` | パックド Set-of-Marks `{ tabId }` |
| `POST /api/element-thumbnail` | 要素サムネイル `{ tabId, selector, format?, quality?, maxPx? }`（`format:'webp'` で最小） |
| `POST /api/collect` | データ収集トリガー `{ tabId, plugins? }` |
| `POST /api/embed` | テキストベクトル埋め込み（MiniLM） |
| `POST /api/source/upload` | プロジェクトソースのアップロード（ファイル群 or base64 zip） |
| `POST /api/source/context` | アップロード済ソースのスライス取得 |
| `GET /export` | セッションキャッシュを ZIP でダウンロード（`?tabId=` で単一に限定） |
| `POST /api/plugins/:id/:action` | プラグイン ON/OFF（`enable` / `disable`） |

## アクション（`POST /api/action`）

共通フォーマット:

```javascript
await fetch("http://127.0.0.1:7892/api/action", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tabId,
    action: { type: "<type>", /* ... */ },
    timeoutMs: 15000,   // 省略可（デフォルト15秒）
  }),
});
// → { ok, result?, error?, durationMs }
```

### クリック系

```javascript
{ type: "click", text: "Sign In" }                    // テキスト指定（最も安全）
{ type: "click", selector: "#login-btn" }             // CSSセレクタ
{ type: "click", x: 450, y: 320 }                     // 座標（SoMマーカーのcenter）
{ type: "click", selector: ".item", double: true }    // ダブルクリック
{ type: "right_click", selector: ".menu-trigger" }    // 右クリック
{ type: "analyze_click", selector: "#btn" }           // ドライラン: クリック可能性レポートのみ（副作用なし）
```

クリックは clickability 解析を内蔵する: 無効要素・遮蔽はエラーで返り、モーダル等の遮蔽は
設定（`intelligence.clickability.autoUnblock`）に応じて自動解除を試みる。自動解除は
「対象の前が実際にクリアになったか」を再検証し、解除しきれなければ `Element is obstructed` を返す
（`clickability.obstructedBy` に遮蔽要素の情報が入る）。

クリック後は SPA/Turbo の非同期遷移（fetch→DOM差し替え）も待って状態変化を判定する
（イベント駆動、最大 ~800ms）。結果の `stateChanged` / `unexpectedBehavior: "no_state_change"`
はこれを踏まえた値なので、`no_state_change` は「実際に何も変わらなかった」と解釈してよい。

要素解決の規則:

- `text` 指定は**可視のラベル**（textContent / aria-label / placeholder / title 等）を優先する。
  大文字小文字が一致する候補が優先され、入力欄の現在値（`value`）へのマッチは劣後する。
  非表示（`display:none` 等）の要素は対象にならない
- `selector` が複数要素にマッチした場合は最初の**可視**要素が選ばれ、結果に
  `selectorMatches`（マッチ数）と `selectorPickedIndex` が付く。付いていたらセレクタを見直す
- React/MUI 等が生成する動的 ID（`#:r5k:` のような形式）は再レンダリングで変わるため
  セレクタに使わない。`text` / 安定属性（`aria-label`, `name`, `data-*`）/ 座標を使う

### 入力系

```javascript
{ type: "type", selector: "input[type=email]", text: "user@example.com", clear: true }
{ type: "type", selector: "input[name=q]", text: "検索語", pressEnter: true }
{ type: "type", selector: "input[type=password]", secretRef: "my-login" }  // secret guard の ref で実値を伏せたまま入力
{ type: "press_key", key: "Escape" }            // Enter / Tab / ArrowDown など
{ type: "press_key", key: "Control+Shift+K" }   // 修飾キーコンビネーション
{ type: "press_key", key: "w+d" }               // 通常キーの同時押し（全キー down → 逆順 up）
{ type: "press_key", key: "w", holdMs: 500 }    // 押しっぱなし（keyup まで最大5秒保持）
{ type: "focus", selector: "input#name" }
{ type: "clear_input", selector: "input#name" }
```

- `type` は `selector` 指定時に**自動でフォーカスしてから**入力する。selector 省略時は
  「現在フォーカス中の要素」に入力するため、事前の `focus` / `click` が必要
- `press_key` は synthetic イベントのため、ブラウザ既定動作（PageDown でのスクロール等）は
  発生しない。実スクロールは `scroll` / `mouse_scroll` を使う
- `secretRef` は `privacy.secretGuard.enabled: true` かつ `secrets.local.json` に ref 登録済みのときのみ有効。
  エージェントは ref 名だけを扱い、実値はサーバー（ワーカー）側で解決される。

### ホバー・スクロール・ドラッグ

```javascript
{ type: "hover", selector: ".dropdown-trigger" }
{ type: "scroll", deltaY: 500 }                          // ページ（正=下）
{ type: "scroll", selector: ".container", deltaY: 300 }  // 要素内
{ type: "mouse_scroll", x: 400, y: 300, deltaY: 200 }    // 座標指定ホイール
{ type: "drag", fromX: 100, fromY: 200, toX: 400, toY: 200 }
```

### フォーム

```javascript
{ type: "select_option", selector: "select#country", value: "JP" }
{ type: "select_option", selector: "select#lang", label: "日本語" }
{ type: "check", selector: "input#agree", checked: true }
```

### ナビゲーション

```javascript
{ type: "navigate", url: "https://example.com/login" }
{ type: "go_back" }
{ type: "go_forward" }
{ type: "reload" }
{ type: "reload", hard: true }   // キャッシュ無視
```

### 待機・JS実行

```javascript
{ type: "wait_for_element", selector: ".modal", timeoutMs: 5000, visible: true }
{ type: "execute_js", code: "return document.title", captureConsole: true }
```

`execute_js` は `config.json` の `security.allowExecuteJs: true` のときのみ動作（既定 false）。
ユーザーに有効化を確認してから使うこと。

### ステートグラフ

```javascript
{ type: "navigate_to_state", hash: "a1f3c8e2", timeoutMs: 30000 }       // 記録済み状態へ自動ナビゲート
{ type: "get_navigation_path", fromHash: "b2c4d6e8", toHash: "a1f3c8e2" } // 経路のドライラン
```

記録済み状態の一覧は `GET /api/sessions/:tabId/states`（hash / label / url を含む）。

## キャッシュファイルパス

`GET /api/sessions/{tabId}/{path}` で取得:

| パス | 内容 |
|---|---|
| `raw/visual/text-coords.json` | テキスト座標（単語/ブロック + ピクセル座標）。`textCoords.includeFormValues` 有効時は `formValues`（input/textarea/contentEditable の value + 座標）も含む。password/hidden/決済等の機微フィールドは値を伏せ（`valueOmitted: true`）、載る値も secret-guard で redaction 済み |
| `raw/visual/viewport.json` | ビューポート情報 |
| `raw/network/requests.json` | ネットワークリクエスト（status / body 抜粋） |
| `raw/console/logs.json` | コンソールログ（level / message / ts） |
| `raw/ui/elements.json` | UIカタログ（buttons / links / inputs） |
| `raw/accessibility/tree.json` | アクセシビリティツリー |
| `raw/storage/data.json` | localStorage / sessionStorage / Cookie |
| `raw/perf/metrics.json` | Web Vitals |
| `raw/css/analysis.json` | CSS解析 |
| `raw/dom/snapshot.json` | DOMスナップショット |
| `raw/dom/shadow-roots.json` | Shadow DOM |
| `raw/react_snapshot.json` | Reactコンポーネントツリー |
| `raw/vue_snapshot.json` | Vue3コンポーネントツリー |
| `raw/intelligence/causal-chains.json` | 因果チェーン |

## 全セッション横断検索（`GET /api/search`）

今動いている全 whiskor-active セッションを横断し、ある単語が **どのタブに在るか** を一発で探す。
タブごとに `text-coords.json` を取って grep する代わりに使う。

```javascript
// exact（部分一致, 既定）/ fuzzy（タイポ許容）/ semantic（MiniLM 意味検索）
const hits = await fetch(`${BASE}/api/search?q=iwabi&mode=fuzzy`).then(r => r.json());
// → { query, mode, level, tabsScanned, hitCount, results: [
//      { tabId, url, title, isStale, matchCount, matches: [{ text, level, score?, x, y }] }, ... ] }
// results は関連度（スコア/件数）の高いタブ順。ヒットしたタブだけ返る。
```

| パラメータ | 既定 | 意味 |
|---|---|---|
| `q` | （必須） | 検索語 |
| `mode` | `exact` | `exact`（部分一致）/ `fuzzy`（類似度）/ `semantic`（MiniLM。モデル無ければ fuzzy にフォールバックし `note` を付ける） |
| `level` | `words` | `words` / `lines` / `blocks`（粒度） |
| `minScore` | `0.3` | fuzzy / semantic のスコア下限 |
| `maxPerTab` | `20` | 1タブあたりの最大マッチ数 |

## プラグイン

`POST /api/plugins/{id}/enable|disable` で切り替え。利用可能な ID:

`react-fiber` / `vue3` / `vue2` / `angular` / `svelte` / `preact` / `alpine` / `solid` /
`dom-generic` / `text-coords` / `network-hook` / `css-analyzer` / `ui-catalog` /
`perf-analyzer` / `dom-mutations` / `accessibility` / `console-logger` /
`storage-reader` / `css-origin` / `source-fetcher` / `framework-dom-map`

## ソースアップロード相関

プロジェクトのソースを渡しておくと、実行時観測（要素・エラー）とソースの対応付けが効く:

```javascript
// アップロード（base64 zip か files[]）
await post("/api/source/upload", { zipBase64: "<base64>" });
// スライス取得（シンボル名やファイルパスで）
await post("/api/source/context", { query: "LoginForm" });
```

## セキュリティ設定の参照

| 設定キー | デフォルト | 意味 |
|---|---|---|
| `security.allowActions` | `true` | click/type 等の操作 |
| `security.allowScreenshots` | `true` | スクリーンショット |
| `security.allowExecuteJs` | **`false`** | 任意JS実行（要明示的な有効化） |
| `security.allowExplorer` | `true` | 自律探索エンジン |
| `agentControl.allowAgentConfig` | `false` | エージェントによる設定変更 |
| `agentControl.autoSwitchTab` | `true` | 非アクティブタブへの操作/キャプチャ時に自動でそのタブへ切り替え |
| `privacy.secretGuard.enabled` | `false` | 秘匿ガード（サーバー側 redaction） |
| `textCoords.includeFormValues` | `false` | フォーム value 収集（input/textarea の value を text-coords に載せる）。機微フィールドは除外し、値は secret-guard で redaction。エージェントは収集を有効化できない＝ユーザー権限の設定 |

設定確認: `GET /api/config`

secret guard が有効なとき、知覚データ内の秘密値は `[WHISKOR_REDACTED type=.. ref=..]` トークンに
置換されて見える。実値が必要な入力は `type` + `secretRef` を使う（上記）。

## Windows PowerShell での注意

```powershell
# 非ASCII文字を送る前に（文字化け防止）
chcp 65001
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

curl 例:

```powershell
curl.exe -s http://127.0.0.1:7892/health
curl.exe -s -X POST http://127.0.0.1:7892/api/action -H "Content-Type: application/json" -d '{"tabId":1234,"action":{"type":"click","text":"Sign In"}}'
```
