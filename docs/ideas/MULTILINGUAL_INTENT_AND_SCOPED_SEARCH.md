# 多言語UIラベル意図分類 & スコープ付き検索

> ステータス: IMPLEMENTED / 実装済み
> 作成: 2026-05-27
> 配置先: `docs/ideas/MULTILINGUAL_INTENT_AND_SCOPED_SEARCH.md`

---

## 0. なぜこれが必要なのか（背景と動機）

### 0-1. ポップアップの自動クローズ問題

`clickability.js` の `autoUnblockPipeline` は、モーダルや通知バナーが
agentの操作を妨害しているとき、3ステップで自動除去を試みる。

```
Step 1: CLOSE_BUTTON_SELECTORS にマッチするボタンをクリック
Step 2: Escape キーをディスパッチ
Step 3: バックドロップをクリック
```

Step 1 が依存している `CLOSE_BUTTON_SELECTORS` は現在これだけ：

```js
const CLOSE_BUTTON_SELECTORS = [
  '[aria-label*="close" i]', '[aria-label*="閉じる"]',
  '[data-dismiss]',
  'button.close', '.modal-close', '.dialog-close',
  '.MuiDialogTitle button',
];
```

これはCSSセレクタの静的リストであり、以下のようなケースで失敗する：

- `「완료」` `「あとで」` `「×」だけのアイコンボタン` `「No Thanks」` `「Dismiss」`
- MUI 以外のデザインシステムが使うカスタムクラス名
- Tailwind 等で生成されたランダムなクラス名

結果として `fixResult: 'all_steps_failed'` になり、agentは別の手段を探すしかない。

### 0-2. UIラベル検索のクロス言語問題

`get_text_coords(match: "閉じる")` がスコア 0 を返す。
`get_ui_catalog(search: "완료")` が空を返す。

これは機能のバグではなく、`read-helpers.js` の `bigramSet` に入っている
**正規化バグが原因**で、CJK文字が全て削除されている（詳細は §1）。

agentが「このモーダルの閉じるボタンを探して押す」という操作をするとき、
検索段階で既に詰んでいる。

### 0-3. 「汚部屋の法則」とminScoreの問題

agentは `minScore` を `0.05` に下げて広い網を張ることがある。
しかし一度変えると自分では戻さない（これを「汚部屋の法則」と呼ぶ：
agentは変更を加えた状態に自然と留まり続ける）。

後続のターンで `minScore: 0.05` が残ったまま全検索が走り、
ノイズだらけのレスポンスが返ってくる。ソフト側がお片付けをする必要がある。

### 0-4. 全DOM検索のノイズ問題

`get_text_coords` / `get_ui_catalog` は常に全DOMを対象とする。
agentが「このフォームの中の送信ボタン」を探しているとき、
ページ別の場所にある同名の「送信」「Submit」がノイズとして混入する。

検索対象を絞れれば探索効率が上がり、誤クリックも減る。

---

## 1. 前提条件：`bigramSet` のCJKバグ修正

**この修正は他の全機能の前提条件。先行して対処する。**

### 1-1. バグの所在

`server/mcp/tools/read-helpers.js` の `bigramSet` 関数：

```js
// 現行コード（バグあり）
function bigramSet(str) {
  const s = str.toLowerCase().replace(/[^\w\s]/g, '').trim();
  //                                    ^^^
  //  JavaScriptの \w は [A-Za-z0-9_] のみ（ASCIIのみ）
  //  → CJK・ハングル・アラビア文字 etc. は全て削除される
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
  return set;
}
```

#### 影響を受ける処理の連鎖

```
bigramSet("閉じる")
  → replace(/[^\w\s]/g, '') で "" になる
  → バイグラム集合: {}（空）
  → jaccard({}, anySet) = 0
  → fuzzyScore("閉じる", "閉じる") ≠ 1.0  ← 同一文字列なのにスコア0

影響範囲:
  get_text_coords(match: "閉じる")    → 常にスコア 0 → 空の結果
  get_text_coords(match: "완료")      → 常にスコア 0 → 空の結果
  get_ui_catalog(search: "キャンセル") → search は substring なので一応動く
                                        が match モードは壊れている
```

### 1-2. 修正（1行）

```js
// 修正後
function bigramSet(str) {
  // \p{L} = あらゆる言語の文字（Unicode Letter）
  // \p{N} = あらゆる言語の数字（Unicode Number）
  // u フラグ = Unicode モード（\p{} プロパティが使えるようになる）
  const s = str.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
  return set;
}
```

`u` フラグは ES2015+、`\p{L}` は ES2018+。Node.js 10+ で動作する。
whiskor の package.json に Node.js 最低バージョン制約はないが、
`ws@^8` が Node.js 10+ を要求しているため実質問題ない。

### 1-3. 合わせて修正: `tokenize` 関数

```js
// 現行（同じバグ）
function tokenize(str) {
  return (str || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
}

// 修正後
function tokenize(str) {
  return (str || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
}
```

### 1-4. 修正後の動作確認

```
fuzzyScore("閉じる", "閉じる") → 1.0  (exact include hit)
fuzzyScore("close",  "閉じる") → 0.0  (文字体系が違うので当然。辞書で補う)
fuzzyScore("閉じ",   "閉じる") → 0.67 (バイグラム部分一致)
fuzzyScore("cancle", "cancel") → 0.76 (タイポ補正。従来通り動作)
```

クロス言語（"close" ↔ "閉じる"）がスコア 0 になるのは修正後も同じ。
これは本仕様の意図分類器（§2）がアンカー辞書で補う設計になっている。

---

## 2. 機能A: 多言語UIラベル意図分類器

### 2-1. 設計方針

#### 解きたい問題を一言で

同じ「閉じる」という意図を表すラベルが、言語・文化・実装者によって
無数の表記で届く。これを翻訳APIも生成AIも使わず、
**辞書 + 文字統計量アルゴリズムで動的にインテントカテゴリへマッピングする。**

```
入力（任意言語）    →  インテント + 信頼スコア
"nothanks"         →  DECLINE  / 0.87
"後で"             →  SKIP     / 0.92
"완료"             →  COMPLETE / 1.00
"cancle"           →  CANCEL   / 0.83  (タイポ許容)
"×"               →  DISMISS  / 0.71  (アイコン推定)
```

#### バックエンド設計：辞書とMiniLMの両立

