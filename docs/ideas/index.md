# Future Ideas — index

> docs/ideas/ にある設計提案の索引。各 doc は「構想〜詳細設計」で、実装の有無は下記の通り。
> Created: 2026-05-22 / Last updated: 2026-07-02

## どこに何があるか（3つの置き場）

- **`docs/ideas/`（ここ）** — 深掘りした設計提案 / 構想 doc。粒度が大きく、実装前の検討材料。
- **`docs/理想機能メモ.md`** — 優先度付きの actionable TODO（15項目）。「次に何をやるか」はこちらが起点。
- **`local_issues/`** — 日付付きのバグ / 不具合 / 調査記録（構想ではなく「直すもの」）。

## 実装済み（substrate あり。doc は当時の構想で、未実装の拡張を含むことがある）

- **REDACTION_SECRET_GUARD** → `server/secret-guard.js`（slice 1＝既知値＋パターン redaction）。hardening は残（[[project_secret_guard_hardening_ideas]]）
- **SOURCE_UPLOAD_CORRELATION** → `server/source-index.js` / `source-store.js` / `source-correlation.js`
- **PACKED_SOM_CAPTURE** → slice 1（packed SoM＋`som-cache`/`som-stats`）+ slice 2 の per-element サムネ（`som-thumbnails`）。slice 3 は残
- **SoM_EXTENSION_PLAN** → `agentControl.screenshotMarks` ＋ packed SoM として実現
- **MULTILINGUAL_INTENT_AND_SCOPED_SEARCH** → semantic（`services/embed-service`）/ scoped（get_text_coords の focusScope）/ 横断検索（session-search）。doc の広い構想の一部
- **SEARCH_PERFORMANCE_AND_LOAD_MANAGEMENT** → `services/load-monitor` ＋ `embed-worker-pool`
- **Cache 自動修復 + ディスク管理** → `cache-integrity.js`。`enforceDiskLimit`（`stateGraph.maxDiskMB`）は **2026-06-18 に起動時へ配線**（それまでデッドコードだった。screenshots 側も `agentControl.screenshot.maxDiskMB` で別途プルーン）
- **LAYOUT_ASCII_MAP** → `server/layout-map.js` ＋ MCP `get_layout_map`（core プロファイル、2026-06-24）。viewport 相対の粗い ASCII 地図、kind 形状 ref（`[n]`/`{n}`/`<n>`）＋任意 legend。grid 内ラベル・text アンカー・共有 ref は将来スライス

## 設計のみ / 構想（未実装）

- **whiskor-for-dev**（→ `docs/vision/whiskor-for-dev/`）— whiskor を「runtime 側の開発環境」へ拡張する横断構想。深掘りは ideas ではなく vision 配下に層別仕様として置く（3 軸 / ホスト非依存コア / 能力＝権限の壁 / ループ閉鎖 / フルスタック trace / Servo・Chromium ヒンジ）。2026-06-26（[[project_whiskor_for_dev_direction]]）
- **CLICK_EVIDENCE_AND_SOM_SCOPE** — クリック証拠バッファ + packed 範囲指定（[[project_click_evidence_som_scope]]）
- **MINILM_CLICK_TEXT_MATCHING** — click(text:) に MiniLM 統合（find_target で代替可ゆえ優先度低、[[project_minilm_click_text]]）
- **NAMESPACE_MAP_AND_AI_COLLAB_VERIFICATION** — 名前空間マップ / piggyback 検証 / production mode（[[project_namespace_map_ai_verification]]）
- **REALTIME_AUDIO_EAR** — AUDIO_STATE ポーリング（Phase1）/ 再生前 DSP（Phase2）（[[project_realtime_audio_ear]]）
- **IMAGE_ASSET_CORRELATION** — 画像↔構造/セッション対応・DL・検索（低優先、[[project_image_asset_correlation]]）
- **LOCAL_VLM_ELEMENT_LABELING** — DOM も OCR も効かない純アイコン/ドラッグ要素を、ローカル視覚モデル（MiniLM とは別）で暫定ラベル付け。packed SoM 切り出しを流用（低優先、[[project_local_vlm_element_labeling]]）
- **VOICE_CONTROL_AND_AGENT_NOTIFICATIONS** — co-pilot を拡張する人↔agent 双方向チャネル。音声操作(STT, pull キュー＋ resource / bring-your-own Whisper) と agent トースト通知(notify ツール＋決定論的 config ルール)。TTS は低優先。"アプリが agent を発火" は whiskor 責務外と整理（[[project_voice_and_notifications]]、理想機能メモ 項目15）
- **DEBUG_DASHBOARD_REDESIGN** — DevPanel の作り直し（Frameworks タブが使いにくい、[[project_devpanel_frameworks_tab]]）
- **ARCHITECTURE_EXTENDED_PROPOSALS** / **ARCHITECTURE_INTELLIGENCE_LAYER** — 広範なアーキ提案（intelligence 層の青写真。一部は explain/why 系として実現済）
- **AGENT_MACROS** — agent 自作可能な合成アクション/マクロ層。第1例 `full_page_read`（scroll＋読取＋マージを worker 側で1呼び出しに）。権限は基底ツールのゲートを継承。CDP 経由ソースキャプチャ（panel 不要化）の代替案も記載（2026-07-02）
- **SELF_UPDATE** — 新コードのDL＆置換アップデータ。起動時のバージョン確認＋通知（＋osToast＋autoSetup）は**実装済み**（`server/update-checker.js`）。この doc はその先＝bundle限定・SHA256検証・staged swap・setup連鎖・supervised restart・git checkout除外の設計。config seam `updateCheck.selfUpdate`（既定false・inert）確保済み（2026-07-02）
- **MCP 大規模改築**（ツール数削減・動的ロード高度化）— 理想機能メモ 項目13。専用 doc は未作成（構想段階）
- **Network Directory** — network を browsable なディレクトリ構造で（旧 index からの持ち越し、未着手）

## 見送り

- FileMaker 連携（de-prioritized） / cache 検証の WASM 化（Node fs で十分＝不要） / AVIF キャプチャ（canvas 非対応＝却下。webp は要素系で採用済＝理想機能メモ 項目10）
