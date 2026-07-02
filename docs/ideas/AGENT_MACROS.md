# エージェント自作マクロ（合成アクション）と full_page_read

Status: 構想（2026-07-02）。実装なし。

## 動機

実例: OCR によるフルページ読み取り（`whk_OCR_approach.txt`, 手動セッションの記録）。
agent が HTTP 越しに「scroll → screenshot → ローカル Tesseract → 次の scroll」を 250px 刻みで
17 往復して 1 ページを読んだ。動くが、

- 1 ステップごとに HTTP 往復＋モデルのターン消費が挟まる（遅い・高い）
- スクロール刻み・固定ヘッダ・lazy-load などページごとの差異吸収が agent 側に散らばる
- 手順自体は毎回同じ＝「決まった反復合成」を毎回プリミティブから組み直している

課題の一般形: **定型の反復手順を worker 側で 1 呼び出しに畳む層がない**。

## 既にあるもの（この構想を考える前提）

- `POST /api/ocr`（`ocr_region`）— selector/rect 範囲の OCR は**実装済み**。ビューポート単位の
  OCR は既に 1 呼び出しでできる（上の実例はこれを使っておらず、スクショ→ローカル Tesseract を
  手組みしていた）。
- `get_text_coords` — DOM にテキストがあるなら OCR 自体が不要。OCR が要るのは canvas/画像のみ
  テキストのときだけ。
- `session-replay`（actions.jsonl + `replay_session`）— 「記録した手順の再生」というマクロの近縁。
  record → 一般化 → マクロ化のパスの足場になる。
- `explorer.js` — サーバー/拡張主導でループを回す前例。

## 構想

### スライス 1: 組み込み合成アクション

worker 側で完結する定型合成を、まず個別機能として提供する。

- **`full_page_read`** — scroll → 読取（DOM テキスト優先、なければ OCR）→ 隣接領域の重複除去
  マージ、を worker が 1 リクエストで実行して全文を返す。スクロール刻み・終端検出・固定ヘッダ
  オフセットはエンジン側が持つ。
- **フルページスクリーンショット**（自動スクロール＋スティッチ）— `capture_screenshot` の
  `fullPage: true` オプションとして同じ足場に乗る。
- scroll-until-found（`find_target` が viewport 外ヒットを返すときの後続として自然）。

### スライス 2: 宣言的マクロ（agent 自作）

steps 配列（action / capture / ocr / wait / until 条件）を 1 リクエストで worker が順次実行する。

```jsonc
{ "name": "read_long_page",
  "params": { "tabId": "number" },
  "steps": [
    { "action": { "type": "scroll", "x": 0, "y": 0 } },
    { "repeat": { "until": "at_bottom", "max": 40 },
      "do": [
        { "ocr": { "lang": "jpn" } },
        { "action": { "type": "scroll", "deltaY": 250 } }
      ] },
    { "return": "merged_text" } ]
}
```

- **権限はステップの基底ツールのゲートをそのまま適用**する（マクロは新しい権限を一切持たない。
  execute_js ステップは `allowExecuteJs`、OCR は OCR 可用性、の重ね合わせ）。
- step 数・時間バジェット必須。失敗時は部分結果＋どのステップで止まったかを返す。
- until 条件は最初は列挙型（`at_bottom` / `element_visible` / `state_hash_stable` 等）に限定。
  任意 JS 条件は `allowExecuteJs` ゲート下でのみ。

### スライス 3: 保存・再利用

名前付きマクロを `~/.whiskor/macros/`（or cache/macros）に保存し、パラメータ化して再実行。
whk shell の catalog にも載せる（フォルダ `macro/`）。replay_session の記録から一般化して
マクロに昇格させる導線が引けると、record → 汎用化の流れがきれいに閉じる。

## 論点

- scroll 系ステップのページ差異（無限スクロール・仮想リスト・固定ヘッダ）の吸収はエンジン側の
  責務。scroll_page が返すようになった `atBoundary` / `moved` が終端検出の基礎になる。
- マクロの実行主体は worker（proxy 越しでも 1 HTTP 呼び出しに畳まれる）。
- MCP ツール数を増やさない形（`run_macro` 1 ツール＋ resources でマクロ一覧公開）が
  ツールプロファイル方針と整合する。

## 余談: CDP 経由ソースキャプチャ（DevTools パネル不要化）

`capture_sources` は `chrome.devtools.inspectedWindow.getResources` の制約で **DevTools パネルが
開いている必要がある**。一方 CDP 入力用に `debugger` permission は既に持っているので、パネルが
開いていないときは `chrome.debugger` の `Page.getResourceTree` / `Page.getResourceContent` で
代替できる（トレードオフ: 「デバッグしています」バナー。パネル方式はバナーなし）。
なお **CDP 高忠実度入力そのものにパネルは不要**で、逆に同じタブで DevTools が開いていると
`debugger.attach` が競合して失敗する。
