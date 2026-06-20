# ローカル視覚モデルによる無ラベル要素の暫定ラベリング

> Status: 構想（未実装） / 優先度: 低
> Created: 2026-06-20

## 何を解くか — ラベリングの第3段

操作可能な要素に「これは何のボタンか」を与える手段は段階的で、上から順に確実・安価:

1. **DOM**（`get_text_coords` / `get_ui_catalog` / `accessibility`）— textContent・aria・label・title・alt から取る。最も確実。
2. **OCR**（`ocr_region`、2026-06-20 実装済）— ピクセルにしかないテキスト。canvas/WebGL や、文字をラスタライズしたアイコンボタン。
3. **ローカル視覚モデル**（このdoc）— **上記すべてで何も取れない**要素。aria も label も textContent も無く、OCR にかけても文字が無い純粋なアイコン/グリフ（ハンバーガー・ギア・ハート・再生三角・ドラッグハンドル等）。視覚的な「形」からしか意味を推測できない。

1→2→3 はそれぞれ前段のフォールバック。3 は最も曖昧で重いので最後。

## 対象要素の見つけ方

「操作可能なのにラベルが無い」要素は既存シグナルで検出できる:

- `clickability` / `accessibility` が interactive（button/link/role=button/draggable 等）と判定しているのに、
- text / aria-label / title / alt が空で、かつ
- その領域を `ocr_region` にかけても word が取れない（＝文字ではなくアイコン）。

この3条件を満たすものだけを候補にする（全要素には投げない。コストと誤ラベルを避ける）。

## キャプチャ — packed SoM の切り出しを流用

単一UIのキャプチャは新規実装せず、**packed SoM / per-element サムネイルの切り出し経路を流用**する（`server/som-thumbnails.js` / `screenshot-manager.captureElementThumbnail` / 拡張側の canvas クロップ）。1枚のビットマップから対象要素だけを切り出し、低解像度の単一画像にする。view-aware キャッシュもそのまま効く。

## ローカルモデル — MiniLM とは別物

MiniLM（`services/embed-*`）は**テキスト埋め込み専用**で画像は扱えない。ここで要るのは画像→ラベルの小さな視覚モデル（アイコン分類器 / 軽量キャプションモデル / CLIP 系の image-text 類似）で、別系統。

- 実行は `embed-worker` と同じく **worker-thread＋オプショナル依存**、デフォルト off が前提（重い）。
- 出力は **confidence 付きの暫定ラベル**。断定しない（"likely: menu (0.7)" のような tier 付き。[[project_related_inputs]] の「捏造数値でなく根拠直結 tier」方針に合わせる）。
- キャッシュは per-element・view-aware（`som-thumbnails` と同じ無効化）。同じ要素の再問い合わせはモデルを再走させない。

## 出力と使い方

- 暫定ラベルは「モデルの推測」と明示してエージェントに渡す。エージェントはそれで操作してもよいが、確実さが要るなら **その要素を直接キャプチャして見る**（`capture_element_screenshot` / `get_element_thumbnail`）方が早い場面も多い（OCR #9 と同じ但し書き）。
- 既存の `conclusion-cache` 的な SHA 無効化や `som-stats` のクリック統計とも素直に噛み合う。

## 関連

- 理想機能メモ #9（native OCR、第2段。実装済）と直列のフォールバック。
- [[project_packed_som_capture]]（切り出し経路の流用元）、[[project_image_asset_correlation]]（画像↔構造の対応、低優先）。
- 「SoM 発想A（未知UI自動ラベリング）」の具体化の一つ。

## 狙うレベル感

到達点の目安は「**視覚障害モードを持たないチェスゲームを、agent に画面キャプチャをさせずに自動で指させる**」くらい。盤・駒・操作可能マスが DOM にも OCR にも出てこない（canvas 描画 + 純アイコンの駒）状況で、第3段のラベリングだけで「ここは白のナイト」「ここは移動可能マス」を構造化知覚として供給し、agent はスクリーンショットを見ずに `find_target`/`click` で指す。つまり目的は「agent に画像を見せて代わりに考えさせる」ことではなく、**画像を見せずに済むだけの構造化知覚を whiskor 側で完成させる**こと。

## なぜ今やらないか

依存（視覚モデル）が重く、当たる要素が限られ、多くのケースは DOM＋OCR＋要素キャプチャで足りる。第3段が本当に要る頻度を見てから着手する。