本仕様では **辞書バックエンドとMiniLMバックエンドの両方を実装し、config で切り替え可能にする**。
どちらを使うかは `searchClassifier.backend`（§2-7）で制御する。

**辞書バックエンド（`"dictionary"`）**:
- 外部依存ゼロ・起動即時・バンドルサイズ増なし
- CJKバグ修正（§1）後はアンカー語と同言語圏の表記揺れを正確にカバー
- クロス言語の橋渡しはアンカー辞書が担う（§2-3 参照）

**MiniLMバックエンド（`"minilm"`）**:
- `paraphrase-multilingual-MiniLM-L12-v2`（~120MB ONNX、`@xenova/transformers` 経由）
- アンカー語のメンテなしで50言語以上のクロス言語対応
- 起動時に全アンカー語を一括 embed → リクエスト時は ~2〜10ms/件（CPU）
- intent分類だけでなく fuzzy match / didYouMean でもネイティブに使える（§9-4, §9-5）

デフォルトは `"auto"`：MiniLMが利用可能なら使い、なければ辞書にフォールバック。
MiniLM の実装詳細は §9、使用箇所の一覧は §9-6 を参照。

### 2-2. インテントカテゴリ定義

アンカー語は `server/configs/intent-anchors.json` に外出しする（§2-4参照）。
主要カテゴリと代表的なアンカー語：

| インテント   | 代表アンカー語（一部）                                    |
|-------------|----------------------------------------------------------|
| `DISMISS`   | close, dismiss, quit, exit, 閉じる, 閉める, 消す, 닫기, 關閉 |
| `CONFIRM`   | ok, okay, confirm, yes, はい, 確認, 동의, 확인, agree     |
| `CANCEL`    | cancel, no, abort, キャンセル, 취소, いいえ, nope         |
| `COMPLETE`  | done, finish, complete, submit, 完了, 終わる, 완료, 提交  |
| `DECLINE`   | no thanks, nothanks, 後で結構, 不要, 괜찮아요            |
| `SKIP`      | skip, later, not now, スキップ, あとで, 건너뛰기, 나중에  |
| `BACK`      | back, return, previous, go back, 戻る, 前へ, 뒤로        |
| `NAVIGATE`  | next, continue, proceed, 次へ, 進む, 다음, 次步          |

### 2-3. アルゴリズム（3ステップパイプライン）

```
Step 1: 正規化
  - Unicode NFC正規化（文字の等価な異なる符号化を統一）
  - 小文字化
  - 空白・句読点除去（ただし文字・数字はUnicode全体を保持 ← §1の修正と同じ）
  - 例: "No Thanks!" → "nothanks"
       "완 료"       → "완료"
       "閉 じ る"    → "閉じる"

Step 2: Exact match
  - 正規化済み入力を、全インテントの正規化済みアンカー語と完全一致比較
  - ヒット → confidence 1.0 で即返す（O(n)、nはアンカー語総数）
  - ヒットしなければ Step 3 へ

Step 3: Fuzzy match（2段スコアのブレンド）

  a) 文字バイグラム Jaccard 類似度（§1修正後の bigramSet を使用）
       bigramSim = |A ∩ B| / |A ∪ B|
       → 表記揺れ・部分一致に強い
       → 同一スクリプト圏内では高精度

  b) Levenshtein 正規化距離
       editDistSim = 1 - (editDist(q, t) / max(|q|, |t|))
       → タイポや短い単語に強い

  combined = bigramSim × 0.6 + editDistSim × 0.4

  全インテントの全アンカー語と比較。
  インテントごとに最高スコアを集計し、全体の最高スコアのインテントを返す。
  最高スコア < intentThreshold（デフォルト 0.35）→ UNKNOWN

```

#### クロス言語マッチの仕組み

`bigramSim("close", "閉じる")` は文字体系が違うので 0 になる。
これはアルゴリズムが解決する問題ではなく、アンカー辞書が解決する：

```
DISMISS のアンカーリストに "close" も "閉じる" も "닫기" も書いてある
  ↓
"close"  → 英語アンカーとexact match → DISMISS / 1.0
"閉じる" → 日本語アンカーとexact match → DISMISS / 1.0
"닫기"   → 韓国語アンカーとexact match → DISMISS / 1.0
"clsoe"  → fuzzy match "close" 0.81 → DISMISS / 0.81 (タイポ補正)
```

アルゴリズムが橋渡しするのは**同一言語内の表記揺れ**。
**言語間の橋渡しはアンカー辞書が担う**。この分離が設計の核心。

### 2-4. `intent-anchors.json`（新規ファイル）

`server/configs/intent-anchors.json` に外出しする。
将来の言語追加・アンカー追加をコード変更なしで行えるようにする。

```json
{
  "_comment": "意図分類アンカー語辞書。各言語ごとに10〜20語が目安。",
  "_comment_fuzzy": "辞書にない表現はfuzzyマッチが吸収する。",
  "DISMISS": [
    "close", "dismiss", "quit", "exit",
    "閉じる", "閉める", "消す", "終了",
    "닫기", "닫다",
    "关闭", "關閉",
    "fermer", "cerrar", "schließen"
  ],
  "CONFIRM": [
    "ok", "okay", "yes", "confirm", "agree", "accept",
    "はい", "確認", "了解", "わかった", "オーケー",
    "확인", "동의", "예",
    "确认", "好的"
  ],
  "CANCEL": [
    "cancel", "no", "abort", "nope",
    "キャンセル", "いいえ", "中止",
    "취소", "아니오",
    "取消"
  ],
  "COMPLETE": [
    "done", "finish", "complete", "submit", "send", "apply",
    "完了", "終わる", "送信", "提出", "決定",
    "완료", "제출",
    "完成", "提交"
  ],
  "DECLINE": [
    "no thanks", "nothanks", "skip for now", "not interested",
    "後で結構", "不要", "結構です",
    "괜찮아요", "나중에",
    "不用了"
  ],
  "SKIP": [
    "skip", "later", "not now", "remind me later", "maybe later",
    "スキップ", "あとで", "後で", "今はいい",
    "건너뛰기", "나중에",
    "跳过"
  ],
  "BACK": [
    "back", "return", "previous", "go back",
    "戻る", "前へ", "前の画面", "前に戻る",
    "뒤로", "이전",
    "返回"
  ],
  "NAVIGATE": [
    "next", "continue", "proceed", "forward",
    "次へ", "進む", "続ける",
    "다음", "계속",
    "下一步", "继续"
  ]
}
```

