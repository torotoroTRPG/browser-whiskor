# キャプチャ画像のキャッシュ寿命調査 — メモリは消えるがディスクは溜まり続ける

## 調査日時
2026-06-17

## きっかけ（2つの問い）
1. 「各UIの状況を視覚的に確認するための、そのUIの小さい画像だけをキャプチャして呼び出す」機能は既にあるか？
2. 現在の実装でキャプチャされた画像はいつキャッシュ clear されるのか？

---

## 問い1の結論: ✅ 既に実装済み（新規実装は不要）

小さなUI画像のキャプチャは3つの形でカバー済み:

| ツール | 内容 | 実体 |
|---|---|---|
| `capture_element_screenshot` | selector / rect で1要素だけ切り出し（padding 既定4px） | `server/mcp/tools/capture-element.js:23-130` |
| `get_element_thumbnail` | 1要素を**サムネイル化**（`maxPx` 既定96px・jpeg q60）+ **ビュー対応キャッシュ**。ページ未変更なら再キャプチャせず返す（`_cached` フラグ付き） | `capture-element.js:136-186` / `screenshot-manager.js:205-221` |
| `capture_packed_som` | 複数の操作可能要素を1枚に詰めて SoM 番号付与 | `screenshot-manager.js:147-158` |

→「それぞれのUIを小さい画像で視覚確認」は **`get_element_thumbnail`** が狙ったもの。selector をキーにビュー対応キャッシュから安く再参照できる。

---

## 問い2の結論: メモリは消える / ディスクは消えない

### (A) メモリ内キャッシュ（som-cache / som-thumbnails）— 設計通り無効化される
`get` 時の stale 判定（`som-cache.js:56-65`, `som-thumbnails.js:67-77`）:
- **ページ変更で無効化（view-aware）**: `PAGE_NAVIGATED` / `DOM_MUTATION` / `TEXT_COORDS` / `UI_CATALOG` / `DOM_SNAPSHOT` 等（`SOM_CHANGE_TYPES`, `core.js:17-19`）受信で `markChanged` → 以降 `capturedAt < changed` のエントリは返さない（`core.js:254`）
- **TTL**: 既定 **5分**（`ttlMs`）超で stale
- **LRU**: som-cache 最大20タブ / som-thumbnails 最大200エントリで古い順に押し出し

### (B) ディスク `cache/screenshots/` — ⚠️ 一切 clear されない（リーク）
- `screenshot-manager.js:163-195` の `handleResult` が **全 captureVisibleTab 結果**を `{tabId}-{timestamp}.{ext}` でディスクに書き込む（`screenshot-manager.js:178-182`）
- このディレクトリを掃除する処理が**実装に存在しない**（`cleanup` / `prune` / `maxAge` / `retention` / `unlink` いずれもヒットなし）
- 起動時の `cleanupTempFiles` / `checkAndRepair`（`index.js:698-703`）は対象が `cache/sessions` のみで screenshots は範囲外
- → `capture_screenshot` を呼ぶほどディスクに蓄積し、自動では永久に消えない

---

## 見つけた具体的なバグ/ギャップ（3点）

### 1. ディスク screenshots の無制限蓄積（リーク）【主】
上記 (B)。`capture_screenshot` / 要素キャプチャの素材が `cache/screenshots/` に溜まり続ける。
- **対策案**: 起動時に古い `cache/screenshots/*` を `cleanupTempFiles` と同じノリでプルーニング、または書き込み時に（タブ別 or 全体で）世代/容量上限ローテーション。設定キー例 `collection.screenshotRetention` / `maxScreenshotMB`。

