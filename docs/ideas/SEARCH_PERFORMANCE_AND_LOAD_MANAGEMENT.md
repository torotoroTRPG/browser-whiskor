# 検索パフォーマンスと負荷管理

> 補足仕様。`MULTILINGUAL_INTENT_AND_SCOPED_SEARCH.md` と合わせて読む。
> ステータス: IMPLEMENTED / 実装済み
> 作成: 2026-05-27

---

## 0. このドキュメントの読み方

各セクションの末尾に **アーキテクチャ評価** を置く。

```
✅ 有効        このアーキテクチャで実際に意味を持つ。実装推奨。
⚠️ 条件付き    一定の条件下でのみ有効。設計上の注意が必要。
❌ 非該当      このアーキテクチャでは意味をなさない、または代替手段が既にある。
```

前提として確認しておく事実：

- whiskor は **ローカルで動く Node.js MCP サーバー**（ユーザーのマシン上）
- MCP プロトコルは **request-response**（サーバーからのプッシュ通知は標準にない）
- ブラウザ拡張側は **辞書バックエンド固定**（MiniLM は動かない）
- DOM キャッシュは `refresh_data` 時点のスナップショット

これらの前提が、以下の各提案の有効性を大きく左右する。

---

## 1. MiniLM embed の非同期化

### 問題

`refresh_data` が呼ばれるたびにキャッシュ内の全要素をembedし直すと、
200件のDOM要素で 1〜3秒 かかる。
この間 MCP レスポンスが返らず agent がブロックされる。

### 設計

#### 1-1. `refresh_data` レスポンスを即時返す

DOM キャプチャの完了（速い）と embed の完了（遅い）を分離する。

```
agent: refresh_data 呼び出し
  ↓
server: DOM スナップショット取得（~50ms）
  ↓
server: embedジョブをバックグラウンドキューに投入
  ↓
server: refresh_data レスポンスを即時返す
         { "status": "ok", "elementCount": 214, "embedStatus": "pending" }
  ↓
バックグラウンドで embed 実行中...
  ↓
embed 完了 → _pendingEmbedReadyNotice をセッション状態に置く
  ↓
agent: 次の get_text_coords / get_ui_catalog 呼び出し
  ↓
レスポンス先頭に通知を付加:
  "_systemMessage": {
    "source": "WHISKOR_SYSTEM",
    "type": "EMBED_READY",
    "message": "MiniLM embed complete: 214 elements indexed."
  }
```

`_systemMessage` パターンは minScore リセット通知（本仕様§5-6）と同一。
実装コストは低い。

#### 1-2. embed 未完了中のフォールバック

embed が完了していない状態で `get_text_coords(match:)` が来た場合：

```
embedStatus: "pending"
  → 辞書バックエンド（bigramJaccard）で応答
  → レスポンスに "matchBackend": "dictionary (embed pending)" を含める

embedStatus: "ready"
  → MiniLM コサイン類似度で応答
  → レスポンスに "matchBackend": "minilm" を含める
```

agent はこの切り替えを意識しなくてよい。
結果の精度が変わるだけ（辞書 → MiniLM）。

#### 1-3. `embedStatus` フィールド一覧

| 値 | 意味 |
|----|------|
| `"ready"` | embed 完了。MiniLM を使用中。 |
| `"pending"` | embed 実行中。辞書でフォールバック中。 |
| `"stale"` | refresh_data が来たが embed がまだ始まっていない。 |
| `"unavailable"` | backend: "dictionary" またはモデルロード失敗。 |

---

**アーキテクチャ評価: ✅ 有効**

> MCP の request-response 制約の中で `_systemMessage` パターンを流用する設計は
> このアーキテクチャに対して正しく機能する。
> embed を同期的に待つ設計は agent を無用にブロックするため、
> 非同期化は必須と判断する。

---

## 2. Worker threads によるイベントループ分離

### 問題

`@xenova/transformers` の embed は CPU バウンドな処理。
Node.js のメインスレッドで実行すると、その間 **他の MCP ツール呼び出しが全てキューに詰まる**。