### 2-5. 実装場所

#### `server/mcp/tools/read-helpers.js` への追加

`fuzzyScore` と同じファイルに `classifyIntent` を追加する。
これにより `read-basic.js` / `read-data.js` から共通で使える。

```js
// server/mcp/tools/read-helpers.js に追加

const fs   = require('fs');
const path = require('path');

// ── Intent classifier ─────────────────────────────────────────────────────────

let _anchors = null; // 起動後初回呼び出し時にロード

function loadAnchors() {
  if (_anchors) return _anchors;
  try {
    const p = path.join(__dirname, '../../configs/intent-anchors.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // コメントキーを除いて正規化済みエントリに変換
    _anchors = {};
    for (const [intent, words] of Object.entries(raw)) {
      if (intent.startsWith('_')) continue;
      _anchors[intent] = words.map(w => normalizeLabel(w));
    }
    return _anchors;
  } catch (e) {
    // ファイルが読めなくても crash させない
    _anchors = {};
    return _anchors;
  }
}

function normalizeLabel(str) {
  // NFC正規化 → 小文字化 → 句読点除去（Unicodeプロパティ対応）
  return (str || '').normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, '')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function intentFuzzyScore(q, t) {
  if (t === q) return 1.0;
  if (t.includes(q) || q.includes(t)) return 0.95;
  const qBi = bigramSet(q); // 既存の bigramSet を使う
  const tBi = bigramSet(t);
  const bSim = jaccard(qBi, tBi);       // 既存の jaccard を使う
  const maxLen = Math.max(q.length, t.length) || 1;
  const eSim = 1 - levenshtein(q, t) / maxLen;
  return Math.round((bSim * 0.6 + eSim * 0.4) * 1000) / 1000;
}

/**
 * UIラベルテキストを意味的インテントに分類する。
 * @param {string} label - 任意言語のUIラベル
 * @param {number} threshold - スコアの下限（デフォルト 0.35）
 * @returns {{ intent: string, confidence: number, topAnchor: string } | null}
 */
function classifyIntent(label, threshold = 0.35) {
  const anchors = loadAnchors();
  const normalized = normalizeLabel(label);
  if (!normalized) return null;

  let best = { intent: 'UNKNOWN', score: 0, anchor: '' };

  for (const [intent, words] of Object.entries(anchors)) {
    for (const anchor of words) {
      const score = intentFuzzyScore(normalized, anchor);
      if (score > best.score) {
        best = { intent, score, anchor };
      }
      if (score >= 1.0) break; // Exact match。これ以上探す必要なし
    }
  }

  if (best.score < threshold) return null;
  return { intent: best.intent, confidence: best.score, topAnchor: best.anchor };
}

module.exports = { tokenize, bigramSet, jaccard, fuzzyScore, classifyIntent, withFreshness };
```

### 2-6. `clickability.js` への統合

`autoUnblockPipeline` の Step 1（closeButton検索）に意図分類を後段追加する。
**既存のCSSセレクタ照合が成功したら即終了**（既存の挙動を一切変えない）。
CSSセレクタが拾えなかった場合だけ意図分類のフォールバックが走る。

#### 統合箇所

```js
// extension/injected/analyzers/clickability.js
// classifyObstructor() 内の closeButton 検出部分

// ── 既存 Step 1: CSSセレクタによる探索（変更なし）──
for (const sel of CLOSE_BUTTON_SELECTORS) {
  try {
    const btn = searchRoot.querySelector(sel);
    if (btn) {
      closeButtonSelector = computeSelector(btn);
      hasCloseButton = true;
      break;
    }
  } catch (_) {}
}

// ── 追加 Step 1b: 意図分類による探索（CSSセレクタが失敗したときのみ）──
if (!hasCloseButton) {
  const autoUnblockIntentThreshold = 0.60; // config から取る場合は後述
  const candidates = searchRoot.querySelectorAll('button, [role="button"], a');
  for (const btn of candidates) {
    const labelText = (
      btn.textContent?.trim() ||
      btn.getAttribute('aria-label') ||
      btn.getAttribute('title') ||
      ''
    ).slice(0, 40); // 長すぎるテキストは判定しない

    if (!labelText) continue;

    const result = window.__SI_CLASSIFY_INTENT__?.(labelText, autoUnblockIntentThreshold);
    if (result && (result.intent === 'DISMISS' || result.intent === 'CANCEL')) {
      closeButtonSelector = computeSelector(btn);
      hasCloseButton = true;
      closeButtonIntentScore = result.confidence; // レポートに含める
      break;
    }
  }
}
```

`classifyIntent` はサーバー側の Node.js 関数のため、
ブラウザ拡張側（MAIN world）では別途ポータブルな実装が必要。

#### ブラウザ側への展開方針

```
方針 A: 共有モジュールとして実装し、
        extension/injected/ に同梱する
        → 辞書ファイルもバンドルする必要あり

方針 B: サーバー側で意図分類した結果を
        ブラウザ側にプッシュして活用する
        → clickability.js の変更は最小

推奨: 方針 A（拡張機能はオフライン動作が前提）
     intent-anchors.json を extension/injected/lib/intent-anchors.json に
     コピーし、classifyIntent の軽量版を extension/injected/lib/intent-classifier.js
     として実装する。サーバー側と辞書を共有することで整合性を保つ。
```

### 2-7. config.json への追加

既存の `intelligence` セクションに `searchClassifier` を追加：

