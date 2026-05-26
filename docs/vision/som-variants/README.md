# SoM Variants

> 現在の赤丸＋白抜き数字（som-basic）を拡張し、複数のSoM表示モードとAgent向けチートシートを提供する。

詳細設計: `docs/ideas/SoM_EXTENSION_PLAN.md`

## SoM表示モード一覧

| モード | CSSクラス | 説明 | 優先度 |
|--------|----------|------|--------|
| Transparent | `cap-som-transparent` | バッジ非表示、ホバー時のみ表示 | 現状デフォルト |
| Basic | `cap-som-basic` | 赤丸＋白抜き数字（既存） | 実装済み |
| **Adaptive** | `cap-som-adaptive` | 背景適応型6色SoM | 高 |
| **Cheat Sheet** | `cap-som-cheatsheet` | Agent向け座標＋要素情報同時提供 | 中 |

モード切替: Dashboard `<select id="cap-som">` で選択。

## Phase 2: 背景適応型6色SoM

### 概要
スクリーンショットの背景色に応じて、マーカーの色を動的に選択。
赤一色では背景に溶けるケースを回避。

### アルゴリズム

```
1. 要素の背景領域をサンプリング (5×5 px中央付近)
2. RGB→L*a*b*変換 (近似式)
3. 6色パレットからの色選択:
   ┌─────────────────────────────────────────────────────┐
   │ #e53e3e (赤)  #3182ce (青)  #38a169 (緑)            │
   │ #d69e2e (黄)  #805ad5 (紫)  #e53e3e/2 (淡赤)        │
   └─────────────────────────────────────────────────────┘
4. 貪欲彩色:
   - 各要素に未使用色を割当（隣接同色回避）
   - 全色使用済み → 彩度・明度で最適な色を選択
   - 背景とのコントラスト比 < 3.0 → 枠線追加
```

### MCP連携
`capture_screenshot(tabId, marks=true, somMode="adaptive")` のオプション追加。

## Phase 3: Agent向けチートシート

### 概要
SoM画像＋「どの座標に何の要素があるか」を構造化データとして同時提供。
Agentは画像だけでなく、要素の種類やテキストを把握できる。

### データ形式

```json
{
  "elements": [
    {
      "id": 1,
      "tag": "button",
      "text": "Submit",
      "selector": "#submit-btn",
      "center": { "x": 850, "y": 1200 },
      "size": { "w": 120, "h": 40 }
    }
  ],
  "viewport": { "width": 1920, "height": 1080 }
}
```

### MCPツール
`get_cheat_sheet(tabId)` → `{ ok, viewport, elements[] }`

Slice XML Pipeline の `get_slice_xml` と併用想定。

## Phase 4: モデル別統計＋自動モード選択

### 概要
使用中のLLMモデル（Claude, GPT, Gemini等）に応じて最適なSoMモードを自動選択。

### 統計収集項目
- モデル別：クリック成功率、リトライ回数、エラー種別
- SoMモード別：要素特定精度、操作完了時間

### 自動選択ロジック
```
モデル判定 (User-Agent / MCP client info)
  ├─ Claude Opus  → Cheat Sheet (構造化データを好む)
  ├─ GPT-4o       → Adaptive (視覚的に)
  └─ Gemini       → Basic (シンプルが最適)
```

## Phase 5: 選択的キャプチャ最適化

### 概要
画面全体ではなく、変化のあった領域のみを高品質でキャプチャ。
静止領域は低品質・ぼかし・2値記録でデータ量削減。

### 方式
- Delta Engine の変化領域情報を利用
- 変化領域: フル品質 PNG
- 静止領域: 低品質 JPEG or 2値（変化なしマーカーのみ）
- 再合成時に Agent には1枚の画像として見せる

## ファイル構成（追加分）

```
extension/injected/analyzers/slice-engine.js   — スライス＋チートシート生成
extension/background/sw.js                     — SoM多色処理追加
server/mcp/tools/capture.js                    — get_cheat_sheet追加
docs/vision/cheat-sheet/                       — チートシート専用設計
```

## 依存関係

- Phase 2 は **Transparent Overlay** の矩形データを利用（同じ要素情報）
- Phase 3 は **Slice XML Pipeline** とデータ共有（slice-engine.js の出力を利用）
- Phase 5 は既存の Delta Engine に依存