embed 中に別の agent セッションが `get_text_coords` を呼んでも応答できない。

### 設計

```js
// server/mcp/tools/embed-worker-pool.js

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// メインスレッド側: ワーカーにテキストを投げてベクトルを受け取る
async function embedInWorker(texts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./embed-worker.js', {
      workerData: { texts, modelCacheDir: config.miniLM.modelCacheDir }
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

// ワーカースレッド側 (embed-worker.js):
// モデルをロードして embed し、結果を parentPort.postMessage で返す
```

ワーカーは起動コストを避けるため **worker pool** にする（起動済みワーカーを再利用）。
pool size は `os.cpus().length - 1`（メインスレッドの余裕を残す）ただし最小1。

### §1 との関係

§1 の「バックグラウンドキュー」の実体がこのワーカープール。
`refresh_data` → `embedInWorker(allElements)` → 完了通知、という流れ。

---

**アーキテクチャ評価: ✅ 有効（§1 の前提条件）**

> §1 の非同期化は worker_threads なしでは実現できない。
> `setImmediate` だけでは CPU バウンド処理はイベントループをブロックし続ける。
> worker_threads は Node.js 12+ で安定しており、本環境で使用可能。

---

## 3. 差分 embed（最重要のコスト削減手段）

### 問題

`refresh_data` が呼ばれるたびに **全要素を re-embed するのは無駄**。

ページのナビゲーションなしの部分的な DOM 変化（モーダルが開く、要素が増える等）では、
前回スナップショットからの**差分は数件〜数十件**に留まる。

### 設計

各キャッシュ要素に embed 済みベクトルと **コンテンツハッシュ** を持たせる：

```js
// キャッシュエントリの構造（拡張）
{
  text: "送信する",
  location: "form > button:nth-child(2)",
  elementType: "button",
  // --- 追加フィールド ---
  _contentHash: "a3f2...",   // text + location の sha1 (8文字)
  _vec: Float32Array(384),   // embed 済みベクトル（null = 未embed）
}
```

`refresh_data` 時の処理：

```
新スナップショット取得
  ↓
各要素の _contentHash を計算
  ↓
前回キャッシュと比較:
  - ハッシュが一致 → 前回の _vec をそのまま流用（embed 不要）
  - 新規 or 変更   → embed キューに追加
  ↓
差分のみ embed（多くの場合 0〜20件程度）
```

### 効果の見積もり

| シナリオ | 全量 embed | 差分 embed |
|---------|-----------|-----------|
| 初回 / ページ全体変化 | 200件 / ~2秒 | 200件 / ~2秒（差なし） |
| モーダルが開く | 200件 / ~2秒 | 10〜20件 / ~0.2秒 |
| 同一ページでスクロール | 200件 / ~2秒 | 0〜5件 / ~即時 |

モーダル開閉や要素の動的追加など**実際のユースケースの大半**が差分 embed の恩恵を受ける。

---

**アーキテクチャ評価: ✅ 有効・優先度高**

> embed コスト削減の観点では §4（アダプティブチャンキング）より
> はるかに効果が大きい。
> 実装コストも低い（ハッシュ比較の追加のみ）。
> §1 の非同期化と組み合わせると「ほぼ常時 embed が速い」状態になる。

---

## 4. アダプティブバッチサイズ（コスト削減型スロットリング）

### ユーザーの指摘の正確な意味

「引き延ばしが処理コストを下げるような計算にしてないと意味がない」

これは **sleep を挿入して時間を延ばすこと** ではない。

ONNX Runtime でトランスフォーマー推論を行うとき、
バッチサイズが intermediate activation のメモリフットプリントを決める：