```json
"intelligence": {
  "clickability": { ... },
  "cssOrigin":    { ... },
  "searchClassifier": {
    "_comment_ja": "UIラベル意図分類器 + 意味検索の設定",
    "enabled": true,
    "intentAnchorFile": "configs/intent-anchors.json",
    "intentThreshold": 0.35,
    "autoUnblockIntentThreshold": 0.60,
    "_comment_autoUnblock_ja": "autoUnblockPipeline で意図分類を使うときのスコア下限。intentThreshold より高めにする",

    "backend": "auto",
    "_comment_backend_en": "Semantic backend: 'dictionary' = anchor dict + algorithm only (zero deps). 'minilm' = MiniLM only. 'auto' = use MiniLM if available, fall back to dictionary.",
    "_comment_backend_ja": "意味処理のバックエンド。'dictionary'=辞書+アルゴリズムのみ。'minilm'=MiniLMのみ。'auto'=MiniLMが使えれば使い、なければdictionaryへフォールバック",

    "miniLM": {
      "_comment_ja": "backend が 'minilm' または 'auto' のときのみ参照される",
      "model": "paraphrase-multilingual-MiniLM-L12-v2",
      "modelCacheDir": ".model-cache",
      "downloadOnStart": true,
      "_comment_download_ja": "trueにすると起動時にモデルを自動DL（初回のみ）。falseにするとモデルが存在しないときdictionaryにフォールバック",
      "fallbackToDictionary": true,
      "_comment_fallback_ja": "モデルのロードに失敗したとき、エラーを出さずdictionaryバックエンドに切り替える",
      "useFor": {
        "_comment_ja": "MiniLMを使う機能を個別に制御できる",
        "intentClassification": true,
        "_comment_intent_ja": "classifyIntent() — UIラベルのインテント判定",
        "fuzzyMatch": true,
        "_comment_fuzzy_ja": "get_text_coords(match:) / get_ui_catalog(search:) のfuzzy検索をMiniLMのコサイン類似度で行う",
        "suggestions": true,
        "_comment_suggestions_ja": "didYouMean候補をMiniLMの意味的近傍で生成する"
      }
    }
  }
}
```

#### `backend` 値の選択指針

```
"dictionary"  追加インストール不要。CJKバグ修正後は日本語・韓国語の
              同言語内検索は十分に機能する。クロス言語は辞書アンカーで補う。
              本番環境でのバンドルサイズ・起動速度を最優先するとき。

"minilm"      言語を問わず意味的な近さで検索・分類したいとき。
              アンカー語メンテを最小にしたいとき。
              サーバーの80MB増とメモリ~150MB増が許容できるとき。

"auto"        推奨デフォルト。
              MiniLMが使えるなら使い、なければ自動でdictionaryへ。
              開発環境とCI（モデル未DL）の両方で動く。
```

---

## 3. 機能B: スコープ付き検索（focusScope）

### 3-1. 目的

agentが「このモーダルの中を探せ」と指定できるようにする。
ただし内部では**常に全DOM検索が走り**、
指定スコープ外のヒットは別フィールドでサマリとして返す。

これにより：
- プライマリ結果の精度が上がる（ノイズ除去）
- スコープ外にも同名要素があることをagentが把握できる
- 既存の全DOM検索ロジックに対する後方互換を維持できる

### 3-2. 対象ツール

- `get_text_coords`
- `get_ui_catalog`
- `get_accessibility`

### 3-3. 新パラメータ `focusScope`

```json
"focusScope": {
  "type": "string",
  "description": "CSS selector identifying the subtree to search within (e.g. '[role=\"dialog\"]', '#checkout-form', '.notification-banner'). Elements outside this scope are summarized separately in outOfScopeMatches. Omit to search the entire page (default behavior)."
}
```

#### 注意: focusScopeはサーバー側キャッシュへのフィルタ

`focusScope` に渡されるCSSセレクタはブラウザのライブDOMに直接クエリするのではなく、
**キャッシュされた要素データのパス情報（`location` / `selector`フィールド）に対して
文字列マッチを行うフィルタ**として機能する。

DOMの実物に触れないため：
- リアルタイム性は `refresh_data` の鮮度に依存する
- ページ構造が変化した場合は `refresh_data` を先行させること
- セレクタの完全なCSSパース/マッチは行わない（パス文字列のprefix/containsマッチ）

### 3-4. レスポンス仕様

#### プライマリ結果（focusScope内）

既存フィールドに加えて以下を付加：

```json
{
  "buttons": [ ... ],
  "words":   [ ... ],
  "scopeApplied": true,
  "scopeSelector": "[role=\"dialog\"]"
}
```

#### 範囲外ヒット（outOfScopeMatches）

`focusScope` 指定時に、スコープ外で **完全一致** したものがある場合：

```
ヒット数 >= 5件:
  "outOfScopeMatches": {
    "count": 7,
    "detail": null,
    "_note": "Too many to list individually. Broaden focusScope or re-search without scope to see all."
  }

ヒット数 1〜4件:
  "outOfScopeMatches": {
    "count": 2,
    "detail": [
      {
        "index": 1,
        "location": "nav > ul > li:nth-child(2) > a",
        "elementType": "link",
        "matchedContent": "送信",
        "matchedField": "text"
      },
      {
        "index": 2,
        "location": "footer > form > button",
        "elementType": "button",
        "matchedContent": "送信",
        "matchedField": "text"
      }
    ]
  }
```

#### `matchedField` の意味

- `"text"` : `text` / `textContent` フィールドが一致
- `"label"` : `aria-label` / `label` フィールドが一致
- `"placeholder"` : `placeholder` フィールドが一致
- `"name"` : フォームの `name` 属性が一致

ORクエリ（スペース区切り複合検索）が実装された場合、
どの語にヒットしたかを `matchedQuery` フィールドで追加する。

#### focusScopeが機能しなかった場合

セレクタが既存キャッシュのパスと一致する要素が0件だった場合：

```json
{
  "_warnings": [
    {
      "code": "SCOPE_NO_MATCH",
      "message": "focusScope '[role=\"dialog\"]' matched no cached elements. Try refresh_data first, or verify the selector.",
      "scopeSelector": "[role=\"dialog\"]"
    }
  ],
  "scopeApplied": false
}
```

---

## 4. 機能C: "もしかして" 候補提案（didYouMean）

### 4-1. 目的

agentが `search`（完全一致モード）でノーヒットになったとき、
次のターンで「クエリを変えて再試行」するためのヒントを返す。

これにより：
- ノーヒット → 無駄なターンが発生するパターンを削減できる
- agentが `_suggestions` から直接候補の `text` を取得して再検索できる
- 候補には詳細な位置情報を含めない（agentが選んだら再検索する設計）

### 4-2. 対象ツール

- `get_text_coords` の `search` パラメータ使用時
- `get_ui_catalog` の `search` パラメータ使用時

※ `match`（fuzzyモード）使用時は既にfuzzyスコアで並んだ結果が返るため不要。

### 4-3. レスポンス仕様

#### ノーヒット時（必ず付加）

```json
{
  "buttons": [],
  "_suggestions": [
    { "text": "送信する", "score": 0.82, "elementType": "button" },
    { "text": "送信",     "score": 0.71, "elementType": "button" },
    { "text": "送付",     "score": 0.44, "elementType": "link"   }
  ],
  "_warnings": [
    {
      "code": "NO_EXACT_MATCH",
      "message": "No elements matched \"送診\". See _suggestions for similar results."
    }
  ]
}
```

