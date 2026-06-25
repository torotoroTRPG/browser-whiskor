# browser-whiskor v0.10.0 — Live E2E 検証ガイド

> **対象エージェント**: opencode (DeepSeek 4 Flash)
> **前提**: `whk` コマンドが PATH に登録済み。ブラウザに browser-whiskor 拡張が読み込まれている。
> **操作方法**: `whk <METHOD> <path> [json]` でローカルサーバー (localhost:7892) の HTTP API を叩く。

## 最初にやること

```bash
whk --help          # CLI の使い方を確認
whk GET /health     # サーバーが動いているか・拡張が接続しているか確認
```

`/health` で `"wsConnections": 1` 以上、`"extensions"` に接続中のブラウザが見えれば準備 OK。
見えなければ: サーバーが起動していない (`whk` で起動) か、拡張がロードされていない。

---

## 検証 1: Config Propagation Fix (commit 1012222)

### 背景

`source-fetcher.js` と `css-origin.js`（ページ内の MAIN world で動く injected スクリプト）が
サーバーから受け取った config (`__SI_CONFIG__`) を読んで動作を変える。
**バグ**: ページ遷移後の新しいページで、Service Worker が config を push しなかったため
`__SI_CONFIG__` が `undefined` のまま → source-fetcher/css-origin が死んだ設定で動いていた。
**修正**: SW が `executeScript` で config を注入するようになった。

### 検証手順

1. **セッションを確認**:
```bash
whk GET /api/sessions
```
アクティブなタブの `tabId` を控える。タブが無ければブラウザで適当なページを開く。

2. **config を変更して、ページ遷移後も反映されるか確認**:
```bash
# 現在の config を確認
whk GET /api/config

# source-fetcher の maxJsSizeBytes を変更（既定値と違う値にする）
whk POST /api/config '{"sourceFetcher":{"maxJsSizeBytes":500000}}'
```

3. **ブラウザでページ遷移を起こす** (navigate):
```bash
whk POST /api/action '{"tabId":<TABID>,"action":{"type":"navigate","url":"https://example.com"}}'
```
`<TABID>` は手順 1 で得た tabId に置き換える。

4. **遷移後のセッションデータを確認**:
```bash
whk GET /api/sessions/<TABID>
```
セッションが更新されていれば（url が `example.com` に変わっていれば）遷移成功。

5. **CSS 分析データが取れるか確認** (css-origin が動いている証拠):
```bash
whk GET /api/sessions/<TABID>/raw/css/analysis.json
```
JSON が返れば css-origin が動いている。`404` や空なら config 未伝播の可能性。

6. **データ収集を明示的にトリガーして確認**:
```bash
whk POST /api/collect '{"tabId":<TABID>}'
# 少し待ってから
whk GET /api/sessions/<TABID>
```
`updatedAt` が更新されていれば収集が動いている。

### 合格基準
- ページ遷移後に `GET /api/sessions/<TABID>` がデータを返す
- CSS 分析データ (`raw/css/analysis.json`) が空でない
- `POST /api/collect` 後にセッションが更新される

### 不合格の兆候
- 遷移後にセッションデータが古いまま (updatedAt が変わらない)
- `raw/css/analysis.json` が 404 / 空の JSON
- コンソールに `__SI_CONFIG__ is undefined` 系のエラー

---

## 検証 2: DevTools Source Capture (commits 4cd9707, fb239ec, 1bc7202, 25a2de3)

### 背景

`capture_sources` は DevTools パネル経由でページのリソース (JS/CSS/HTML) を取得する機能。
**重要な前提**: ブラウザの DevTools を開き、browser-whiskor の DevTools パネルが
そのタブで表示されている必要がある（`getResources()` は DevTools が開いていないと動かない）。

### 準備

1. ブラウザで適当な Web アプリ (SPA が望ましい。例: GitHub, Twitter, 何でも良い) を開く
2. そのタブで **F12 → browser-whiskor パネルのタブを選択** して DevTools パネルを表示状態にする
3. tabId を確認:
```bash
whk GET /api/sessions
```

### 検証 2a: 基本キャプチャ (getResources)

```bash
# DevTools パネルが開いているタブでキャプチャ
whk POST /api/source/capture '{"tabId":<TABID>}'
```

#### 期待される応答
```json
{
  "ok": true,
  "stored": 15,    // 数字は環境による。0 より大きければ OK
  "count": 20      // 試みた総数
}
```