```
paraphrase-multilingual-MiniLM-L12-v2 の中間テンソル（概算）:
  hidden_size = 384
  num_layers  = 12
  seq_len     = テキスト長に依存（UIラベルは平均5〜15トークン）

バッチ1件あたりの activations ≈ 384 × 15 × 12 × 4byte ≈ 280KB
バッチ16件: ~4.4MB   → L3 キャッシュ（4〜16MB）に収まる可能性あり
バッチ64件: ~18MB    → L3 溢れ → キャッシュミス多発 → 実効スループット低下
バッチ200件: ~56MB   → メモリ帯域がボトルネック、サーマルスロットリングの引き金
```

**つまり「バッチを小さくする」こと自体が処理コストを下げる。**
sleep はその副産物として発生するもので、目的ではない。

### 実装

```js
// server/mcp/tools/embed-worker-pool.js

const BATCH_PROFILES = {
  // 「embedにかかった直近の時間」をフィードバックとして使う
  fast:     { size: 16 },   // <200ms/batch → 快調
  moderate: { size:  6 },   // 200〜600ms   → 少し負荷
  slow:     { size:  2 },   // >600ms       → 重い
};

// バッチ時間の EWMA（指数移動平均）
let _ewmaBatchMs = 0;
const EWMA_ALPHA  = 0.3; // 直近の測定を30%反映

function currentBatchSize() {
  if (_ewmaBatchMs < 200) return BATCH_PROFILES.fast.size;
  if (_ewmaBatchMs < 600) return BATCH_PROFILES.moderate.size;
  return BATCH_PROFILES.slow.size;
}

async function embedBatch(texts) {
  const size = currentBatchSize();
  const results = [];

  for (let i = 0; i < texts.length; i += size) {
    const chunk = texts.slice(i, i + size);
    const t0 = Date.now();

    const vecs = await _pipe(chunk, { pooling: 'mean', normalize: true });
    results.push(...vecs.tolist());

    const elapsed = Date.now() - t0;
    _ewmaBatchMs = EWMA_ALPHA * elapsed + (1 - EWMA_ALPHA) * _ewmaBatchMs;

    // チャンク間でイベントループに制御を返す
    // → GC 実行の機会 / 他の MCP リクエストの割り込みを許可
    // これは「待たせる」ためではなく「協調的マルチタスク」のため
    await new Promise(resolve => setImmediate(resolve));
  }

  return results;
}
```

### バッチサイズ 1 は適切でないケース

ONNX Runtime は1回の graph execution に固定オーバーヘッド（~2〜5ms）がある。
バッチサイズ 1 では `200件 × 5ms = 1秒` のオーバーヘッドだけで消費する。
バッチサイズ 2〜4 ではオーバーヘッドを共有しつつ activations は小さく保てる。

**推奨最小バッチサイズ: 2**

---

**アーキテクチャ評価: ✅ 有効（ただし設計上の注意あり）**

> 「処理コストを下げるような引き延ばし」の実体は
> **バッチサイズを小さくして L3 キャッシュに収める** ことであり、
> sleep の挿入ではない。　この指摘は正しい。
>
> ただし有効な条件は「MiniLM をメインスレッドまたはワーカーで直接呼ぶ場合」。
> §2 の worker_threads が正しく実装されていれば、
> バッチサイズ調整はワーカー内の問題に閉じ、
> メインスレッドへの影響はさらに小さくなる。
>
> 差分 embed（§3）の実装後は対象件数自体が減るため、
> このチューニングが必要になるのは **初回 embed または大規模ページ変化時のみ**。
> 優先度は §3 より低い。

---

## 5. 負荷検出サービス

### 計測候補の評価

| 指標 | 実装 | 有効性 | 問題点 |
|------|------|--------|--------|
| `os.loadavg()` | Node.js 標準 | △ | **Windows では常に [0,0,0]** を返す。クロスプラットフォーム不可。 |
| `process.cpuUsage()` | Node.js 標準 | △ | スナップショット間の差分が必要。embed 以外の CPU 使用も混入。 |
| `process.memoryUsage().heapUsed` | Node.js 標準 | ○ | メモリ圧力の検出に有効。embed のメモリピークと相関する。 |
| **event loop lag** | 自前計測 | ✅ | クロスプラットフォーム。Node.js の実際の詰まりを直接測定。 |
| **embed 所要時間 EWMA** | §4 で既に実装 | ✅ | 原因（embed の重さ）を直接フィードバックできる。 |