#### ヒットあり時（オプション）

デフォルトは付加しない。呼び出し時に `includeSuggestions: true` を渡すか、
`config.json` の `searchClassifier.showSuggestionsOnHit: true` で常時有効にできる。

### 4-4. サジェストの生成ロジック

```
1. search クエリが完全一致でヒットしなかった場合
2. 既存の fuzzyScore(query, element.text) をキャッシュ内全要素に対して計算
3. スコア >= intentThreshold（デフォルト 0.35）の要素を収集
4. スコア降順でソート、上位5件を返す
5. 各候補には { text, score, elementType } のみ含める（座標・セレクタは含めない）
```

意図分類（§2）が有効な場合、サジェストに `intent` フィールドを追加できる：

```json
{ "text": "閉じる", "score": 0.91, "elementType": "button", "intent": "DISMISS" }
```

---

## 5. 機能D: 動的 minScore 上書き + 自動リセット

### 5-1. 問題の整理

現在 `get_text_coords` には `minScore` パラメータが既に存在し（デフォルト 0.1）、
呼び出しごとに指定できる設計になっている。

```js
// read-basic.js 現行
const minScore = args.minScore != null ? args.minScore : 0.1;
```

しかしこれは **呼び出しごとに都度指定する仕様**であり、
「一度変えた値を複数ターン維持し、一定時間後に自動で元に戻す」
**セッション横断の状態**を扱う仕組みがない。

agentが `minScore: 0.05` で広い網を一時的に張り、
その後のターンでも 0.05 が維持されてノイズだらけになるという問題がある。

### 5-2. 設計方針

- `minScore` パラメータは**そのまま維持**（後方互換）
- **新たに** `minScoreOverride` パラメータを追加。
  これはセッション状態として保持され、次の呼び出しにも引き継がれる
- 一定ターン数、検索ツールが呼ばれなかったら自動でデフォルトに戻す
- リセット時にagentへ通知する（§5-4）

`minScore`（既存）と `minScoreOverride`（新規）の違い：

| パラメータ | スコープ | リセット |
|---|---|---|
| `minScore` | そのターンのみ | 次ターンには引き継がれない |
| `minScoreOverride` | セッション内で持続 | 自動リセットされる |

### 5-3. config.json への追加

`intelligence.searchClassifier` に追加（§2-7の続き）：

```json
"searchClassifier": {
  "enabled": true,
  "intentAnchorFile": "configs/intent-anchors.json",
  "intentThreshold": 0.35,
  "autoUnblockIntentThreshold": 0.60,
  "defaultMinScore": 0.1,
  "allowAgentMinScoreOverride": true,
  "agentOverrideAutoResetTurns": 3,
  "showSuggestionsOnHit": false,
  "_comment_defaultMinScore_ja": "fuzzy検索のデフォルト下限スコア。minScoreOverrideのリセット後もこの値に戻る",
  "_comment_allowOverride_ja": "falseにするとminScoreOverrideパラメータがスキーマから消え、agentに通知もされない",
  "_comment_resetTurns_ja": "検索ツールが連続でこのターン数呼ばれなかったらminScoreOverrideをリセット。0で無効"
}
```

#### `agentOverrideAutoResetTurns` の値の考え方

```
0    → 自動リセット無効（汚部屋固定になるので非推奨）
1〜2 → 積極的なリセット。検索を少し間引くだけで戻る
3    → 推奨デフォルト。「検索コマンドが呼ばれなくなって3ターン経過」
10   → 緩いリセット。長いタスクで調整値を維持したい場合
```

ハードコードの定数にもできるが（例: `const RESET_TURNS = 10`）、
ユースケースによって適切な値が変わるため config 化を推奨する。

### 5-4. ツールパラメータの動的スキーマ

`allowAgentMinScoreOverride: true` のときのみ、
`get_text_coords` / `get_ui_catalog` のスキーマに `minScoreOverride` が現れる。

```js
// server/mcp/tools/read-basic.js（get_text_coords の定義部分）

function buildTextCoordsSchema(config) {
  const base = {
    tabId:      { type: 'number', description: '...' },
    search:     { type: 'string', description: '...' },
    match:      { type: 'string', description: '...' },
    minScore:   { type: 'number', description: 'Minimum similarity score for "match" mode (0.0-1.0, default: 0.1)' },
    // ... 他の既存パラメータ
  };

  if (config?.intelligence?.searchClassifier?.allowAgentMinScoreOverride) {
    const resetTurns = config.intelligence.searchClassifier.agentOverrideAutoResetTurns ?? 3;
    base.minScoreOverride = {
      type: 'number',
      description:
        `Temporarily override the default minScore for this and subsequent "match" calls in this session. ` +
        `Range: 0.0-1.0. Resets automatically after ${resetTurns} consecutive turns without a search-tool call. ` +
        `Use "minScore" instead if you only want to affect this single call.`,
    };
  }

  return { type: 'object', properties: base, required: ['tabId'] };
}
```

`allowAgentMinScoreOverride: false` のとき：
- スキーマに `minScoreOverride` は現れない
- 渡しても無視される（エラーにしない。知らないパラメータは透過）
- agentはこの機能の存在を知らない状態になる

これは `tool-manager.js` の `requiresConfig` ゲートと同じ設計思想。

### 5-5. セッション状態の管理

`tool-manager.js` の session オブジェクトを拡張する：

```js
// tool-manager.js
function ensureSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      activeProfiles:   new Set(['core']),
      turnCount:        0,
      lastUsed:         new Map([['core', 0]]),
      warnings:         new Map(),
      // ── 追加フィールド ──────────────────
      minScoreOverride:     null,   // number | null
      minScoreSetAtTurn:    null,   // number | null
      lastSearchToolTurn:   null,   // number | null
    });
  }
  return sessions.get(sessionId);
}
```

#### リセット判定ロジック

`processTurn` に追加する（既存のidle-profileチェックと同じ場所）：