#### DevTools パネルが開いていない場合
```json
{
  "ok": false,
  "error": "capture_timeout",
  "hint": "No DevTools panel responded..."
}
```
→ DevTools を開いて browser-whiskor パネルを表示してからリトライ。

### 検証 2b: キャプチャ結果の確認

```bash
# キャプチャされたファイル一覧
whk GET /api/sources/<TABID>

# フォルダ構造付き ZIP ダウンロード（ブラウザで開く）
# → http://localhost:7892/api/sources/<TABID>/zip
```

#### 合格基準
- `GET /api/sources/<TABID>` が `files` 配列を返す（JS/CSS/HTML が含まれる）
- 各ファイルに `url`, `kind`, `hash`, `stored: true` がある

### 検証 2c: includeNetwork (XHR/fetch body capture)

```bash
# ネットワーク応答も含めてキャプチャ（DevTools Network パネルに記録があること）
whk POST /api/source/capture '{"tabId":<TABID>,"includeNetwork":true,"timeoutMs":20000}'
```

#### 期待される応答
- `stored` の数が 2a より増える（XHR/fetch の応答 body が追加される）
- API 応答の JSON ファイルなどが含まれる

```bash
# 結果を確認
whk GET /api/sources/<TABID>
```
`kind: "json"` や `acquisition_level: 2` のエントリがあれば network capture が動いている。

### 検証 2d: reload オプション（注意: ページが再読み込みされる）

```bash
# ページをリロードして全リクエストをキャプチャ
whk POST /api/source/capture '{"tabId":<TABID>,"includeNetwork":true,"reload":true,"timeoutMs":30000}'
```

**警告**: `reload: true` はページを再読み込みするので、フォーム入力中のタブでは使わない。

#### 合格基準
- `ok: true` が返る
- `stored` 数が 2c よりさらに増える可能性がある（初期ロードの JS/CSS/API が全部入る）

### 検証 2e: binary 含み (オプション)

```bash
whk POST /api/source/capture '{"tabId":<TABID>,"includeBinary":true}'
```
- 画像/フォント等も `stored: true` で含まれる

---

## 検証 3: ZIP エクスポート (全体)

```bash
# セッション全体の ZIP エクスポート（ブラウザで開く）
# → http://localhost:7892/export?tabId=<TABID>
```

---

## クイックリファレンス: 主要 API

| 操作 | コマンド |
|------|---------|
| サーバー状態 | `whk GET /health` |
| セッション一覧 | `whk GET /api/sessions` |
| セッション詳細 | `whk GET /api/sessions/<tabId>` |
| データ収集 | `whk POST /api/collect '{"tabId":<id>}'` |
| ソースキャプチャ | `whk POST /api/source/capture '{"tabId":<id>}'` |
| ソース一覧 | `whk GET /api/sources/<tabId>` |
| ソース ZIP | ブラウザで `http://localhost:7892/api/sources/<tabId>/zip` |
| ページ遷移 | `whk POST /api/action '{"tabId":<id>,"action":{"type":"navigate","url":"https://..."}}'` |
| クリック (テキスト) | `whk POST /api/action '{"tabId":<id>,"action":{"type":"click","text":"ボタン名"}}'` |
| テキスト入力 | `whk POST /api/action '{"tabId":<id>,"action":{"type":"type","selector":"#input","text":"値","clear":true}}'` |
| スクリーンショット | `whk POST /api/screenshot '{"tabId":<id>}'` |
| テキスト座標 | `whk GET /api/sessions/<tabId>/raw/visual/text-coords.json` |
| UI カタログ | `whk GET /api/sessions/<tabId>/raw/ui/elements.json` |
| 横断検索 | `whk GET /api/search?q=キーワード` |
| config 確認 | `whk GET /api/config` |
| config 変更 | `whk POST /api/config '{"key":"value"}'` |

## トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| `ECONNREFUSED` | サーバーが起動していない | `whk` で起動 |
| `wsConnections: 0` | 拡張が接続していない | ブラウザで拡張を再読み込み |
| `capture_timeout` | DevTools パネルが開いていない | F12 → browser-whiskor タブを選択 |
| `no_getResources` | Firefox で getResources 未サポート | Chrome/Edge を使用 |
| セッション一覧が空 | タブにまだ content script が注入されていない | タブをリロード |
