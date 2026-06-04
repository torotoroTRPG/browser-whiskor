# browser-whiskor — Status & Roadmap

実装済みと残作業の棚卸し。各項目に **目的 / 場所(ファイル) / 状態 / 検証** を付け、末尾に
**逆引き索引**（キーワード・ファイル → セクション）を置く。

> 凡例 — 状態: ✅完了 / 🟡部分 / ⬜未着手 ・ 検証: 🧪unit / 🔗integration / 🌐e2e実機 / 👁手動目視待ち

---

## 目次

- [Part 1 — 実装済み (Done)](#part-1--実装済み-done)
  - [A. OSS 品質化](#a-oss-品質化)
  - [B. テスト健全化（空洞テスト撲滅 + CIガード）](#b-テスト健全化空洞テスト撲滅--ciガード)
  - [C. 秘匿ガード (Secret Guard)](#c-秘匿ガード-secret-guard)
  - [D. e2e 実機検証](#d-e2e-実機検証)
  - [E. devパネル Frameworks 修正](#e-devパネル-frameworks-修正)
  - [F. パックド Set-of-Marks キャプチャ](#f-パックド-set-of-marks-キャプチャ)
  - [G. ソースアップロード & 相関](#g-ソースアップロード--相関)
  - [H. 実バグ修正](#h-実バグ修正)
- [Part 2 — 残作業 (TODO)](#part-2--残作業-todo)
  - [T1. source-upload Slice 3（観測からの相関自動記録 / sourcemap）](#t1-source-upload-slice-3観測からの相関自動記録--sourcemap)
  - [T2. パックドSoM: per-element サムネイル（構想2 richer）](#t2-パックドsom-per-element-サムネイル構想2-richer)
  - [T3. 手動ブラウザ検証（4点）](#t3-手動ブラウザ検証4点)
  - [T4. 秘匿ガード 追加堅牢化](#t4-秘匿ガード-追加堅牢化)
  - [T5. devパネル拡張 B](#t5-devパネル拡張-b)
  - [T6. Frameworks "Unknown" の根本対処](#t6-frameworks-unknown-の根本対処)
  - [T7. source-upload 周辺（zip reader / アップロードUI）](#t7-source-upload-周辺zip-reader--アップロードui)
  - [T8. GitHub リポジトリ整頓 & リリース](#t8-github-リポジトリ整頓--リリース)
  - [T9. 雑多（ブランチ掃除・バージョン・dashboardSeesRaw 他）](#t9-雑多ブランチ掃除バージョンdashboardseesraw-他)
- [Part 3 — 逆引き索引](#part-3--逆引き索引)

---

## Part 1 — 実装済み (Done)

> すべて **main** にマージ済み（2026-06-04 時点）。unit+integration **286 green**。

### A. OSS 品質化
- **目的**: 公開可能なOSSにする土台。
- **内容**: MIT `LICENSE`（著作権 butterflycurtain）、`package.json` に license/repository/homepage/bugs、`playwright` を dependencies→devDependencies（利用者の数百MB DL解消）、`extracted/`(298MB重複) と `tests/tmp/` の追跡解除、`.gitignore` 整備（`secrets.local.json` 等）。
- **場所**: `LICENSE`, `package.json`, `.gitignore`。
- **状態/検証**: ✅。
- **未了**: README/CONTRIBUTING/SECURITY とリポジトリ About は [T8](#t8-github-リポジトリ整頓--リリース)。

### B. テスト健全化（空洞テスト撲滅 + CIガード）
- **目的**: 「実装を呼ばず自前の玩具をテストする空洞テスト」を排除し、テストを本物にする。
- **内容**: unit約半数が空洞だった → 実import版に書き直し（config-loader / config-change-log / mcp-read / mcp-control / mcp-write / state-store / state-navigator）。node-import不可の injected系5本（executor/bridge/beacon/seen-text）は削除し **e2e へ集約**。再発防止に **空洞テスト検出CIガード**（unit配下が実コードに到達しないと落ちる）。
- **場所**: `scripts/_check-hollow-tests.js`（+ `ci.yml` / `validate.ps1` / npm `check-tests`）、`tests/unit/*`。
- **状態/検証**: ✅ 🧪。MCPツールは `captureTools(registerFn)` で実ハンドラ捕獲 + mock cb 駆動パターン。

### C. 秘匿ガード (Secret Guard)
- **目的**: ユーザーの秘密(パスワード/メアド/トークン)を **agent・ログ・キャッシュ・ダッシュボード** から隠す。脅威モデル: *agentを信頼しているとは限らない*。検出・置換は **サーバー側のみ**＝秘密はページに入れず XSS/サイト窃取を原理封殺。
- **内容（スライス）**:
  - **S1 既知値**: `secrets.local.json` / `WHISKOR_SECRETS`（git管理外）の値を `[WHISKOR_REDACTED type=.. hint=.. reason=..]` トークンに置換。
  - **S2 パターン**: メアド(ドメインhintのみ)・クレカ(Luhn)・**JWT**。2段センチネルでトークン衝突回避。
  - **キー名 redaction**: `{"password":..},{"api_key":..}` 等、未登録でもキー名が機密を示す値を置換。
  - **S4 type_secret**: agentは ref名のみ、サーバーが実値を char-by-char 注入（結果/ログ/cacheに値出ず）。
  - **S3 スクショ黒塗り**: redact済みtext-coordsの矩形をページにCSSオーバーレイ（値でなく矩形だけ渡す）→撮影→除去。Chrome/Firefox。
  - **完全性**: payload外（tabUrl/SoMラベル/アクション結果）も redact。
  - **可観測性**: `GET /health` に件数のみの状態、MCP **serverInfo** で redaction有効を agent に通知。
- **場所**: `server/secret-guard.js`（中核）、`server/core.js`(routeMessage チョークポイント)、`server/mcp/tools/capture.js`(findRedactedRects)、`server/mcp/tools/write.js`(type_secret)、`extension/background/sw.js` & `firefox-mv2/background/background.js`(オーバーレイ)、`server/mcp/transport.js`(buildServerInfo)、`config.json`(`privacy.secretGuard`)、`secrets.local.json.example`、`docs/ideas/REDACTION_SECRET_GUARD.md`。
- **状態/検証**: ✅ 🧪🔗（サーバー側）。**スクショ黒塗りの拡張オーバーレイは 👁 手動待ち**（[T3](#t3-手動ブラウザ検証4点)）。
- **未了の堅牢化**: [T4](#t4-秘匿ガード-追加堅牢化)。

### D. e2e 実機検証
- **目的**: 削除した injected系の挙動を実ブラウザで取り戻す + 実機自動検証手段の確立。
- **内容**: 拡張機能を抱えた Playwright e2e がこの環境で走ることを確立（headed live を別pwshウィンドウで）。**injected収集**（text-coords/bridge: 実データ+座標を dashboard WS で検証）、**executor往復**（POST /api/action → SW → executor → DOM）、**packed-som**（要素→画像+marks）を実機 PASS。待機はイベント駆動（固定sleepなし、createWSも最初のメッセージで即解決）、テスト分離は維持。
- **場所**: `tests/e2e/injected-collection.spec.mjs`、`tests/e2e/packed-som.spec.mjs`、`tests/e2e/helpers/e2e-helpers.mjs`。
- **重要な落とし穴(記録済)**: ① `window.__e2eWs` は per-document → WSは遷移しない別ページに保持 ② `<all_urls>` は data: に注入しない → http(route fulfill) ③ 実サーバーは `ws://host/dashboard` パスのみ dashboard ソケット登録。
- **状態/検証**: ✅ 🌐。

### E. devパネル Frameworks 修正
- **目的**: Frameworks タブの React ツリーが「勝手に畳まれる/Unknown」で使いにくい問題。
- **内容**: REACT_SNAPSHOT 毎の全再描画で展開状態がリセットされていた → `state.reactExpand`(path+name) に保持して復元。匿名ノードは控えめ表示（dim italic）。Chrome/Firefox 両パネル。
- **場所**: `extension/panel/panel.js`+`.html`、`firefox-mv2/panel/panel.js`+`.html`。
- **状態/検証**: ✅、**👁 目視待ち**（[T3](#t3-手動ブラウザ検証4点)）。
- **未了**: "Unknown" の根本（adapter命名抽出）は [T6](#t6-frameworks-unknown-の根本対処)。

### F. パックド Set-of-Marks キャプチャ
- **目的**: フルスクショでなく **インタラクティブ要素だけ** を実画面から切り出し1枚に詰め、SoM番号でagentに操作させ、無駄ピクセル/トークンを削減。
- **内容（スライス）**:
  - **S1 キャプチャ**: 1枚の captureVisibleTab から各要素rectを **canvas drawImage** で crop + shelf-pack + 番号（Chrome=OffscreenCanvas/SW、Firefox=bg page）。`capture_packed_som` ツール + `/api/packed-som`。
  - **S3核 統計**: `som-stats.js` 時間減衰スコア(正規化+シノニム+コールドスタート+上限+永続化)。click時に記録、marksを可能性順に並べ替え（画像番号は不変）。
  - **S2 キャッシュ**: `som-cache.js` フレッシュネス連動LRU。ページ変化(`SOM_CHANGE_TYPES`)で自動無効化。
  - **プリフェッチ**: `agentControl.packedSom.prefetchOnNavigate=true`(既定off) で遷移後に先回りキャプチャしキャッシュ。
- **場所**: `server/mcp/tools/capture.js`(`capture_packed_som`)、`server/screenshot-manager.js`(`capturePackedSom`)、`extension/background/sw.js`+`firefox-mv2/.../background.js`(`buildPackedSom`)、`server/som-stats.js`、`server/som-cache.js`、`server/core.js`(`markChanged`/`SOM_CHANGE_TYPES`)、`server/index.js`(prefetch)、`docs/ideas/PACKED_SOM_CAPTURE.md`。
- **状態/検証**: ✅ 🧪🌐（S1はe2e実機PASS、S2/S3核はunit）。
- **未了**: per-element サムネイル版 [T2](#t2-パックドsom-per-element-サムネイル構想2-richer)、per-identity 統計バケット [T4](#t4-秘匿ガード-追加堅牢化)（同種の話）。

### G. ソースアップロード & 相関
- **目的**: ユーザーが対象サイトのソース(フロント/バック/一部)をアップロード → 実行時観測と相関 → agentに **必要分だけ** ソーススライスを渡す。
- **内容（スライス）**:
  - **S1 アップロード+スライス**: `source-index.js`（projectごとに保存、node_modules/binary除外、size cap、**sliced excerpt**=行範囲/シンボル周辺/全文cap、簡易symbol検索、`queryContext`）。`get_source_context` ツール + `POST /api/source/upload` & `/api/source/context`(通常+proxy)。
  - **S2 相関**: `source-correlation.js` で component名→ソース解決（**debug-source(React _debugSource file/line)優先 → 名前一致**、confidence付き、記録）。`get_source_context({component, sourceFile?, sourceLine?})`。agentは `get_framework_state` の component名+_debugSource をそのまま渡せる。
- **場所**: `server/source-index.js`、`server/source-correlation.js`、`server/mcp/tools/source.js`、`server/index.js`(`/api/source/*`)、`docs/ideas/SOURCE_UPLOAD_CORRELATION.md`。
- **状態/検証**: ✅ 🧪。
- **S3 自動記録**: 観測した `FRAMEWORK_DOM_MAP` から相関を受動記録（[T1](#t1-source-upload-slice-3観測からの相関自動記録--sourcemap)）。✅
- **未了**: 転送/UI [T7](#t7-source-upload-周辺zip-reader--アップロードui)。

### H. 実バグ修正
- **config-change-log の非再帰バグ**: `validateChange`/`autoRevert` がネストpatchを処理できず、エージェント設定の安全機構（非推奨警告+自動リバート）が **実運用入力に対して死んでいた** → 両walkerを再帰化。空洞テストが緑で隠蔽していた実例。`server/config-change-log.js`。✅ 🧪。

---

## Part 2 — 残作業 (TODO)

### T1. source-upload Slice 3（観測からの相関自動記録 / sourcemap）
- **目的**: 実行時→ソースの相関を **観測から受動的に**埋め、agent の `get_source_context({component})` を round-trip 無しで即解決させる。
- **済（✅ 自動記録）**: `core.routeMessage` の `FRAMEWORK_DOM_MAP` 経路で `_recordObservedCorrelation(payload)` を呼び、`component.name`(+`sourceFile`/`sourceLine` の debug-source ヒント)を `source-correlation.correlate()` に流して受動記録する。dev ビルドは `_debugSource` で **exact**、それ以外は symbol 名一致にフォールバック。`source-index`/`source-correlation` を `core` に注入（`index.js` 配線、proxy 不要＝ワーカー側で完結）。検証: `tests/integration/source-correlation-observe.test.js`（name-match / debug-source 優先 / 非アップロード時 no-throw / 反復カウント）。
- **見送り（sourcemap によるコンポーネント解決）**: production(minified)では React fiber に `_debugSource` が無く、fiber 自体も「このコンポーネントの定義がバンドルの何行か」を持たない。よって *コンポーネント→ソース* を sourcemap で厳密化する経路は **入力データの根拠が無い**ため、憶測のデッドコードは置かない。`source-map-resolver`(VLQ) は既に CSS/スタック起点の解決（`explain_element`）で使用中で、そちらが sourcemap の正当な利用箇所。コンポーネント単位の sourcemap ピン留めが要るなら、まず拡張側で「描画位置の generated line/col + bundle URL」を採取する経路設計が前提（別タスク）。
- **状態/規模**: ✅（自動記録）。sourcemap-component は意図的に非対応（上記理由）。

### T2. パックドSoM: per-element サムネイル（構想2 richer）
- **目的**: 各要素の低画質サムネイルを個別に持ち、要素単位で参照/プリフェッチ。`som-stats`(済) と `som-cache`(済) の上に乗る。
- **内容**: 既存 `capture_element_screenshot` を使い per-element crop をキャッシュ、統計上位を先読み。ビュー連動LRU退避（view外/セッション閉/N手番未参照でドロップ）。**注意**: per-element crop をサーバーで再パックするとNode画像処理が要る（軽量方針と衝突）→ 拡張canvasで詰めるか、サムネは個別配信に留める設計判断が必要。
- **場所(予定)**: `server/som-cache.js` 拡張 or 新モジュール、`capture-element` 経路、`som-stats`。
- **状態/規模**: ⬜ / 大。`docs/ideas/PACKED_SOM_CAPTURE.md` の slice2/3 参照。

### T3. 手動ブラウザ検証（4点）
- node では動かせない実機挙動。別pwsh + 拡張ロードで目視/e2e:
  1. **秘匿スクショ黒塗り**: secrets.local.json + `privacy.secretGuard.enabled=true` → ページに秘密表示 → `capture_screenshot(returnImage:true)` で該当領域が黒塗りか。([C](#c-秘匿ガード-secret-guard))
  2. **devパネル Frameworks**: Reactページでノードを開いて放置 → 新データ到来後も開いたままか / Unknown が控えめか。([E](#e-devパネル-frameworks-修正))
  3. **packedSoM プリフェッチ**: `prefetchOnNavigate=true` で遷移後 `capture_packed_som` が `_cached:true` で即返るか。([F](#f-パックド-set-of-marks-キャプチャ))
  4. **packedSoM の見た目品質**: 詰めた画像の crop 位置・DPR スケールが正しいか（実画面と一致するか）。([F](#f-パックド-set-of-marks-キャプチャ))
- **状態**: ⬜（実機確認）。

### T4. 秘匿ガード 追加堅牢化
- **内容**(任意・`docs/ideas` & 記憶に詳細): ①保管元(.env/secrets.local.json)を別経路で読めない事のテスト ②追加パターン(電話/SSN/IP) ③スクショ **サーバー側ピクセル黒塗り** v2(ユーザー画面のちらつき回避) ④`dashboardSeesRaw:true` 経路の実装（現状 dead オプション。redactをdashboard broadcast後・cache前に分離する必要）。
- **場所**: `server/secret-guard.js`、`server/core.js`。
- **状態/規模**: ⬜ / 小〜中。

### T5. devパネル拡張 B
- **目的**: devパネルを大幅強化＋agentにも(config許可範囲で)見せる。
- **内容**(大型構想): リアルタイムグラフ / **パネル配置の図解を XML 化** / **ページのフロント実装を丸ごと export** / バック挙動の取得 / config許可内で agent にパネル可視化。
- **場所(予定)**: `extension/panel/*`、`extension/devtools/*`、サーバー新エンドポイント。
- **状態/規模**: ⬜ / 特大（要スコープ分割の設計メモから）。

### T6. Frameworks "Unknown" の根本対処
- **目的**: パネルで匿名表示になる component の命名を改善。
- **内容**: adapter(react.js 等)の displayName/name 抽出を強化（minified/匿名対策）。パネルの dim 表示は対症療法済([E](#e-devパネル-frameworks-修正))。
- **場所(予定)**: `shared/injected/adapters/react.js` 他。
- **状態/規模**: ⬜ / 中（injected、実機検証要）。

### T7. source-upload 周辺（zip reader / アップロードUI）
- **内容**: ①依存ゼロの **zip reader**（既存 `zip-writer.js` の対）でzipアップロード対応 ②ダッシュボードのアップロードUI or `whiskor source add <path>` CLI ③multi-project/identity スコープ ④バック側ソースの扱い(DOM相関弱→検索コンテキスト)。
- **場所(予定)**: `server/zip-writer.js`(対のreader)、`server/source-index.js`、`server/dashboard.html`。
- **状態/規模**: ⬜ / 中。`docs/ideas/SOURCE_UPLOAD_CORRELATION.md` Open questions 参照。

### T8. GitHub リポジトリ整頓 & リリース
- **内容**: `gh repo edit` で About(description/homepage/topics)、README/CONTRIBUTING/SECURITY 整備、GitHub Release ノート。**バージョン**: 機能多数追加なので `npm version minor`(0.6.0→0.7.0) + `git push --follow-tags`(release.yml起動)。
- **状態/規模**: ⬜ / 小（公開総仕上げ局面で）。

### T9. 雑多（ブランチ掃除・バージョン・dashboardSeesRaw 他）
- マージ済み feature ブランチの削除（oss-readiness / feature/secret-guard / test/e2e-injected-coverage / fix/frameworks-panel-tree / feature/packed-som-capture / feature/som-cache-prefetch / feature/source-upload-correlation / feature/source-correlation-slice2）。
- per-identity 統計バケット（packed-som stats を identity 付き whiskor で分離）。
- `MODULE_TYPELESS_PACKAGE_JSON` 警告（無害。`tests/` を ESM 扱いにする小細工は任意）。

---

## Part 3 — 逆引き索引

### キーワード → セクション
- 秘匿 / redaction / パスワード / メアド / JWT / type_secret / スクショ黒塗り → [C](#c-秘匿ガード-secret-guard) / 堅牢化 [T4](#t4-秘匿ガード-追加堅牢化)
- SoM / packed / 要素キャプチャ / 統計 / プリフェッチ / キャッシュ → [F](#f-パックド-set-of-marks-キャプチャ) / サムネ [T2](#t2-パックドsom-per-element-サムネイル構想2-richer)
- ソース / upload / 相関 / component→source / sourcemap → [G](#g-ソースアップロード--相関) / [T1](#t1-source-upload-slice-3観測からの相関自動記録--sourcemap) / [T7](#t7-source-upload-周辺zip-reader--アップロードui)
- テスト / 空洞 / hollow / CIガード / captureTools → [B](#b-テスト健全化空洞テスト撲滅--ciガード)
- e2e / Playwright / 実機 / dashboard WS / route fulfill → [D](#d-e2e-実機検証) / 手動 [T3](#t3-手動ブラウザ検証4点)
- パネル / Frameworks / Unknown / ツリー展開 → [E](#e-devパネル-frameworks-修正) / [T6](#t6-frameworks-unknown-の根本対処) / 拡張B [T5](#t5-devパネル拡張-b)
- LICENSE / playwright依存 / 掃除 / OSS → [A](#a-oss-品質化) / [T8](#t8-github-リポジトリ整頓--リリース)
- 設定安全 / autoRevert / config-change-log バグ → [H](#h-実バグ修正)
- serverInfo / /health / 可観測性 → [C](#c-秘匿ガード-secret-guard)

### 主要ファイル → セクション
- `server/secret-guard.js` → [C](#c-秘匿ガード-secret-guard)
- `server/som-stats.js` / `server/som-cache.js` → [F](#f-パックド-set-of-marks-キャプチャ)
- `server/source-index.js` / `server/source-correlation.js` → [G](#g-ソースアップロード--相関)
- `server/mcp/tools/capture.js` → [C](#c-秘匿ガード-secret-guard)(黒塗り) + [F](#f-パックド-set-of-marks-キャプチャ)(packed)
- `server/mcp/tools/write.js` → [C](#c-秘匿ガード-secret-guard)(type_secret) + [F](#f-パックド-set-of-marks-キャプチャ)(click→統計記録)
- `server/mcp/tools/source.js` → [G](#g-ソースアップロード--相関)
- `server/core.js` → [C](#c-秘匿ガード-secret-guard)(routeMessage redact) + [F](#f-パックド-set-of-marks-キャプチャ)(markChanged)
- `server/mcp/transport.js` → [C](#c-秘匿ガード-secret-guard)(buildServerInfo)
- `server/config-change-log.js` → [H](#h-実バグ修正)
- `extension/background/sw.js` / `firefox-mv2/background/background.js` → [C](#c-秘匿ガード-secret-guard)(overlay) + [F](#f-パックド-set-of-marks-キャプチャ)(buildPackedSom)
- `extension/panel/*` / `firefox-mv2/panel/*` → [E](#e-devパネル-frameworks-修正)
- `scripts/_check-hollow-tests.js` → [B](#b-テスト健全化空洞テスト撲滅--ciガード)
- `tests/e2e/*.spec.mjs` → [D](#d-e2e-実機検証)
- `docs/ideas/REDACTION_SECRET_GUARD.md` → [C](#c-秘匿ガード-secret-guard)
- `docs/ideas/PACKED_SOM_CAPTURE.md` → [F](#f-パックド-set-of-marks-キャプチャ) / [T2](#t2-パックドsom-per-element-サムネイル構想2-richer)
- `docs/ideas/SOURCE_UPLOAD_CORRELATION.md` → [G](#g-ソースアップロード--相関) / [T1](#t1-source-upload-slice-3観測からの相関自動記録--sourcemap)
- `docs/ideas/NAMESPACE_MAP_AND_AI_COLLAB_VERIFICATION.md` → 未来構想（ロードマップ外）: 保存/提示分離・AI協調検証・名前空間マップ・production マッピングmode・Rust核

### MCPツール → セクション
- `capture_packed_som` → [F](#f-パックド-set-of-marks-キャプチャ)
- `type_secret` → [C](#c-秘匿ガード-secret-guard)
- `get_source_context` → [G](#g-ソースアップロード--相関)

### HTTP エンドポイント → セクション
- `POST /api/packed-som` → [F](#f-パックド-set-of-marks-キャプチャ)
- `POST /api/source/upload` / `POST /api/source/context` → [G](#g-ソースアップロード--相関)
- `GET /health`(secretGuard状態) → [C](#c-秘匿ガード-secret-guard)