```js
// processTurn() 内に追加
if (session.minScoreOverride !== null) {
  const isSearchTool = ['get_text_coords', 'get_ui_catalog', 'get_accessibility']
    .includes(lastToolCall?.name);

  if (isSearchTool) {
    session.lastSearchToolTurn = session.turnCount;
  } else if (session.lastSearchToolTurn !== null) {
    const resetTurns = config?.intelligence?.searchClassifier?.agentOverrideAutoResetTurns ?? 3;
    if (resetTurns > 0) {
      const idle = session.turnCount - session.lastSearchToolTurn;
      if (idle >= resetTurns) {
        const prevValue = session.minScoreOverride;
        const defaultScore = config?.intelligence?.searchClassifier?.defaultMinScore ?? 0.1;
        session.minScoreOverride = null;
        session.minScoreSetAtTurn = null;
        // 通知をペンディング状態に置く（次の検索ツール呼び出し時に返す）
        session._pendingMinScoreResetNotice = { from: prevValue, to: defaultScore };
      }
    }
  }
}
```

### 5-6. リセット通知の形式と送信ルール

#### 通知はいつ返されるか

「自動リセットが発動したタイミング」ではなく、
**次の検索ツール呼び出しのレスポンスの先頭**に付加する。

理由：agentはツールレスポンスを読むタイミングが明確だが、
それ以外のタイミングで通知を渡す手段（MCP標準の notifications ストリームは
stdio モードでは使わない設計になっている）を現行アーキテクチャは持たないため。

```json
{
  "words": [ ... ],
  "_systemMessage": {
    "source": "WHISKOR_SYSTEM",
    "type": "MINSCORE_OVERRIDE_REVERTED",
    "message": "minScore override reverted: 0.05 → 0.1",
    "from": 0.05,
    "to": 0.1
  }
}
```

`source: "WHISKOR_SYSTEM"` により、agentはこれをページコンテンツや
ユーザーメッセージと区別できる。UIレイヤー（ダッシュボード等）には表示しない。

#### 通知を受け取るのは誰か

**検索ツール（`get_text_coords` / `get_ui_catalog` / `get_accessibility`）が
アクティブなプロファイルに含まれるセッションのみ。**

実装上は `registry.js` の `callTool` で tool-manager の `getVisibleTools` が
既にセッションごとの可視ツールをフィルタリングしているため、
通知をその結果に含めるだけでよい。

```js
// read-basic.js の get_text_coords ハンドラ先頭に追加

const session = cb._toolManager?.getSessionState?.(args._sessionId);
const systemMessage = session?._pendingMinScoreResetNotice
  ? {
      source: 'WHISKOR_SYSTEM',
      type: 'MINSCORE_OVERRIDE_REVERTED',
      message: `minScore override reverted: ${session._pendingMinScoreResetNotice.from} → ${session._pendingMinScoreResetNotice.to}`,
      ...session._pendingMinScoreResetNotice,
    }
  : undefined;

if (session) session._pendingMinScoreResetNotice = null; // 消費

// ... 処理 ...

return withFreshness(args.tabId, '...', {
  ...(systemMessage ? { _systemMessage: systemMessage } : {}),
  // ... 通常のレスポンスフィールド
}, cache);
```

---

## 6. 実装ファイル一覧

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `server/mcp/tools/read-helpers.js` | **修正** | `bigramSet`/`tokenize` の `\w` バグ修正（一行）、`classifyIntent()` / `normalizeLabel()` / `levenshtein()` 追加 |
| `server/configs/intent-anchors.json` | **新規** | インテント別アンカー語辞書 |
| `server/mcp/tools/read-basic.js` | **修正** | `get_text_coords` に `focusScope`, `minScoreOverride`, `includeSuggestions` 追加、動的スキーマ生成 |
| `server/mcp/tools/read-data.js` | **修正** | `get_ui_catalog` / `get_accessibility` に `focusScope`, `_suggestions` 追加 |
| `server/tool-manager.js` | **修正** | session に `minScoreOverride` 状態追加、`processTurn` にリセット判定追加 |
| `server/mcp/registry.js` | **修正** | `callTool` から session へアクセスできるよう `_sessionId` をコールバックに渡す |
| `config.json` | **修正** | `intelligence.searchClassifier` セクション追加（backend / miniLM 設定含む） |
| `extension/injected/analyzers/clickability.js` | **修正** | `classifyObstructor` に意図分類フォールバック追加 |
| `extension/injected/lib/intent-classifier.js` | **新規** | ブラウザ側意図分類器（辞書バックエンドのポータブル版。MiniLMは非対応） |
| `extension/injected/lib/intent-anchors.json` | **新規** | サーバー側と同一の辞書（ビルド時コピーまたはシンボリックリンク） |
| `server/mcp/tools/intent-classifier-minilm.js` | **新規** | MiniLMバックエンド実装（モデルロード・embed・コサイン類似度）（§9 参照） |
| `server/mcp/tools/backend-selector.js` | **新規** | `backend: "auto"` の解決ロジック。`classifyIntent` / `fuzzyMatchMiniLM` の統一インターフェース |

---

## 7. 実装順序

各フェーズは独立して導入・テストができる。

### Phase 0（前提条件）: `\w` バグ修正
```
変更: server/mcp/tools/read-helpers.js の bigramSet と tokenize を1行ずつ修正
リスク: 最小（バグ修正のみ。fuzzy スコアが CJK 入力で 0 → 正常値 に変わる）
テスト: tests/unit/ に CJK 入力のテストケースを追加
```

### Phase 1: `classifyIntent()` の純粋関数実装
```
変更: intent-anchors.json 新規作成、read-helpers.js に classifyIntent 追加
リスク: 低（既存コードに触れない。新関数の追加のみ）
テスト: 単体テストで各インテントのアンカー語と揺れ表現を確認
```

### Phase 2A: `clickability.js` への意図分類フォールバック統合
```
変更: extension 側。classifyObstructor() の closeButton 検出後段に追加
リスク: 低（既存 CLOSE_BUTTON_SELECTORS が成功したら到達しない）
テスト: CSSセレクタが拾えないラベル（「완료」「あとで」等）でのモーダル自動解除
```

### Phase 2B: `didYouMean` サジェスト追加
```
変更: read-basic.js, read-data.js
リスク: 低（レスポンスへの _suggestions フィールド追加のみ）
テスト: search ノーヒット時に _suggestions が返ることを確認
```

### Phase 3: `focusScope` パラメータ追加
```
変更: read-basic.js, read-data.js（キャッシュデータへのフィルタ処理）
リスク: 低（未指定時は従来通り動作）
テスト: focusScope 内/外 のフィルタリングが正しく機能することを確認
```

