# MiniLM を click(text:) に統合する提案

**Status:** design / proposed (2026-06-17 reframe)

## 現状（コードで確認済み）

- `click(text: "送信")` はサーバーを通さず、extension の `executor.js` 内
  `findByText()`（`shared/injected/executor.js:213`）で解決される
- マッチングは**文字列ベースのみ**: exact(1.0) > prefix(0.85) > 単語境界(0.70)
  > 部分一致(0.55)。クライアント完結で速い／オフラインでも動く
- MiniLM（意味マッチ）は `find_target` と `get_text_coords(match:)` でのみ使われ、
  click には未適用（`write.js` の click handler に embed/MiniLM の経路なし）

## これは「欠けている機能」ではない — 人間工学の改善

agent には既に `find_target`（MiniLM で text→要素を解決）がある。「送信」で
`Submit`/`確定` を当てたいなら `find_target` → `click(x,y)` の2ステップで*既に可能*。
本提案の価値は **その2ステップを `click(text:)` 1回に畳む便利化**であって、
無い能力の追加ではない。→ **優先度は低め**。緊急のギャップ埋めではない。

## 設計の肝はフロー — client-first、miss時だけ server

素朴に「`click(text:)` を server で受けて MiniLM」にすると、**文字列マッチで一発で
当たる大多数のケースでも毎回 WS往復＋MiniLM レイテンシを払う**。click が今
クライアント完結で速い利点を潰す。これは避ける。

正しい既定は **escalation-on-miss**:

1. extension の `findByText()` を**まず実行**（従来通り、ゼロ追加コスト）
2. 高信頼マッチ（例: スコア ≥ 0.70 = 単語境界以上）が取れたら**そのまま実行**
3. **取れなかったときだけ** server に意味解決を依頼 → MiniLM バッチスコアリングで
   座標/セレクタを確定 → extension へ dispatch
4. MiniLM unavailable なら従来の文字列マッチ結果をそのまま使う（後方互換）

これで常用パス（明確なラベル）は速いまま、表記ゆれ（「送信」↔`Submit`/`確定`、
「search」↔`検索`/`探す`）だけ意味マッチに落ちる。レイテンシ評価がこの提案の主役:
miss時のみ発生する数十ms が許容範囲か、を実測で確かめるのが着手の前提条件。

## 実装メモ

### escalation 経路（新規）
- `executor.js findByText()` の戻りに**ベストスコアを含める**（既にスコア計算済み）。
  閾値未満なら `{ needsSemantic: true, text }` を server に返す経路を足す
- server 側（`write.js` の click handler、または executor のブリッジ受け口）で
  `find_target` 相当の MiniLM スコアリングを実行し、解決済み selector/座標を
  extension に返して click を継続。最新の ui-catalog + text-coords を使い回す
  （その場で軽量収集 or 既存データ）

### バイパス条件
- ユーザーが selector / x,y を明示した場合は MiniLM を通さない
- findByText が高信頼マッチを返した場合も通さない（上記2）

### 注意点
- レイテンシは **miss時のみ**発生する設計にすること（server-first にしない）
- `find_target` のスコアリング基盤（`read-helpers.fuzzyScore` + `embed-service`）を
  再利用し、click 用に別実装を作らない

## 関連
- `docs/ideas/MULTILINGUAL_INTENT_AND_SCOPED_SEARCH.md` — 多言語インテント＋
  スコープ検索。本提案は「意味マッチを操作系へ広げる」一部。
- `find_target` / `get_text_coords(match:)` — 既存の MiniLM 利用箇所（再利用元）。