### 推奨: event loop lag + embed EWMA の2指標

```js
// server/services/load-monitor.js

// ── Event loop lag 計測 ────────────────────────────────────────────────
let _lagMs = 0;

function startLagMonitor(intervalMs = 500) {
  setInterval(() => {
    const start = Date.now();
    setImmediate(() => {
      _lagMs = Date.now() - start;
      // setImmediate は "次のイベントループサイクル" に実行されるため
      // その遅れがイベントループの詰まりを表す
    });
  }, intervalMs).unref(); // サーバー終了を妨げない
}

function getLoadLevel() {
  // §4 の _ewmaBatchMs と組み合わせる
  const lag      = _lagMs;
  const embedMs  = getEwmaBatchMs(); // embed-worker-pool から取得

  if (lag > 200 || embedMs > 800) return 'high';
  if (lag >  50 || embedMs > 400) return 'elevated';
  return 'normal';
}

module.exports = { startLagMonitor, getLoadLevel };
```

### 負荷レベルに応じた挙動

```
normal    → バッチサイズ: §4 の EWMA 追従（最大16）
elevated  → バッチサイズを強制的に 6 以下に上限
high      → バッチサイズを強制的に 2 以下。
             新規 embed ジョブは「既存ジョブ完了まで待機」でキューに積む
             （refresh_data は DOM スナップショットだけ先に返す）
```

---

**アーキテクチャ評価: ✅ 有効（計測指標を絞ること）**

> `os.loadavg()` は Windows 非対応のため採用しない。
> event loop lag と embed EWMA（§4 で既に持っている）の2指標で十分。
> これで「embed が重い」「サーバー全体が詰まっている」の両方を捕捉できる。
> 3段階の load level を定義し、バッチサイズ上限を動的に変える設計が最もシンプル。

---

## 6. ビューポート優先検索

### 前提の確認

DOM キャッシュは `refresh_data` 時点のスナップショット。
「viewport 内かどうか」はスクロール位置に依存するため、
**スナップショット後にスクロールが発生した場合、この情報は古くなる。**

### 有効なユースケース

```
✅ agent が「今見えているモーダルの閉じるボタンを押す」
   → モーダルは画面内にあることが確実。viewport フィルタが効く。

✅ 全ページ検索のノイズ削減
   → ヘッダー・フッターの同名要素より、現在操作中の領域を優先したい。

❌ スクロールが必要な要素を探す
   → viewport 外でも押せる場合がある。
      focusScope（§3 of メイン仕様）で代替した方が正確。
```

### 実装（最小限）

キャッシュエントリに `inViewport: boolean` を追加し（refresh_data 時点の値）、
`viewportOnly: true` オプションを `get_text_coords` / `get_ui_catalog` に追加する。

デフォルトは `false`（既存挙動を変えない）。

---

**アーキテクチャ評価: ⚠️ 条件付き有効・優先度低**

> スナップショットの鮮度問題があり、スクロール後は信頼性が下がる。
> `focusScope` で `[role="dialog"]` 等を指定する方が多くの場合より正確。
>
> 実装するとしても `viewportOnly: boolean` の1オプションとして追加するにとどめる。
> 自動的に viewport 要素を優先するような暗黙の挙動変更は避ける。
> **実装優先度: §1〜§5 が揃った後。**

---

## 7. ブラウザ拡張側（`extension/injected/`）

### 前提

拡張側は **辞書バックエンド固定**（MiniLM は動かない）。
辞書ベースの `classifyIntent` は同期処理で ~0.1ms/件。
`bigramJaccard` の fuzzy match も ~0.5ms/件程度。

上記の §1〜§5 で扱った問題（embed の重さ、event loop ブロック、バッチサイズ）は
**拡張側では発生しない。**

### `requestIdleCallback` / `scheduler.postTask` の適用可否