### Phase 4: 動的 `minScoreOverride` + 自動リセット
```
変更: tool-manager.js, read-basic.js, read-data.js, registry.js, config.json
リスク: 中（tool-manager の session 状態拡張。既存の turnCount ロジックに隣接）
テスト: override 設定 → idle ターン経過 → リセット通知 の一連の流れ
```

### Phase 5: MiniLMバックエンド統合
```
変更: server/mcp/tools/intent-classifier-minilm.js 新規作成
      server/mcp/tools/backend-selector.js 新規作成
      read-helpers.js の classifyIntent をバックエンド選択経由に変更
      read-basic.js / read-data.js の fuzzy match パスを MiniLM 対応に変更
リスク: 中（新規モジュール。backend: "auto" のフォールバック設計により
        モデル未DL環境では辞書モードで動き続ける）
テスト: - backend: "dictionary" で Phase 0〜4 の既存テストが全て通ること
        - backend: "minilm" で classifyIntent がクロス言語入力を正しく分類すること
        - モデルDL失敗時に fallbackToDictionary: true が機能すること
        - useFor.fuzzyMatch: true で get_text_coords(match:) がMiniLMコサイン類似度を使うこと
依存: @xenova/transformers（npm install）、初回のみモデルDL（~120MB）
```

---

## 8. HTTP API 互換性

本仕様で追加するパラメータ（`focusScope`, `minScoreOverride`, `includeSuggestions`）は
すべてオプショナルであり、指定なし時の挙動は現行と完全に同一。

追加レスポンスフィールド（`_suggestions`, `_systemMessage`, `outOfScopeMatches`）は
アンダースコアプレフィックスにより内部/拡張フィールドであることを示す。
HTTPクライアントが不要と判断した場合は無視してよい。

参照: `doc/http-api-reference.md` / `docs/http-api-reference.md`

---

## 9. MiniLMバックエンド実装

辞書バックエンドと並ぶ **第2の意味処理バックエンド**。
`config.json` の `searchClassifier.backend`（§2-7）で切り替える。

### 9-1. モジュール構成

```
server/mcp/tools/
  intent-classifier-minilm.js   ← MiniLM バックエンド本体（本セクション）
  backend-selector.js           ← "auto" 解決・統一インターフェース
  read-helpers.js               ← 辞書バックエンド（既存 classifyIntent の置き場）
```

`read-basic.js` / `read-data.js` は `backend-selector.js` の統一インターフェースを
呼ぶだけで、どちらのバックエンドが使われているかを意識しない。

### 9-2. 起動・モデルロード

```js
// server/mcp/tools/intent-classifier-minilm.js

const { pipeline } = require('@xenova/transformers');
const path = require('path');

let _pipe     = null;  // Feature extraction pipeline
let _anchors  = null;  // { DISMISS: [{text, vec}, ...], ... }
let _ready    = false;
let _loading  = false;

async function initMiniLM(config) {
  if (_ready || _loading) return;
  _loading = true;

  const modelName = config?.miniLM?.model ?? 'paraphrase-multilingual-MiniLM-L12-v2';
  const cacheDir  = path.resolve(config?.miniLM?.modelCacheDir ?? '.model-cache');

  try {
    _pipe = await pipeline('feature-extraction', modelName, { cacheDir });

    // 全アンカー語をベクトル化してメモリに保持（起動時1回のみ）
    const rawAnchors = loadRawAnchors(); // intent-anchors.json から読む
    _anchors = {};
    for (const [intent, words] of Object.entries(rawAnchors)) {
      const vecs = await batchEmbed(words);
      _anchors[intent] = words.map((text, i) => ({ text, vec: vecs[i] }));
    }
    _ready = true;
  } catch (err) {
    _loading = false;
    throw err; // backend-selector.js がキャッチして fallback に切り替える
  }
  _loading = false;
}

async function batchEmbed(texts) {
  const out = await _pipe(texts, { pooling: 'mean', normalize: true });
  // out.tolist() → number[][]
  return out.tolist();
}

async function embedOne(text) {
  const out = await _pipe([text], { pooling: 'mean', normalize: true });
  return out.tolist()[0];
}
```

起動コスト：初回モデルDL ~120MB（以後はキャッシュ）、embed ~1〜2秒。
推論レイテンシ：~2〜10ms/件（CPU）。

### 9-3. `classifyIntent` の MiniLM 実装

```js
// server/mcp/tools/intent-classifier-minilm.js

/**
 * 辞書バックエンドと同一インターフェース。
 * @param {string} label
 * @param {number} threshold
 * @returns {{ intent: string, confidence: number, topAnchor: string } | null}
 */
async function classifyIntentMiniLM(label, threshold = 0.35) {
  if (!_ready) return null; // フォールバック側に委譲させる
  const qVec = await embedOne(label.slice(0, 128)); // 長すぎる入力を切る

  let best = { intent: 'UNKNOWN', score: -1, anchor: '' };

  for (const [intent, entries] of Object.entries(_anchors)) {
    for (const { text, vec } of entries) {
      const sim = cosineSim(qVec, vec); // normalize: true なので dot product = cosine
      if (sim > best.score) {
        best = { intent, score: sim, anchor: text };
      }
    }
  }

  if (best.score < threshold) return null;
  return { intent: best.intent, confidence: best.score, topAnchor: best.anchor };
}

function cosineSim(a, b) {
  // normalize: true で embed しているので dot product で十分
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
```

### 9-4. fuzzy match の MiniLM 実装

`get_text_coords(match:)` / `get_ui_catalog(search:)` のfuzzy検索を
バイグラム Jaccard → **MiniLM コサイン類似度** に差し替える。

```js
// server/mcp/tools/intent-classifier-minilm.js

/**
 * キャッシュ内全要素のテキストとクエリをコサイン類似度でスコアリング。
 * 戻り値は fuzzyScore() と同じ 0.0〜1.0 のスカラー。
 * @param {string} query
 * @param {string[]} candidates - キャッシュ内の全テキストリスト
 * @returns {Promise<number[]>} candidates と同順のスコア配列
 */
async function batchFuzzyScoreMiniLM(query, candidates) {
  if (!_ready) return null;
  const texts = [query, ...candidates];
  const vecs  = await batchEmbed(texts);
  const qVec  = vecs[0];
  return vecs.slice(1).map(v => cosineSim(qVec, v));
}
```

