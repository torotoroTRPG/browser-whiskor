# npm audit — ws fixed, protobufjs (transitive via transformers v2) deferred

**2026-06-24 調査・対応。** 外部レビューで `npm audit` の脆弱性が指摘された。検証して一部対応。

## 対応済み
- **ws: High (GHSA-96hv-2xvq-fx4p, Memory exhaustion DoS from tiny fragments)** → `npm audit fix` で `ws@8.20.1 → 8.21.0`。直接依存（WS サーバ :7891）。package.json は `^8.18.0` のままで満たす（package-lock のみ変更）。integration 29/29・unit 582/582（直列実行）で無害を確認。

## 未対応（意図的に保留）
- **protobufjs: Critical（コード実行系ほか多数）＋ onnx-proto / onnxruntime-web: High** — 依存チェーンは:
  `@xenova/transformers@2.17.2 → onnxruntime-web@1.14.0 → onnx-proto@4.0.4 → protobufjs@6.11.6`
  - `onnx-proto@4` は `protobufjs@^6.8.8` を要求し、`6.11.6` は ^6 系の最新。脆弱性修正は **protobufjs 7.x 以降**にしか無く、override で 7/8 を強制すると onnx-proto が壊れる（API 非互換）。
  - 根治は **`@huggingface/transformers@4`（旧 `@xenova/transformers` の改名・メジャー）への移行**のみ。新しい onnxruntime-web は onnx-proto/protobufjs を使わないため脆弱性が消える。
  - これは `server/services/embed-worker.js`（`require('@xenova/transformers')`）と `server/index.js` の起動時 pre-download、`scripts/download-model.js` / `scripts/_check-model-config.js` を巻き込む**破壊的移行＝別タスク**。`npm audit fix --force` は使わない（embeddings が壊れる）。

### 実被害評価（なぜ保留が妥当か）
- whiskor は **localhost 専用ツール**。protobufjs を使うのは onnx-proto がローカルの **MiniLM ONNX モデル**（HuggingFace から取得する既知ファイル）をパースする経路のみ。protobufjs のコード実行系 CWE は「悪意ある protobuf/JSON descriptor を食わせる」のが前提で、ここでの入力は信頼できる固定モデル＝実exploit 面は極小。
- 埋め込み（セマンティック検索）は**任意機能**（モデル不在時は fuzzy にフォールバック）。

### 次アクション（別タスク）
- `@huggingface/transformers@4` への移行を検討（API 差分の確認、embed-worker / pre-download / download-model の更新、モデルキャッシュ互換）。完了すれば protobufjs/onnx-proto/onnxruntime-web の audit 指摘は一括解消する見込み。

関連: [[project_hollow_tests]]（テスト基盤）、download-model は checksum 無し（別途・低 severity）。
