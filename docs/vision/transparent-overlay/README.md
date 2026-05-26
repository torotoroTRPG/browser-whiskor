# Transparent Overlay

> Dashboard のキャプチャビューで、UI要素の矩形を透明パネルとして重ねて表示する。
> 現在の赤丸＋ツールチップを拡張し、要素の形状・サイズ・位置を正確にトレース。

## 現状と課題

| 項目 | 現在（v3.1.0） | 目標（Phase 1 後） |
|------|----------------|-------------------|
| 矩形表示 | ホバー時のみ枠線 | 常時薄い枠線＋ホバーで強調 |
| ツールチップ | 上方向に固定 | 画面端で自動的に向き反転 |
| 情報量 | tag, text, coords | + full selector, 階層パス, 属性一覧 |
| コピー | 右クリック1種類 | 右クリック＋ピン状態で内容が変化 |
| 視覚的配置 | マーカーのみ | 要素の形状が透けて見える |

## アーキテクチャ

```
Dashboard Capture Pane
  └── #cap-container (position: relative)
       ├── <img> スクリーンショット
       └── <div.cap-overlay-layer> (position: absolute, top=left=0)
            ├── <div.cap-overlay data-id="1">  ← 要素1
            │    ├── 枠線 (1px solid rgba(229,62,62,0.4))
            │    ├── 赤丸バッジ (既存)
            │    └── ツールチップ (既存＋拡張)
            ├── <div.cap-overlay data-id="2">  ← 要素2
            └── ...
```

## 実装詳細

### オーバーレイ生成

```javascript
// sw.js で取得した elements から各オーバーレイを生成
elements.forEach(el => {
  const overlay = document.createElement('div');
  overlay.className = 'cap-overlay';
  overlay.dataset.id = el.id;
  overlay.style.cssText = `
    position: absolute;
    left: ${el.x}px;
    top: ${el.y}px;
    width: ${el.w}px;
    height: ${el.h}px;
    border: 1px solid rgba(229, 62, 62, 0.3);
    pointer-events: auto;
    cursor: pointer;
  `;
  overlayLayer.appendChild(overlay);
});
```

### 状態管理

| 状態 | 枠線 | 背景 | ツールチップ |
|------|------|------|------------|
| 通常 | 1px solid rgba(229,62,62,0.3) | なし | なし |
| ホバー | 2px solid #e53e3e | rgba(229,62,62,0.08) | 表示 |
| ピン留め | 2px solid #e53e3e | rgba(229,62,62,0.12) | 固定表示 |

### ツールチップ内容

```
[ピン留め中]
#header nav
<nav> | #header nav | aria-label="Main navigation"

子要素: 5
親要素: #header

📋 クリックでコピー | 🗑️ ピン解除
```

### スクロール対応

#cap-scroll（display: inline-block）内で画像とオーバーレイ層が一体となってスクロール。
既に現行実装で対応済みのため、追加対応不要。

## CSS定義 (追加分)

```css
.cap-overlay {
  transition: border-color 0.15s, background-color 0.15s;
}
.cap-overlay:hover {
  border-color: #e53e3e;
  background: rgba(229, 62, 62, 0.08);
  z-index: 10;
}
.cap-overlay.pinned {
  border-color: #e53e3e;
  background: rgba(229, 62, 62, 0.12);
  z-index: 20;
}
```

## 依存関係

- **Slice XML Pipeline** — 同じ要素矩形データを共有（slice-engine.jsの出力を利用）
- SoM基本実装（dashboard/capture pane） — 既存のマーカー表示機構を拡張

## 実装ステップ

1. `sw.js` の `elements` レスポンスに矩形情報を含める（大部分済）
2. Dashboard capture pane にオーバーレイ層を追加
3. ツールチップの情報拡張（フルセレクター、階層パス、属性一覧）
4. 画面端でのツールチップ向き反転対応
5. ピン状態とコピー動作の拡張
