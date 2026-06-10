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
  - [T10. EPERM: cache writeJson の rename 失敗（Windows）](#t10-eperm-cache-writejson-の-rename-失敗windows)
  - [T11. proxy で _secretGuard 未配線の残り（type_secret / serverInfo）](#t11-proxy-で-_secretguard-未配線の残りtype_secret--serverinfo)
- [Part 3 — 逆引き索引](#part-3--逆引き索引)

---

## Part 1 — 実装済み (Done)

> すべて **main** にマージ済み（2026-06-04 時点）。unit+integration **286 green**。

### A. OSS 品質化
- **目的**: 公開可能なOSSにする土台。
- **内容**: MIT `LICENSE`（著作権 butterflycurtain）、`package.json` に license/repository/homepage/bugs、`playwright` を dependencies→devDependencies（利用者の数百MB DL解消）、`extracted/`(298MB重複) と `tests/tmp/` の追跡解除、`.gitignore` 整備（`secrets.local.json` 等）。
- **場所**: `LICENSE`, `package.json`, `.gitignore`。
- **状態/検証**: ✅。
- **追補（2026-06-10 ドキュメント完全更新）**: README 全面更新（66ツール・packed SoM/secret guard/source upload セクション新設・テスト数406・HTTP API一覧）、`CONTRIBUTING.md`/`SECURITY.md` 新設、CLAUDE.md/architecture.md/http-api-reference.md/manual/README.md/tests/README.md のツール数・エンドポイント・コマンド整合、changelog に `[Unreleased]`、一回性レポート3本（IMPLEMENTATION-PROGRESS/update-report/TEST-REPORT）を `docs/archive/` へ移動。
- **未了**: リポジトリ About/topics は [T8](#t8-github-リポジトリ整頓--リリース)。

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
- **config-change-log の ID 衝突（2026-06-10）**: `addChange` が `id: changes.length + 1` を採番していたため、7日プルーニングで配列が縮むと既存IDと衝突。`markReverted(id)` が**古い同IDエントリ**を revert し、新しい変更が active のまま残る＝自動リバート安全機構がすり抜ける。実キャッシュに重複ID（70-73/97/98）を確認。`max(id)+1` 採番に修正＋プルーニング後状態を模した回帰テスト。`server/config-change-log.js`。✅ 🧪。
- **correlator の confidence 均一問題（レビュー#4, 2026-06-10）**: 実ページで全チェーンが単一ルール `network_dom_temporal`・一律 ~0.66（temporal 減衰帯に圧縮され情報量ゼロ）。ルール追加でなく（過剰相関は逆効果）、temporal ベースに**根拠直結の調整**を重ねる方式に: 書込メソッド +0.05 / 画像・フォント -0.2（.js/.css は対象外）/ 候補競合の曖昧さ -0.04×(N-1) cap 0.12。全要素を `chain.evidence` に記録し confidence を監査可能に。「Intelligence Layer」表現・stale な「1.0 ブースト」記述・`why_did_this_change` の断定調も是正（仮説ランキングと明記）。correlator 初の unit 7本（実モジュール）。`server/correlator.js`＋`server/mcp/tools/intelligence.js`。✅ 🧪。**これでダッシュボードレビュー #1-#8 全クローズ**（#5 は対応不要合意）。
- **config-change-log の非再帰バグ**: `validateChange`/`autoRevert` がネストpatchを処理できず、エージェント設定の安全機構（非推奨警告+自動リバート）が **実運用入力に対して死んでいた** → 両walkerを再帰化。空洞テストが緑で隠蔽していた実例。`server/config-change-log.js`。✅ 🧪。
- **packedSoM cache/stats が proxy で死亡**: som-cache(`_cached`)・som-stats(並べ替え/record)を MCP層(capture.js/write.js)に置いていたため、**proxy mode（実運用の通常構成）では setSomCache/setSomStats が未配線＝完全に無効**（HTTP経路もcache見ず・prefetch温めても誰も読まない）。→ ワーカー側 `screenshot-manager.capturePackedSom` にキャッシュ+stats集約、record は `action-executor.execute`(click) へ。全経路(MCP stdio/HTTP/proxy転送)が同一ワーカーcacheを通る構造で再発防止。[[project_proxy_mode_async_cache]] と同型。検証: `tests/unit/screenshot-manager-packed-som.test.js` ＋ 実機e2e(2回目HTTPが`_cached:true`)。✅ 🧪。
- **非proxyサーバーの起動時クラッシュ（副次発見）**: `index.js:727` の `mcp.setSomCache(somCache)` が別ブロックの `somCache`(206行)を参照不可で `ReferenceError` → `npm start`(非proxy)/e2e が起動不能。proxy mode では当該elseが走らず露見せず。上記修正で727行撤去により解消。✅。
- **秘匿スクショ黒塗りが proxy/HTTP で死亡（セキュリティ）**: マスク計算(`findRedactedRects`)が capture.js(MCP層)のみ＝proxy は `setSecretGuard` 未配線で `cb._secretGuard` undefined、HTTP `/api/screenshot` は `maskRects` を渡さず。**production(proxy)で agent が生スクショ＝秘密が見えていた**。→ ワーカー側 `screenshot-manager.capture` に `setMaskProvider` で集約（全経路が通る）、capture.js から撤去。enabler に config-loader ネスト env 上書き。検証: `tests/unit/screenshot-mask.test.js`＋`tests/unit/config-env-overrides.test.js`、packed-som guard ON 回帰なし。[[project_proxy_mode_async_cache]] と同型。✅ 🧪（実機e2eは headed 接続フレークで保留）。**未了の同根**: write.js `type_secret`・transport serverInfo も proxy で `_secretGuard` 未配線（別途）。

---

## Part 2 — 残作業 (TODO)

### T1. source-upload Slice 3（観測からの相関自動記録 / sourcemap）
- **目的**: 実行時→ソースの相関を **観測から受動的に**埋め、agent の `get_source_context({component})` を round-trip 無しで即解決させる。
- **済（✅ 自動記録）**: `core.routeMessage` の `FRAMEWORK_DOM_MAP` 経路で `_recordObservedCorrelation(payload)` を呼び、`component.name`(+`sourceFile`/`sourceLine` の debug-source ヒント)を `source-correlation.correlate()` に流して受動記録する。dev ビルドは `_debugSource` で **exact**、それ以外は symbol 名一致にフォールバック。`source-index`/`source-correlation` を `core` に注入（`index.js` 配線、proxy 不要＝ワーカー側で完結）。検証: `tests/integration/source-correlation-observe.test.js`（name-match / debug-source 優先 / 非アップロード時 no-throw / 反復カウント）。
- **見送り（sourcemap によるコンポーネント解決）**: production(minified)では React fiber に `_debugSource` が無く、fiber 自体も「このコンポーネントの定義がバンドルの何行か」を持たない。よって *コンポーネント→ソース* を sourcemap で厳密化する経路は **入力データの根拠が無い**ため、憶測のデッドコードは置かない。`source-map-resolver`(VLQ) は既に CSS/スタック起点の解決（`explain_element`）で使用中で、そちらが sourcemap の正当な利用箇所。コンポーネント単位の sourcemap ピン留めが要るなら、まず拡張側で「描画位置の generated line/col + bundle URL」を採取する経路設計が前提（別タスク）。
- **状態/規模**: ✅（自動記録）。sourcemap-component は意図的に非対応（上記理由）。

### T2. パックドSoM: per-element サムネイル（構想2 richer）
- **目的**: 各要素の低画質サムネイルを個別に持ち、要素単位で参照/プリフェッチ。`som-stats`(済) と `som-cache`(済) の上に乗る。
- **済（Slice A）**: ワーカー側 per-element サムネイルキャッシュ `server/som-thumbnails.js`（要素署名=selector+8pxサイズバケット、境界付きLRU、view-aware無効化=`som-cache`と同じ markChanged 信号を `core` で発火）＋ MCPツール `get_element_thumbnail`（既存の単一要素クロップ `captureElement` を再利用、jpeg圧縮）。**全経路(MCP stdio/HTTP/proxy転送)で生きるワーカー集約**（packed-som修正と同じ構造、proxy配線漏れを構造的に回避）。core プロファイルに登録。検証: `tests/unit/som-thumbnails.test.js`＋`tests/unit/element-thumbnail.test.js`（キャッシュ/無効化/ツール整形）。起動スモークOK。
- **済（Slice B1）**: 拡張canvasでの **解像度ダウンスケール**。`cropImage` に `maxPx`（長辺上限、既定96）を追加し crop+縮小を1回の drawImage で実施（Chrome `sw.js`/Firefox `background.js` 両編集）。`get_element_thumbnail`/`/api/element-thumbnail`/proxy転送に `maxPx` を配線、署名に畳み込み。実機e2e検証（`body`@48px→~135B、`_cached`）。e2e の tabId 探索も stale セッション耐性化（最新tabId選択）。
- **済（Slice B3, main 9dc7fa9）— プリフェッチ**: packed-som が撮る**1枚のビットマップから各要素のサムネも切り出し**(`emitThumbs`時)、サーバーが `som-thumbnails` に `get_element_thumbnail({selector})` と同じ署名(selector+maxPx96)で格納＝**追加キャプチャ0でキャッシュを温める**（captureVisibleTab のレート制限回避）。agent向けpacked応答はthumb非含有(コンパクト維持)。config `agentControl.packedSom.prefetchThumbs`(既定off)。`tests/unit/screenshot-prefetch-thumbs.test.js`。
- **B2（遅延キャプチャ）**: ✅ 実質 Slice A の `get_element_thumbnail({selector})`（任意セレクタを個別オンデマンド取得＋キャッシュ）でカバー済み。
- **場所**: `server/som-thumbnails.js`、`screenshot-manager`(captureElementThumbnail/capturePackedSom/_storePackedThumbs)、`capture-element`(get_element_thumbnail)、`index.js`/`core.js` 配線、`extension/background/sw.js`＋`firefox-mv2/background/background.js`(cropImage maxPx＋buildPackedSom thumb)。`docs/ideas/PACKED_SOM_CAPTURE.md` slice2/3 参照。
- **状態/規模**: ✅ 実質完了（Slice A＋B1＋B3、B2 は Slice A でカバー）。

### T3. 手動ブラウザ検証（4点）
- node では動かせない実機挙動。別pwsh + 拡張ロードで目視/e2e（実機メモ: **headed必須**＝旧headlessはMV3拡張を読まない、test timeoutは接続待ち60秒より長く）:
  1. **秘匿スクショ黒塗り**: ✅ **検証中にバグ発見＆修正**（下記 H 参照）。マスク計算は capture.js(MCP層)のみ＝**proxy/HTTP で死亡**していた→ワーカー側 `screenshot-manager.capture` に集約。ユニット実証（maskProvider が capture broadcast に rects を載せる）＋ packed-som が guard ON で回帰なし。enabler として config-loader にネスト env 上書きを実装（CLAUDE.md の `.env` 上書きギャップも解消）。実機 e2e `tests/e2e/secret-mask.spec.mjs` は headed 拡張接続フレークで不安定（CI の `npm test` は e2e 非対象）。([C](#c-秘匿ガード-secret-guard))
  2. **devパネル Frameworks**: Reactページでノードを開いて放置 → 新データ到来後も開いたままか / Unknown が控えめか。([E](#e-devパネル-frameworks-修正))。⬜（目視）。
  3. **packedSoM プリフェッチ / cache**: ✅ cache 機構を実機検証済（2回目HTTPが`_cached:true`、`tests/e2e/packed-som.spec.mjs`）。残: `prefetchOnNavigate=true`(config 2段ネスト)での遷移後即返りの live 確認。([F](#f-パックド-set-of-marks-キャプチャ))
  4. **packedSoM の見た目品質**: ✅ 実機検証済（PNG 実寸デコードで非空・サイズ健全を確認）。([F](#f-パックド-set-of-marks-キャプチャ))
- **状態**: 🟡 部分完了（#3 cache/#4 ✅、#1/#2 と #3 prefetch live 残）。

### T10. EPERM: cache writeJson の rename 失敗（Windows）
- **症状**: 実機e2e中に `[cache] writeJson error: EPERM: operation not permitted, rename '..._index.json.NNN.tmp' -> '_index.json'`。cache-writer のアトミック書き込み（tmp→rename）が Windows で一時的に弾かれる。catch で握り潰すため**非致命的**だが、書き込みが落ちうる。
- **疑い**: teardown の test-cache 掃除との競合 / AV・インデクサのファイルロック / 同名 rename 競合。
- **対応案**: rename EPERM/EXDEV/EBUSY を数回・短間隔でリトライ（既存 proxyRetry 思想と同様）、または書込先が消えていれば諦める。`server/cache-writer.js`。
- **状態**: ✅ 🧪。rename を EPERM/EBUSY/EACCES/EEXIST で 10/30/80ms バックオフ再試行、ENOENT(宛先消失)は再試行せず黙って諦める（エラーログも抑制）。`_renameWithRetry{Async,Sync}`＋ `tests/unit/cache-writer-rename-retry.test.js`。

### T11. proxy で `_secretGuard` 未配線の残り（type_secret / serverInfo）
- **背景**: 秘匿スクショ黒塗りの修正（H 参照）で判明した同根の未了。proxy ブロックは `mcp.setSecretGuard` を呼ばないため、proxy MCP プロセスの `cb._secretGuard` が undefined。
- **影響**: (a) `write.js` の `type_secret` が `ref`→秘密値を解決できず**proxy で機能しない**（値はワーカー側 `secrets.local.json` にあり、proxy プロセスには無い＝ワーカーへ転送する経路が要る）。(b) `transport.js` の serverInfo redaction ブロックが proxy で出ない（表示のみ）。
- **対応案**: `type_secret` をワーカー側経路（HTTP/action）で解決させる。serverInfo は worker の `/health` secretGuard 状態を取得して反映。
- **状態**: ✅ (a) ✅ 🧪 / (b) ✅ 🧪（2026-06-10）。**(a) type_secret 修正済**: 値解決を `action-executor.execute`（全経路が通る唯一の dispatch チョークポイント）に移動。`write.js` は action に `secretRef`(ref名のみ)を載せ、ワーカーが `secretGuard.resolveSecret` で値を解決→action.text に入れて dispatch（agent/proxy は ref しか運ばない、値はワーカー→ページのみ）。guard無効/未知refはワーカーが明確なエラー返し。`actions.setSecretGuard` 配線。検証 `tests/unit/action-secret-ref.test.js`＋`mcp-write.test.js` 改訂。**(b) serverInfo 修正済**: transport に `resolveRedaction`（`_redactionStatus` 非同期プロバイダ優先、無ければ従来の同期 `_secretGuard`）。proxy ブロックが worker `/health` の secretGuard 状態（件数のみ）を initialize 時に取得、2秒バウンド＋全失敗は従来どおり表示省略（ハンドシェイクを止めない）。検証 `transport-serverinfo.test.js` 拡張。実機の proxy initialize 確認は次回 MCP セッション起動時に自然に行われる。

### T4. 秘匿ガード 追加堅牢化（任意）
- **② 追加パターン（main 9cdae78）**: ✅ 🧪。ssn/ipv4/phone を**個別 config トグル**で追加。誤検出しやすい（IP=エンドポイント, phone=フッター等）ため email/creditCard/jwt と違い**既定 off・`=== true` ゲート**。`privacy.secretGuard.patterns` で必要なものだけ有効化（config に trade-off コメント）。`secret-guard.js`＋config＋テスト。
- **① 保管元の別経路読取防止**: ✅（実質）。秘密の値は agent 向け面に出ない事を既存テストが担保（`secret-guard-flow.test.js`＝/health は件数のみ・値は出さない、`transport-serverinfo.test.js`）。`resolveSecret` は type_secret(ワーカー→ページ)専用、`listRefs` は名前のみ。
- **③ スクショ黒塗り v2（ちらつき無し, main 3583e1c）**: ✅。実ページへのオーバーレイをやめ、**撮影後に拡張 canvas 上で黒塗り**（`maskDataUrl`/`maskDataUrlFx`、ページ非接触＝画面チラつき無し、Node 画像処理不要）。rects は document 座標→scroll+dpr で viewport-image px に変換（マスク時のみ executeScript で scroll/dpr 取得）。旧 `drawWhiskorMasks`/`removeWhiskorMasks` 撤去（git 履歴に保存）。サーバー側不変＝e2e 期待値同じ。「チラつき無し」自体は目視確認。
- **④ `dashboardSeesRaw:true` 実装**: ⬜ **見送り（やる率低め・保留）**。ユーザー「あまり必要を感じない」。redaction は `core.routeMessage` 冒頭の単一チョークポイントで in-place→以後 dashboard broadcast も cache も黒塗り＝現状 dead。実装するなら「dashboard へ生・cache/agent へ黒塗り」へ分離（散在 `broadcastToDashboard` を生コピーへ）だが**誤ると agent 漏洩**＝安全既定に穴。未回収項目として残置。
- **場所**: `server/secret-guard.js`、`server/core.js`、`extension/background/sw.js`＋`firefox-mv2/background/background.js`(③)。
- **状態/規模**: 🟡 ②✅①✅③✅／④は見送り（やる率低め）。

### T5. devパネル拡張 B
- **目的**: devパネルを大幅強化＋agentにも(config許可範囲で)見せる。
- **済（UX/堅牢性 quick-win, main 0a94a3b）**: パネルの **HTMLエスケープを全面統一**（ページ由来文字列＝component名/URL/CSS値/token/input type/framework名/JSONダンプを innerHTML 前に必ず `esc()`。`esc` はクォートも対象＝属性安全、framework id は `safeId()`）＝特権パネルへの markup 注入を封鎖。`onOtherFw` の **重複無限増殖を修正**（type 単位で最新保持・再構築）。React ツリー再構築時の **スクロール位置を保持**。両拡張(extension/firefox-mv2)に適用。
- **残**(大型構想): リアルタイムグラフ / **パネル配置の図解を XML 化** / **ページのフロント実装を丸ごと export** / バック挙動の取得 / config許可内で agent にパネル可視化 / 画像 in-view サムネ([[project_image_asset_correlation]])。
- **場所(予定)**: `extension/panel/*`、`extension/devtools/*`、サーバー新エンドポイント。
- **状態/規模**: 🟡 quick-win 済 / 残は特大。

### T6. Frameworks "Unknown" の根本対処
- **済（main 3941275）**: `react.js` に**段階的な名前リゾルバ** `deriveReactName(fiber)`＝ bippy displayName → host tag → `typeName()`(memo/forwardRef/context/関数名を剥がす) → dev build の `_debugSource` ベース名(LoginForm.tsx→LoginForm) → fiber.tag の**種別ラベル**(Fragment/Memo/Context.Provider/Suspense/Lazy…) → "Anonymous"。**もう "Unknown" は出さない**。導出/種別フォールバック名のノードは `w:1` を持ち、両パネルが dim（`anon`）表示＝実名が目立つ。`__SI_REACT_NAME__` を公開しテスト可能化。
- **検証**: vm サンドボックスで**実 adapter をロード**し mock fiber(memo/forwardRef/context/関数/_debugSource/匿名)で名前解決をテスト（`tests/unit/react-name-derivation.test.js`）。両拡張へ sync 済。323 unit + 28 integration green。**実機の最終確認は拡張リロード後に get_framework_state で**（injected 変更のため）。
- **本質的限界**: minified 名は sourcemap 無しでは復元不可＝best-effort（種別ラベルが "Unknown" よりマシ、という設計）。
- **場所**: `shared/injected/adapters/react.js`、`extension/panel/panel.js`＋`firefox-mv2/panel/panel.js`。
- **状態/規模**: ✅ 🧪（vue/angular 等 他 adapter への横展開は将来 任意）。

### T7. source-upload 周辺（zip reader / アップロードUI）
- **済（main f49a8d1）**: ①**依存ゼロ zip reader** `server/zip-reader.js`（zip-writer の対。EOCD+central dir 解析→local header→inflate、store+deflate、maxEntries/maxBytes 上限）。②`/api/source/upload` が `{ zipBase64 }`（base64 zip）も受理→ readZip→addFiles。③**ダッシュボードに「SOURCE UPLOAD」カード**（projectId＋.zip ピッカー、ブラウザで btoa→POST）。検証: `tests/unit/zip-reader.test.js`＋**実機 end-to-end**（別ポート起動でupload→get_source_context が symbol 解決。ネスト env `WHISKOR_SERVER_HTTPPORT` も実機確認）。
- **残（任意）**: `whiskor source add <path>` CLI／multi-project スコープ UI／バック側ソースの検索コンテキスト化。
- **場所**: `server/zip-reader.js`、`server/index.js`(`/api/source/upload`)、`server/dashboard.html`。
- **状態/規模**: ✅ 🧪（核＝zip reader＋upload UI 完了）。残は任意。`docs/ideas/SOURCE_UPLOAD_CORRELATION.md` Open questions 参照。

### T8. GitHub リポジトリ整頓 & リリース
- **内容**: `gh repo edit` で About(description/homepage/topics)、GitHub Release ノート。**バージョン**: 機能多数追加なので `npm version minor`(0.6.0→0.7.0) + `git push --follow-tags`(release.yml起動)。リリースノートの種は changelog の `[Unreleased]` に集約済み。
- **済（2026-06-10）**: README/CONTRIBUTING/SECURITY 整備は完了（[A](#a-oss-品質化) 追補参照）。gh 操作は torotoroTRPG アカウントのトークンが必要な点に注意。
- **状態/規模**: 🟡 残りは About/topics + リリース実施のみ / 小（公開総仕上げ局面で）。

### T9. 雑多（ブランチ掃除・バージョン・dashboardSeesRaw 他）
- ✅ **ブランチ掃除（2026-06-10）**: マージ済み11本（ROADMAP記載8本＋docs/roadmap・integration・test-audit-fixes）をローカル/リモートとも削除。全ヘッドが main の祖先であることを `merge-base --is-ancestor` で検証してから実施。残りは main のみ。
- ✅ **過去リリース掃除（2026-06-10、ユーザー指示）**: v0.3.0〜v0.5.4 の19リリースをタグごと削除（private リポジトリ・全て現行に置換済みのため）。迷子タグ `v3.2.0`（v0.3.0期コミットへの誤タグ）も削除。**残置は v0.6.0（Latest）のみ**、ローカル/リモートのタグも v0.6.0 のみ。
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
- `docs/ideas/IMAGE_ASSET_CORRELATION.md` → 未来構想（exploratory・低優先）: 画像アセット↔構造/セッション対応・個別/選択/全件DL・検索・in-viewリアルタイムdevパネル案
- `docs/ideas/DEBUG_DASHBOARD_REDESIGN.md` → 未来構想（低優先）: 機能据置でデバッグ特化の見た目を新規＝初期値に、現dashboardはレガシー。現行レビュー所見も記載

### MCPツール → セクション
- `capture_packed_som` → [F](#f-パックド-set-of-marks-キャプチャ)
- `type_secret` → [C](#c-秘匿ガード-secret-guard)
- `get_source_context` → [G](#g-ソースアップロード--相関)

### HTTP エンドポイント → セクション
- `POST /api/packed-som` → [F](#f-パックド-set-of-marks-キャプチャ)
- `POST /api/source/upload` / `POST /api/source/context` → [G](#g-ソースアップロード--相関)
- `GET /health`(secretGuard状態) → [C](#c-秘匿ガード-secret-guard)
