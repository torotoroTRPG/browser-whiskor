# 音声操作 ＋ agent 通知（トースト）— 人↔agent の双方向チャネル

**Status:** 構想 / 設計検討（2026-06-23）
**関連:** 理想機能メモ 項目11（ユーザー協調操作モード observe + co-pilot）、[[project_per_tool_intent_layer]]

co-pilot（人と agent が同じブラウザを協調操作するモード）を、入力と出力の2方向に拡張する案。
2つは独立に着手できるが、どちらも「人と agent の間のチャネル」という点で同じ土台に乗る。

- **入力（人 → agent）**: 音声でブラウザ操作を指示する（STT）。
- **出力（agent → 人）**: agent がトースト通知を鳴らせる。TTS（読み上げ）は同じ出力方向の発展形だが優先度低。

---

## Part A — 音声操作（STT, 人 → agent）

### 狙い
co-pilot 中に、人がキーボードでなく声で「次はログインボタンを押して」「この表をCSVにして」のように指示できるようにする。
手が塞がっている／画面を見ながら喋りたい場面の入力チャネル。

### STT エンジンの選択肢（OCR と同じ "bring-your-own" 方針が馴染む）

| 方式 | 長所 | 短所 |
|---|---|---|
| **Web Speech API**（ブラウザ内蔵 `webkitSpeechRecognition`） | ゼロ依存・即動く・拡張側だけで完結 | 精度/言語が環境依存、Chrome は実質クラウド送信、オフライン不可、Firefox 未対応 |
| **Whisper 系をローカル実行**（whisper.cpp / faster-whisper を別バイナリ） | 高精度・多言語・オフライン・プライバシー | バイナリ持ち込みが必要（OCR の Tesseract と同じ扱い）、音声の受け渡し経路が要る |
| **Whisper クラウド API**（OpenAI 等） | 最小実装で高精度 | 音声を外部送信（プライバシー）、課金、ネット必須 |

OCR（`ocr_region`）で確立した **bring-your-own バイナリ**パターン（`binPath` → 環境変数 → PATH で解決、無ければ無害に `unavailable`）をそのまま流用できる。
既定は Web Speech API（ゼロ依存で試せる）、本気で使う人はローカル Whisper を挿す、という二段が現実的。

### 「このアプリから agent を発火できるのか？」という核心の問い

ここが一番の論点。MCP（stdio）のモデルでは **agent 側が能動・サーバ側は受動**で、サーバから agent へ割り込みで指示を送る経路は無い。つまり whiskor が音声を拾っても、それを「agent に喋らせて発火」させる標準経路は存在しない。現実的な選択肢は3つ:

1. **agent がポーリングする（pull / MCP の枠内で完結・推奨の第一歩）**
   whiskor は音声を STT して「保留中の音声コマンド」キューに積むだけ。agent は co-pilot ループの各ターンで `get_voice_commands`（ツール）または `whiskor://voice-queue`（MCP resource）を読みに来る。
   - 長所: whiskor だけで完結。既に実装した resources/prompts プリミティブと相性が良い。item 11 の observe チャネルと同じ「人の動きを agent が読みに行く」形。
   - 短所: agent がループしている前提（Claude Code の /loop 等）。喋ってから次のポーリングまでのレイテンシ。

2. **ホスト側が発火する（push / whiskor の外）**
   音声検出 → ホスト（Claude Code / Curster 等）にプロンプト注入。これは**ホストの責務**で whiskor の管轄外。whiskor は STT 結果を HTTP/stdout で出すだけにして、発火は外部スクリプト（例: Claude Code の hook やループ）に委ねる。
   - 長所: 真の「声で発火」。 短所: whiskor 単体では完結せず、ホスト依存の配線が要る。

3. **ハイブリッド**: whiskor は (1) のキュー＋ resource を提供しつつ、`docs/skills` 的に「ホストでこう配線すると push になる」レシピを同梱する。

→ **方針**: まず (1) の pull を whiskor 内に作る（最小・自己完結・テスト可能）。(2) は別レイヤのレシピとして後段。"アプリが agent を発火" は whiskor の責務外と割り切るのが筋が良い。

### intent との接続
生テキストをそのまま渡すより、[[project_per_tool_intent_layer]] / MiniLM の軽量分類で「click 指示／読み取り依頼／ナビゲーション」程度に粗く仕分けして渡すと、agent 側の解釈が安定する（任意・後段）。

---

## Part B — agent 通知（トースト, agent → 人）

### 狙い
agent が人に「終わった」「確認して」「ここで判断が要る」を**音や視覚で**知らせる。
今は agent の出力はホストのチャット欄に出るだけで、画面（ブラウザ）を見ている人には届かない。トーストはその隙間を埋める軽い出力チャネル。

### 出し方の選択肢
- **`chrome.notifications`**（拡張のOS通知）: 画面外でも気づける。権限が要る。
- **ダッシュボード/ページ内トースト**: whiskor のダッシュboardや content script でその場に出す。OS通知より軽いが、その画面を見ていないと気づかない。
- **TTS（読み上げ）**: 同じ出力方向の発展。Web Speech `speechSynthesis` でゼロ依存。**優先度低**（人によっては煩い／場面を選ぶ）。

### 「専用 MCP を割り当てるか？」という問い
通知のためだけに別 MCP を立てるのは過剰に見える。むしろ2つの出し方を併存させたい:

1. **agent 経由（ツール）**: 既存 whiskor MCP に小さな `notify`（toast）ツールを1つ足す（専用プロファイル or core 隣接）。agent が明示的に鳴らす。
2. **agent を介さない決定論的通知（設定）**: 「アクション失敗時」「navigate 完了時」「config 変更時」などのイベントで whiskor が自動でトーストを出す。これは config の**通知設定**（`notifications.rules`）として宣言的に書ける＝ agent がいてもいなくても動く。

→ **方針**: 専用 MCP は作らない。「agent が鳴らす1ツール」＋「決定論的な通知ルール（config）」の2本立て。"介しても介さなくても" の両対応はこの形で満たせる。トーストは「あってもいい」レベルなので小さく。TTS は後回し。

---

## まとめ（優先度と着手順）
- **トースト（Part B）**: 小さく価値が出る。`notify` ツール1つ＋ config 通知ルールから。低〜中。
- **音声入力（Part A）**: pull キュー＋ resource を Web Speech API で最小実装 → ローカル Whisper を bring-your-own で。co-pilot（item 11）と一体で効く。中・やや複雑。
- **TTS**: 低（後回し）。
- "アプリが agent を発火" は whiskor の責務外（ホスト側レシピ）と整理。

> 補足: 機能の分け方（plugin / component 単位での切り出し）は別途の整理対象。ここでは触れない。