```
✅ 拡張側で有効なケース:
   - 大規模 DOM の traversal（get_ui_catalog 相当の処理を拡張側でやる場合）
   - ページ読み込み直後の全要素スキャン

❌ 拡張側で不要なケース:
   - classifyIntent（辞書、~0.1ms → idle 待ちの意味なし）
   - サーバー送信（WebSocket, 非同期）
```

ただし拡張側の DOM traversal が重い場合（要素数 1000+ のページ等）は、
`requestIdleCallback` で分割処理する価値がある。
これはブラウザが自動で調整する部分（ページ負荷が高ければ idle 時間が減る）もあり、
実装上の手間の割に効果が出にくい。

---

**アーキテクチャ評価: ❌ 大半は非該当**

> MiniLM は拡張側で動かないため、本ドキュメントの主要な問題が発生しない。
> `requestIdleCallback` は大規模 DOM traversal の最適化としては有効だが、
> 現時点の拡張側の処理は軽く、優先課題ではない。

---

## 8. embed ベクトルのディスク永続化（追加提案）

メイン仕様にない提案。

### 問題

サーバーを再起動するたびに、全キャッシュ要素の embed をやり直す。
初回 embed が 2 秒かかるページでは、再起動のたびにその待ちが発生する。

### 設計

```js
// .model-cache/embed-store.json（または sqlite）
{
  "modelVersion": "paraphrase-multilingual-MiniLM-L12-v2",
  "entries": {
    "a3f2...": [0.021, -0.134, ...],  // contentHash → vector
    "b7c1...": [0.089,  0.201, ...],
  }
}
```

- キーは §3 で定義した `_contentHash`（テキスト + location のハッシュ）
- サーバー起動時に読み込み、`refresh_data` 時にヒットしたエントリは embed をスキップ
- モデルバージョンが変わったら全削除（`modelVersion` フィールドで検出）

§3（差分 embed）と組み合わせると：
```
ページ再訪問 + サーバー再起動 → ほぼ全要素がキャッシュヒット → embed ゼロ
```

---

**アーキテクチャ評価: ✅ 有効・実装コスト低**

> §3 の contentHash の仕組みをそのまま流用できるため、追加実装量は少ない。
> JSON ファイルへの定期書き出しで十分（sqlite 不要）。
> モデルバージョン管理のミスが唯一のリスクだが、フィールド1個での検出で対応可能。

---

## 9. 実装優先順位まとめ

| 優先 | 機能 | 理由 |
|------|------|------|
| **1** | §2 Worker threads | §1 の前提。これがないと非同期化が成立しない |
| **2** | §3 差分 embed | embed コスト削減の最大効果。実装コスト低 |
| **3** | §1 非同期化 + embedStatus | agent のブロック解消。`_systemMessage` 流用で実装容易 |
| **4** | §5 負荷検出（event loop lag + EWMA） | §4 のバッチサイズ制御の前提 |
| **5** | §4 アダプティブバッチサイズ | §3 後に残る大規模 embed の最適化 |
| **6** | §8 ベクトル永続化 | 再起動コスト削減。§3 の仕組みを流用 |
| **7** | §6 ビューポート優先 | 優先度低。focusScope で代替可能なケースが多い |
| — | §7 拡張側スロットリング | 現時点では非該当 |

---

## 10. 各提案がアーキテクチャに対して持つ意味・持たない意味（総括）

```
有効な提案が解いている問題:
  「MiniLM embed は重い」「Node.js はシングルスレッド」
  → これらは事実であり、§1〜§4 は正面からこの問題に対処する。

条件付きの提案（§6）が解いている問題:
  「viewport 外のノイズ除去」
  → 有効だが focusScope で代替できる。後回しにできる。

非該当（§7）の理由:
  「MiniLM は拡張側で動かない」という前提が崩れない限り、
  拡張側でこれらを実装する意味はない。

追加提案（§8）が解いている問題:
  「再起動のたびに embed をやり直す」
  → メイン仕様に記載されていなかったが、§3 の仕組みを使えば解決コストが低い。
```