### 2. `evictTab` がどこからも呼ばれていない
- som-cache / som-thumbnails 両方に「タブclose/navigateで全drop」用の `evictTab` が定義され、ファイル冒頭コメントにも *"dropped on tab close"* とあるが、**実コードからの呼び出しがゼロ**（`grep '.evictTab('` はテストのみヒット）。`core.js:748,861` の `removeSession` でも未呼出。
- 影響: タブを閉じてもメモリエントリは即時 drop されず、TTL(5分)/LRU で間接的に落ちるだけ。小オブジェクトなので実害は限定的だが設計意図とのズレ。
- **対策案**: `removeSession`（`core.js:748,861`）と、タブ navigate 検知箇所で `somCache.evictTab(tabId)` / `somThumbs.evictTab(tabId)` を呼ぶ。

### 3. `enforceDiskLimit` がデッドコード（呼び出されていない）
- `docs/ideas/index.md:23` と `docs/changelog.md:244` で「v0.3.3 実装済み（LRUディスク上限 `stateGraph.maxDiskMB`）」とされているが、`enforceDiskLimit`（`cache-integrity.js:408`）は**サーバーのどこからも呼ばれていない**（`index.js:33` の import にも無く、参照は docs と export のみ）。archive doc 自身が "Recommended to call enforceDiskLimit at server startup" と書いており、結線が漏れたまま。
- しかも対象は `cache/sessions` で、仮に呼んでも `cache/screenshots/` は範囲外。
- **対策案**: 起動時に `enforceDiskLimit(cacheRoot, cfg.stateGraph.maxDiskMB)` を結線。screenshots は別途上記1で対応。

---

---

## 追記: HTTP API の画像返却挙動とフォーマット（2026-06-17）

### HTTP は base64 インラインのみ・リンク不可
`/api/screenshot`・`/api/packed-som`・`/api/element-thumbnail`（`index.js:469-504`）は `sendJson(result)` で返し、`result` に:
- **`dataUrl`** = フル base64 を JSON にインライン（常に・ゲートなし）
- **`filePath`** = 絶対ローカルパス（URLではない。**配信する GET ルートが存在しない**＝同一マシン専用）

→ HTTP 経由で画像を得る唯一の手段がインライン base64。同梱 HTTP スキルも `dataUrl` を使用（`skills/browser-whiskor-http/SKILL.md:69`）。

### ⚠️ MCP / HTTP の非対称（設定が HTTP で効かない）
`/api/screenshot` ハンドラは `const opts = { marks: b.marks === true }`（`index.js:472`）で **`format`/`quality`/`maxWidth`/`returnImage` を素通り**。
- MCP 側（`capture.js:30-81`）= `agentControl.screenshot.returnImageByDefault` ゲート + format/quality/maxWidth 反映 + base64 は `_mcpImage` 別ブロック（JSONに混ぜない・トークン節約）
- HTTP 側 = それらが**全部無視**、常にフル base64 インライン

### フォーマット既定の不統一（PNG妥当性）
- `capture_screenshot`(MCP) = jpeg q70（妥当）
- `capture_element_screenshot` = **png**（`capture-element.js:92`）
- `get_element_thumbnail` = jpeg q60 強制
- `capture_packed_som` = 拡張canvas任せ（MIMEフォールバック png）

PNG は文字/UIエッジが綺麗だが base64/HTTP搬送だと重い。要素系は **webp が最適解**（項目10 と合流）。

