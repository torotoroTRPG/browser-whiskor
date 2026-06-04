# Debug-focused dashboard (default look)

**Status:** idea / exploratory (2026-06-04) — low priority, no real harm in waiting.

## 概要

現行ダッシュボード（`server/dashboard.html`）は機能的には現実装と整合しているが、レイアウトが
やや「製品画面」寄りで dev 感が薄い。**機能はそのままに、使いやすさ・デバッグしやすさだけを
突き詰めた見た目**を別に用意し、それを**初期値の見た目**にしたい。現行はレガシーとして残す。
config で切り替え可、もしくは追加スタイルとして同梱でも良い。レイアウトから大きく変える＝
実質「新規で作る」くらいの気持ちでよい。

## 方向性（粗）

- **情報密度の高い dev レイアウト**: 等幅・コンパクト・キーボード操作前提。製品的な余白より
  一覧性。
- **機能は据え置き**: セッション一覧 / config / アクション / 自己診断 / ステートグラフ等、今ある
  ものはそのまま。見た目と操作導線だけ刷新。
- **現実装の新機能も surface**（今のダッシュボードが未掲載のもの）: secret-guard 状態
  （`/health` が既に返す `secretGuard{active,...}`）、packed-SoM / per-element サムネイル
  （[[project_packed_som_capture]]）、source-upload（[[project_source_upload_correlation]]）。
- **切替**: `config` のテーマ指定 or 別ルート（例 `/?ui=debug`）。現行は `legacy` として保持。
- 将来は [[project_image_asset_correlation]] の in-view 画像サムネ等もここに載せうる。

## 現行ダッシュボードの所見（2026-06-04 レビュー）

- 使用 API（`/api/sessions`・`/api/config`・`/api/action`・`/api/gather`・`/api/screenshot`・
  `/api/graphs`・`/health`・`/states`・`/profiles`・`/tools`・`/raw/delta/*`）は**すべて現存**＝
  壊れていない。プラグインIDのトグルも実 injected プラグインと一致。
- 未掲載なだけの新機能: secret-guard 状態 / packed-SoM / element サムネイル / source-upload。
- 軽微: `config-loader.js` の `getDefaults()` のプラグイン名が一部古い（`vue3`/`css-analyzer`/
  `perf-analyzer` → 実体は `vue3-devtool`/`css-analysis`/`perf-observer`）。getDefaults は
  config.json 読込失敗時のみのフォールバックなので影響は小。直すなら一行。

## 未決

- 新 UI を別ファイルにするか、同一ファイル内テーマ切替か。
- panel（DevTools パネル）側にも同じ dev テーマを波及させるか。
- 「初期値を debug 見た目に」する際、既存ユーザーの体験変化をどう扱うか（初回のみ案内等）。