`read-basic.js` / `read-data.js` 内の fuzzy スコアリングループを
`backend-selector.js` 経由で差し替える。
クエリ文字列が英語でも日本語でも韓国語でも、embed の意味空間で近い要素がヒットする。

### 9-5. `didYouMean` サジェストの MiniLM 実装

辞書バックエンドでは `fuzzyScore` で候補を収集している（§4-4）。
MiniLM バックエンドでは `batchFuzzyScoreMiniLM` の結果をそのまま使う。
インターフェースは変わらず、スコアの意味が「文字類似度」→「意味類似度」に変わる。

クロス言語サジェストが自然に生まれる：
```
search: "close"  →  _suggestions: [{ text: "閉じる", score: 0.89, intent: "DISMISS" }]
search: "완료"   →  _suggestions: [{ text: "完了",   score: 0.91, intent: "COMPLETE" }]
```

### 9-6. MiniLMをシステム全体で使う場所

config の `miniLM.useFor` で機能ごとに個別に有効/無効を制御する。

| 使用箇所 | 対応コード | useFor キー | 辞書バックエンドとの差分 |
|---------|-----------|------------|----------------------|
| **intent分類** | `classifyIntent()` in `read-helpers.js` → MiniLM版に差し替え | `intentClassification` | クロス言語でアンカー語なしで分類できる |
| **fuzzy match** | `get_text_coords(match:)` / `get_ui_catalog` のスコアリングループ | `fuzzyMatch` | バイグラムJaccardの代わりにコサイン類似度。クロス言語検索が自然に機能する |
| **didYouMean候補** | ノーヒット時の `_suggestions` 生成（§4） | `suggestions` | 言語をまたいだ意味的近傍候補が返る |

**ブラウザ拡張側（`extension/injected/`）は対象外。**
バンドルサイズ制約（~120MB は非現実的）のため、拡張側は常に辞書バックエンドを使う。
`intent-classifier.js`（§6）はMiniLMと同一インターフェースを持つが辞書実装固定。

#### `backend-selector.js` の統一インターフェース

```js
// server/mcp/tools/backend-selector.js

const dict   = require('./read-helpers');       // 辞書バックエンド
const minilm = require('./intent-classifier-minilm'); // MiniLM バックエンド

/**
 * config から有効なバックエンドを解決し、統一インターフェースを返す。
 * 呼び出し側は backend の種類を意識しない。
 */
async function resolveBackend(config) {
  const setting = config?.intelligence?.searchClassifier?.backend ?? 'auto';
  const mlCfg   = config?.intelligence?.searchClassifier?.miniLM ?? {};
  const useFor  = mlCfg.useFor ?? {};

  if (setting === 'dictionary') return makeDictBackend(useFor);

  if (setting === 'minilm' || setting === 'auto') {
    try {
      await minilm.initMiniLM(mlCfg);
      return makeMiniLMBackend(useFor);
    } catch (err) {
      if (setting === 'minilm') throw err; // 明示指定なのでエラーを伝播
      if (mlCfg.fallbackToDictionary !== false) {
        console.warn('[whiskor] MiniLM load failed, falling back to dictionary:', err.message);
        return makeDictBackend(useFor);
      }
      throw err;
    }
  }
  return makeDictBackend(useFor);
}

function makeDictBackend(useFor) {
  return {
    classifyIntent:    dict.classifyIntent,
    batchFuzzyScore:   null,   // 辞書は同期 fuzzyScore を使う（各呼び出し元で直接呼ぶ）
    suggestionsAsync:  false,
  };
}

function makeMiniLMBackend(useFor) {
  return {
    classifyIntent:    useFor.intentClassification !== false
                         ? minilm.classifyIntentMiniLM
                         : dict.classifyIntent,
    batchFuzzyScore:   useFor.fuzzyMatch !== false
                         ? minilm.batchFuzzyScoreMiniLM
                         : null,
    suggestionsAsync:  useFor.suggestions !== false,
  };
}

module.exports = { resolveBackend };
```

#### フォールバック動作まとめ

```
backend: "dictionary"
  → 常に辞書。MiniLM は一切ロードされない。

backend: "minilm"
  → MiniLM のロードに失敗したらエラー終了（fallbackToDictionary は無視）。

backend: "auto" + fallbackToDictionary: true（デフォルト）
  → MiniLM が使えれば使う。ロード失敗・モデル未DL時は辞書に自動切り替え。
  → 開発・CI環境（モデル未DL）でも動作する。

useFor.fuzzyMatch: false
  → intent分類は MiniLM でも、fuzzy検索は辞書のまま（バイグラムJaccard）。
```

---

## 10. 変更前後の対照表

| 機能 | 変更前 | 変更後（辞書バックエンド） | 変更後（MiniLMバックエンド） |
|------|-------|--------------------------|---------------------------|
| CJK fuzzy検索 | 常にスコア0（バグ） | 正常に機能する | 正常に機能する（意味空間で近傍検索） |
| autoUnblock closeButton | CSSセレクタのみ | セレクタ失敗時に意図分類でフォールバック | 同左（ブラウザ拡張側は辞書固定） |
| "完了" "나중에" のモーダル | fixResult: all_steps_failed | COMPLETE / SKIP として検出 | 同左（より自然な表現にも対応） |
| UIラベル検索 | 文字列部分一致のみ | インテントカテゴリでの意味検索も可 | 同左＋クロス言語でアンカー語なしで動作 |
| 検索スコープ | 全DOM固定 | focusScope で範囲指定可 | 同左 |
| ノーヒット時 | _warnings のみ | _suggestions で候補提示 | 同左＋クロス言語候補が自然に生成される |
| minScore 管理 | ターンごとに都度指定 | セッション持続 + 自動リセット | 同左 |
| fuzzy match の言語境界 | 言語が違えばスコア0 | アンカー辞書で補う（辞書メンテ必要） | embed空間でクロス言語ヒット（辞書不要） |
| 外部依存 | なし | なし | `@xenova/transformers` + ~120MB ONNX モデル |
| 起動オーバーヘッド | なし | なし | 初回~1〜2秒（モデルDL済みの場合） |

**Rustへの移行パスについて**：将来サーバーを Rust に移行する場合、
MiniLM バックエンドは `fastembed-rs` + ONNX Runtime に置き換えるのが最も自然。
インターフェース（`classifyIntent` / `batchFuzzyScore`）は変わらず、実装を差し替えるだけ。