#### フォーマット拡張の技術制約（エンコード経路で確認・2026-06-17）
拡張のエンコードは2系統:
- **フルスクショ**: `chrome.tabs.captureVisibleTab({format})`（`extension/background/sw.js:702,830`）→ **png/jpeg のみ**（Chrome API 制約）
- **要素クロップ/packed/サムネ**: `OffscreenCanvas.convertToBlob({type})`（`sw.js:186,213,242,471,477`）→ png/jpeg/**webp 可**

→ **webp = ゼロ依存で対応可**（canvas系はtype変えるだけ。フルスクショは撮ったbitmapをcanvas経由でwebp再エンコードの一手間）。near-term最適解。
→ **AVIF = 実質無理** — canvas は AVIF エンコード非対応（Chrome/Firefox とも `convertToBlob`/`toDataURL` で AVIF を出せず png にフォールバック。表示は可・エンコードは未露出）。出すには WASM エンコーダ同梱（重い・ゼロ依存違反）かサーバー側ネイティブ再エンコード（依存追加）が必要で、webp比のサイズ削減10〜20%に見合わない。**項目10の "AVIF要検証" の答え = 却下、webpのみ採用**。
（注: 「avi」は動画コンテナ。画像形式は AVIF。）

### 設計原則: テキストオンリー消費者に画像を押し付けない
非マルチモーダルな agent にとって base64 画像は**解釈不能なものを大量トークンで渡すだけのゴミ**。MCP は `returnImageByDefault: false` でこれを回避（既定はメタ+filePath、欲しい時だけ opt-in）しているのに、HTTP は常にフル base64 インライン＝最悪挙動。
「マルチモーダルか否かは消費者だけが知る／whiskor は知らない」ので、**whiskor の既定はテキスト前提（画像を押し付けない）にし、画像が要る側が取りに来る**のが正しい。保存と提示の分離。

### 対策案（config 化の方向）
既存の `agentControl.screenshot.{returnImageByDefault,format,quality,maxWidth}` は MCP 層しか読んでいない。新設より「既存 config を HTTP でも効かせる」が筋:
1. **HTTP の既定を「画像インラインしない」に変更（MCP とミラー）** — 既定は filePath + width/height/marks 等メタのみ。base64 は完全 opt-in。
2. 画像は**別リソースとして取得**: `GET /api/screenshots/:file` 配信ルートを新設し、レスポンスに取得用リンクを載せる。マルチモーダル消費者だけが使える時に取りに行く。
3. `httpReturn: "meta"|"link"|"base64"|"both"`、**既定 `"meta"` か `"link"`**。HTTP の3エンドポイントを同 config + リクエスト override に従わせる。
4. 要素/packed/サムネのフォーマット既定も config 統一（将来 webp = 項目10 と合流）

---

## 解決 (2026-06-18)

3バグとも修正（既存コードの配線＋局所追加。新規スコープ最小）:

1. **ディスク screenshots の無制限蓄積** → `screenshot-manager.js` に `pruneOldScreenshots(dir, {maxMB,maxAgeMs})` + `setRetention()` を追加。**起動時**（index.js cleanup）と **書込50回ごと**（handleResult、setImmediate で hot path 外）にプルーニング（古い順 age→size cap）。config `agentControl.screenshot.{maxDiskMB:100, maxAgeHours:24}`。テスト `tests/unit/screenshot-prune.test.js`(4)。
2. **`evictTab` 未呼出** → `core.js` の removeSession 2箇所（DELETE /api/sessions/:tabId・_cleanupStaleSessions）で `somCache.evictTab` / `somThumbs.evictTab` を呼ぶように結線。
3. **`enforceDiskLimit` デッドコード** → index.js 起動時に `enforceDiskLimit(cacheRoot, stateGraph.maxDiskMB)` を結線（cache/sessions の LRU 上限。docs の「v0.3.3 実装済」主張がやっと実体化）。

HTTP 画像返却の非対称（追記セクション）も**部分解決**: `/api/screenshot` が `format/quality/maxWidth/returnImage` を MCP 同様に反映するようになり、`GET /api/screenshots/:file` 配信ルート＋応答 `url` を新設（`returnImage:false` で base64 省略可）。**残り**＝「テキストファースト既定への反転」（base64 を既定で返さない）は dashboard.html と同梱 skill が `dataUrl` 依存のため破壊的＝製品判断として保留。webp フォーマット（理想機能メモ 項目10）も未対応（最適化、別件）。

## 関連ファイル
- `server/screenshot-manager.js` — capture/handleResult/各キャッシュ wiring
- `server/som-cache.js` / `server/som-thumbnails.js` — メモリキャッシュ本体
- `server/core.js:17-19,254,748,861` — SOM_CHANGE_TYPES / markChanged / removeSession
- `server/cache-integrity.js:408` — enforceDiskLimit（未結線）
- `server/index.js:33,402,698-703` — 起動時 cleanup（sessions のみ）
