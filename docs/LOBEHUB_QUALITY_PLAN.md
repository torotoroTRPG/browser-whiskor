# LobeHub 品質スコア改善プラン

> ステータス: **プランニング段階（未着手）**。本ドキュメントは「次セッションで実装計画を立てる」ための文脈まとめ。
> 記録日: 2026-06-23 / 対象: https://lobehub.com/mcp/torotorotrpg-browser-whiskor

## 1. 状況

browser-whiskor を GitHub に `mcp-server` タグ付きで push したところ、LobeHub の MCP ディレクトリに自動登録され、自動レビューロボットに **33/100点（必須項目 2/4）** で「品質が悪い（機能が不完全または低品質）」と表示された。

ユーザーの所感: これは多分に **品質そのものより「体裁（presentation）」の問題**。特に「スキルが無い」判定は、本プロジェクトの優れた設計（動的ツールロードでトークン節約）が裏目に出てロボットに誤認されている可能性が高い。とはいえ、これを機に**本気で（フルリソースで）質の向上を目指す**方針。

## 2. レビュー結果（2026-06-23 時点の記録）

スコア **33/100（33%）**、必須項目 **2/4**。

| 項目 | 判定 | 種別 |
|---|---|---|
| 検証済み（install/quality/reliability を LobeHub が検証） | ✗ 未 | 必須 |
| 少なくとも1つのインストール方法 | ✓ | 必須 |
| 少なくとも1つのスキル | ✗ 未 | 必須 |
| README.md がある | ✓ | — |
| ユーザーフレンドリーなインストール方法 | △ 部分 | — |
| ライセンス取得済み（MIT） | ✓ | — |
| 注意喚起（prompts でユーザーと対話） | △ 部分 | — |
| リソース（context データの添付/管理） | △ 部分 | — |
| 所有者による確認 | △ 未（GitHub バッジで証明可能） | — |

必須の落ち2件 = **「検証済み」** と **「少なくとも1つのスキル」** がスコアを大きく下げている。

## 3. 原因分析（項目別）

### 3a. 「少なくとも1つのスキル」✗ ← 最重要・体裁問題
LobeHub のロボットは MCP 接続直後に `tools/list` を要求し、ツール数を機械的に数える。browser-whiskor は **動的プロファイル**（常時公開は core 17 ツールのみ、残りは必要時にロード。`server/tool-manager.js` の `ALWAYS_VISIBLE_TOOLS` ＋ `mcpServer.staticTools`）でトークンを節約する設計のため、ロボットが覗いた瞬間はツール一覧が**空または極端に少なく**見えている可能性が高い。

- 既存の逃げ道: `mcpServer.staticTools: true`（または `--static-tools`）で全プロファイルを常時公開できる（`tools/list` を一度しか取らないクライアント向け、と CLAUDE.md に既述）。
- ただし **localhost のローカルサービス**なので、LobeHub が実際に起動・接続して `tools/list` を取れているのかは不明（取れず静的解析の可能性もある）。要確認。LobeHub は `…/skill.md` を参照する素振りがある＝スキル宣言ファイルを期待している可能性。

### 3b. 「リソース」△ / 「注意喚起(prompts)」△ ← 実機能の未宣言
サーバーが宣言している MCP capabilities は **`{ tools: { listChanged: true } }` のみ**（`server/mcp/transport.js` 115行目）。MCP の `resources` / `prompts` プリミティブを宣言していないため、この2項目が「部分」止まり。これは体裁でなく**実装で flip できる本物の余地**。

### 3c. 「所有者による確認」△ ← バッジで即解決可能
LobeHub の GitHub バッジ（`[![MCP Badge](https://lobehub.com/badge/…)]`）を README.md に貼れば所有権を証明できる。**最小コストの quick win**。バッジの正確な markdown は LobeHub のページからコピーが必要（URL を勝手に推測しない）。

### 3d. 「検証済み」✗ ← LobeHub 側の検証
install/quality/reliability を LobeHub が検証する項目。他項目の改善（バッジ・スキル可視化・インストール体験）が揃うと自動で改善する見込み。直接いじれる対象ではない。

### 3e. 「ユーザーフレンドリーなインストール」△
現状 README は手動 unpacked 読み込み＋`whk setup`。`whk setup` の TUI 経路は十分フレンドリーだが、ロボットには伝わっていない可能性。README の導線整理で改善余地。

## 4. 中心的なジレンマ：動的ツール vs ディレクトリのツール数カウント

本プロジェクトの**思想（トークン節約のための動的ロード）**と、**ディレクトリ評価（接続時の tools/list を数える）**は本質的に衝突する。和解案の候補（次セッションで判断）:

1. **何もしない（体裁無視）** — スコアは低いままだが設計は曲げない。記録だけ残す。
2. **skill.md / マニフェストを用意** — LobeHub が静的に読む宣言ファイルで「スキルがある」ことを示す。設計を曲げずに体裁を満たせる可能性。実機検証要。
3. **配布/ディレクトリ向けプロファイルの明示** — README とインストール手順で「ディレクトリ評価や一度だけ list するクライアントは `--static-tools` を使う」と明示し、ロボット用の起動コマンドを提示。
4. **静的公開をデフォルト化** — 設計思想に反するので不採用寄り（[[project_namespace_map_ai_verification]] の文脈とも整合させる）。

## 5. 改善ロードマップ（優先度順・効果/コスト付き）

**Quick wins（低コスト・体裁）**
- [x] (3c) LobeHub バッジを README.md に追加 → 「所有者確認」flip（2026-06-23、`README.md` タイトル直下。画像URL `lobehub.com/badge/mcp/torotorotrpg-browser-whiskor` を curl で 200/SVG 確認済）
- [ ] (3e) README のインストール導線を整理（`whk setup` の容易さを前面に）

**Medium（実装・本物の機能 flip）**
- [x] (3b) MCP `resources` capability を宣言・実装 → 「リソース」flip（2026-06-23、`server/mcp/resources.js`。`whiskor://sessions` ＋ `whiskor://session/{tabId}`、proxy/standalone 両対応、stdio 実機で 6 リソース確認済）
- [x] (3b) MCP `prompts` capability を宣言・実装 → 「注意喚起/prompts」flip（2026-06-23、`server/mcp/prompts.js`。investigate_tab / debug_errors / find_and_act / explain_change / map_states の5本）
- [ ] (3a) `skill.md` か同等のスキル宣言を用意し、LobeHub のスキル検出を満たす（実機で tools/list の取得有無を先に確認）

**要調査/設計判断**
- [ ] LobeHub が実際にサーバーを起動して tools/list を取るのか、静的解析なのかを確認（ローカルサービス扱いの挙動）
- [ ] 動的ツール思想を曲げずに「スキルあり」を示す最良の手段の決定（§4 の選択肢）
- [ ] (3d) 上記が揃った後に LobeHub 側の再検証をトリガー（メタデータ更新ボタン）

## 6. 次セッションへの引き継ぎ事項（ユーザー入力待ち）
- LobeHub バッジの正確な markdown（README 用）
- §4 のジレンマでどの和解案を採るか
- `resources` / `prompts` で公開する具体内容の優先順位

---
関連メモ: [[project_repo_skills]]（skills/ の位置づけ）、[[project_github_repo_tidy]]（About/topics 整備の TODO）、[[project_namespace_map_ai_verification]]（ツール保存/提示の分離思想）。
