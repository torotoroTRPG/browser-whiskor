# Site Inspector v2 — 拡張設計仕様書

> 追加機能: テキスト座標抽出 / フレームワーク非依存アダプタ / プラグインシステム / アクティベーションモード

---

## 目次

1. [設計哲学](#1-設計哲学)
2. [プラグインシステム](#2-プラグインシステム)
3. [アクティベーションモード](#3-アクティベーションモード)
4. [テキスト座標抽出](#4-テキスト座標抽出)
5. [フレームワークアダプタシステム](#5-フレームワークアダプタシステム)
6. [新ディレクトリ構造](#6-新ディレクトリ構造)
7. [データスキーマ追加分](#7-データスキーマ追加分)
8. [制御フロー詳細](#8-制御フロー詳細)
9. [デバッグ設計](#9-デバッグ設計)
10. [実装優先度](#10-実装優先度)

---

## 1. 設計哲学

### 「疑似感覚器」としてのブラウザ拡張

ブラウザ拡張機能は、ページのJSエンジン・レンダリングエンジン・ネットワークスタック全てに横断的にアクセスできる。
これは「目」（視覚 = DOM/座標/視覚テキスト）、「記憶」（ネットワーク/状態）、「骨格認識」（コンポーネントツリー）を同時に持てる唯一の立場。

その前提で3つの設計原則を追加する：

```
原則A: 「知らないフレームワーク」に当たっても壊れない → アダプタ + フォールバック
原則B: 「いつ動くか」を外から制御できる              → アクティベーションモード
原則C: 「どこに何がある」が座標で常にわかる          → テキスト/UI絶対座標
```

### 拡張可能性の軸

```
縦軸: 収集深度       DOM → JS state → ネットワーク → ランタイム
横軸: フレームワーク React → Vue → Angular → Svelte → 完全バニラ
時間軸: 動作タイミング 常時ON → 手動 → 外部API制御 → 選択的
```

---

## 2. プラグインシステム

### 2.1 プラグインインターフェース

全アナライザをこのインターフェースに従ったオブジェクトとして実装する。

```typescript
interface InspectorPlugin {
  // 識別
  id: string;                     // 例: 'react-fiber', 'text-coords', 'vue3-devtool'
  name: string;                   // 人間向け表示名
  version: string;                // セマンティックバージョン
  
  // 実行制御
  runAt: RunAt;                   // 'document_start' | 'DOMContentLoaded' | 'load' | 'manual'
  realtime: boolean;              // true = リアルタイムストリーム, false = スナップショット
  priority: number;               // 小さいほど先に実行（0-100）
  
  // フレームワーク依存
  requires?: string[];            // ['react'] など、空なら全ページで動く
  
  // ライフサイクル
  install(api: PluginAPI): void;  // フック設置（document_start系）
  collect(api: PluginAPI): Promise<unknown> | unknown;  // データ収集
  teardown?(): void;              // クリーンアップ
  
  // 出力
  emitType: string;               // emit() に渡す type 文字列
  cacheTarget: string;            // キャッシュ書き込み先パス
}

interface PluginAPI {
  emit(type: string, payload: unknown, realtime?: boolean): void;
  getConfig(): PluginConfig;
  log(level: 'info'|'warn'|'error', ...args: unknown[]): void;
  onActivationChange(cb: (active: boolean) => void): void;
}

type RunAt = 'document_start' | 'DOMContentLoaded' | 'load' | 'manual';
```

### 2.2 PluginRegistry

```javascript
// injected/plugin-system.js

class PluginRegistry {
  #plugins = new Map();           // id → plugin
  #installed = new Set();         // インストール済みid
  #config = {};                   // activation config

  register(plugin) {
    if (this.#plugins.has(plugin.id)) {
      console.warn(`[SI] Plugin ${plugin.id} already registered, skipping`);
      return;
    }
    this.#plugins.set(plugin.id, plugin);
  }

  install(api) {
    // document_start 系プラグインを即時インストール
    for (const plugin of this.#plugins.values()) {
      if (plugin.runAt === 'document_start' && this.#isEnabled(plugin.id)) {
        this.#safeInstall(plugin, api);
      }
    }
  }

  runAt(event, api) {
    const eligible = [...this.#plugins.values()]
      .filter(p => p.runAt === event && this.#isEnabled(p.id))
      .sort((a, b) => a.priority - b.priority);

    for (const plugin of eligible) {
      this.#safeCollect(plugin, api);
    }
  }

  updateConfig(newConfig) {
    this.#config = newConfig;
    // 動的ON/OFFの反映
  }

  #isEnabled(pluginId) {
    if (this.#config.mode === 'always_on') return true;
    if (this.#config.mode === 'off') return false;
    // selective/manualモードでは個別設定を参照
    return this.#config.plugins?.[pluginId] !== false;
  }

  #safeInstall(plugin, api) {
    if (this.#installed.has(plugin.id)) return;
    try {
      plugin.install(api);
      this.#installed.add(plugin.id);
    } catch (err) {
      api.log('error', `Plugin ${plugin.id} install failed:`, err);
    }
  }

  #safeCollect(plugin, api) {
    try {
      const result = plugin.collect(api);
      if (result instanceof Promise) {
        result.then(data => api.emit(plugin.emitType, data, plugin.realtime))
              .catch(err => api.log('error', `Plugin ${plugin.id} collect failed:`, err));
      } else if (result !== undefined) {
        api.emit(plugin.emitType, result, plugin.realtime);
      }
    } catch (err) {
      api.log('error', `Plugin ${plugin.id} collect sync failed:`, err);
    }
  }
}

// シングルトン
window.__SI_REGISTRY__ = window.__SI_REGISTRY__ || new PluginRegistry();
```

### 2.3 プラグイン登録フロー

```
collector.js (エントリポイント)
  ├─ import plugin-system.js → PluginRegistry作成
  ├─ import adapters/react.js → registry.register(reactPlugin)
  ├─ import adapters/vue3.js  → registry.register(vue3Plugin)
  ├─ import adapters/angular.js → registry.register(angularPlugin)
  ├─ import analyzers/text-coords.js → registry.register(textPlugin)
  ├─ import analyzers/css.js → registry.register(cssPlugin)
  └─ registry.install(api)   ← document_start系プラグインを即時実行
```

---

## 3. アクティベーションモード

### 3.1 モード定義

| モード | 識別子 | 説明 |
|--------|--------|------|
| **常時ON** | `always_on` | 全プラグインが常に動く。設定不要の最もシンプルなモード |
| **手動** | `manual` | DevToolsパネルのボタンを押した時だけ収集 |
| **API制御** | `api` | WebSocket/HTTPから外部（AIエージェント含む）がON/OFFを制御 |
| **選択的** | `selective` | プラグインごとに個別にON/OFFを設定 |
| **完全OFF** | `off` | 拡張機能はロードされるがフックは動かない |

デフォルト: `always_on`（インストール直後に動くことを優先）

### 3.2 制御チャネル

```
──── 制御源 ────────────────────────────────────────────────────────
  
  [DevTools Panel]         [外部HTTP API]        [chrome.storage]
       │                        │                      │
       │ port.postMessage        │ POST /api/config      │
       ▼                        ▼                      ▼
  [sw.js (Service Worker)]────────────────────────────────────
       │
       │ chrome.storage.local.set({ SI_CONFIG: {...} })
       │
  [bridge.js (ISOLATED world)]
       │ chrome.storage.onChanged → window.postMessage
       ▼
  [collector.js → PluginRegistry.updateConfig()]
```

**なぜ chrome.storage を経由するか:**

```
問題: MAIN world の collector.js は chrome.* API にアクセスできない
解決: bridge.js が chrome.storage を監視し、変化を MAIN world に中継

sw.js        → chrome.storage.local.set(config)
bridge.js    → chrome.storage.onChanged → window.postMessage('SI_CONFIG_UPDATE', config)
collector.js → window.addEventListener('message') → registry.updateConfig(config)
```

### 3.3 設定スキーマ

```json
{
  "SI_CONFIG": {
    "mode": "always_on",
    "plugins": {
      "react-fiber":    true,
      "vue3-devtool":   true,
      "angular-ng":     true,
      "svelte-meta":    true,
      "text-coords":    true,
      "css-analysis":   true,
      "ui-catalog":     true,
      "network-hook":   true,
      "perf-observer":  true,
      "dom-mutations":  true
    },
    "options": {
      "textCoords": {
        "level": "word",          // 'page'|'block'|'paragraph'|'line'|'word'
        "includeHidden": false,
        "includeOffscreen": false,
        "maxWords": 5000
      },
      "network": {
        "captureBody": true,
        "bodyMaxLength": 500,
        "captureTokens": true
      },
      "react": {
        "maxDepth": 60,
        "maxProps": 30,
        "maxHooks": 20
      }
    }
  }
}
```

### 3.4 外部API エンドポイント

```
# 現在のコンフィグ取得
GET  http://localhost:7892/api/config
→ { mode, plugins, options }

# コンフィグ更新（全体）
POST http://localhost:7892/api/config
Body: { "mode": "selective", "plugins": { "text-coords": true } }

# 個別プラグインのON/OFF
POST http://localhost:7892/api/plugins/:pluginId/enable
POST http://localhost:7892/api/plugins/:pluginId/disable

# 即時収集トリガー（manualモード用）
POST http://localhost:7892/api/collect
Body: { "plugins": ["text-coords", "ui-catalog"] }
→ 指定プラグインを今すぐ1回実行

# アクティブセッション一覧
GET  http://localhost:7892/api/sessions
```

### 3.5 アクティベーションモードの実装詳細

```javascript
// bridge.js に追加
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.SI_CONFIG) return;
  window.postMessage({
    __SITE_INSPECTOR__: true,
    type: 'CONFIG_UPDATE',
    payload: changes.SI_CONFIG.newValue,
  }, '*');
});

// sw.js に追加（HTTP APIから受信 → storage更新）
ws.addEventListener('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'SET_CONFIG') {
    chrome.storage.local.set({ SI_CONFIG: msg.config });
    // 全タブに即時反映
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (config) => {
            window.postMessage({ __SITE_INSPECTOR__: true, type: 'CONFIG_UPDATE', payload: config }, '*');
          },
          args: [msg.config],
          world: 'MAIN',
        }).catch(() => {});
      }
    });
  }
});
```

---

## 4. テキスト座標抽出

### 4.1 設計目標

```
ブラウザが持っている「確実な」テキスト情報をOCRレベルの構造で出す。
OCRと違って:
  - 信頼度は常に100（ブラウザがレンダリングした文字なので）
  - フォント情報・スタイル情報を追加で持てる
  - DOMとの紐付けが完全
Tesseract互換の最低限フィールドを保ちつつ、ブラウザ固有の情報を拡張フィールドで追加。
```

### 4.2 Tesseract互換データ構造

Tesseract.jsの `data.words` 出力と互換性を持たせる。

```typescript
// Tesseract互換 (最低限フィールド)
interface TesseractWord {
  level: 1 | 2 | 3 | 4 | 5;    // page=1, block=2, paragraph=3, line=4, word=5
  page_num: number;              // 常に 1
  block_num: number;
  par_num: number;
  line_num: number;
  word_num: number;
  left: number;                  // ← 絶対座標 (scrollX含む)
  top: number;                   // ← 絶対座標 (scrollY含む)
  width: number;
  height: number;
  conf: number;                  // 0-100 (ブラウザ抽出なので常に 100)
  text: string;
}

// Site Inspector拡張フィールド (互換を破らない追加)
interface SITextWord extends TesseractWord {
  // DOM情報
  element: string;               // 'p', 'h1', 'span', ...
  elementId: string | null;
  elementClasses: string;        // クラス上位5件
  xpath: string;                 // 簡易XPath

  // スタイル情報
  fontSize: number;              // px
  fontFamily: string;            // 最初のfont-familyのみ
  fontWeight: string;            // 'bold', '400', '700', ...
  fontStyle: string;             // 'normal', 'italic'
  color: string;                 // rgb(R,G,B)
  backgroundColor: string;      // rgb(R,G,B)
  isLink: boolean;               // a要素の中にある
  
  // 可視性
  inViewport: boolean;           // ビューポート内にあるか
  isHidden: boolean;             // 非表示要素内にあるか
  
  // 座標（2種類提供）
  viewportX: number;             // ビューポート相対座標
  viewportY: number;             // ビューポート相対座標
  absoluteX: number;             // ページ絶対座標 (= left)
  absoluteY: number;             // ページ絶対座標 (= top)
}
```

### 4.3 レベル別の出力構造

level 1〜5の全階層を出力する。AIは必要な粒度のlevelだけを使えばよい。

```typescript
interface TextExtractionResult {
  // メタ
  capturedAt: number;
  pageUrl: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  totalWords: number;
  totalLines: number;
  totalBlocks: number;
  
  // 全単語（level=5）  ← Tesseract互換の主要出力
  words: SITextWord[];
  
  // 行サマリー（level=4）
  lines: TextLine[];
  
  // ブロックサマリー（level=2）
  blocks: TextBlock[];
  
  // ページ全体のテキスト（平文、順序保証）
  fullText: string;
}

interface TextLine {
  level: 4;
  page_num: 1;
  block_num: number;
  par_num: number;
  line_num: number;
  left: number; top: number; width: number; height: number;
  conf: 100;
  text: string;           // 行のテキスト（単語をスペース結合）
  wordCount: number;
  // 拡張
  element: string;
  absoluteX: number; absoluteY: number;
  viewportX: number; viewportY: number;
}

interface TextBlock {
  level: 2;
  page_num: 1;
  block_num: number;
  left: number; top: number; width: number; height: number;
  conf: 100;
  text: string;
  // 拡張
  element: string;
  elementId: string | null;
  role: string | null;       // aria-role
  absoluteX: number; absoluteY: number;
  viewportX: number; viewportY: number;
}
```

### 4.4 抽出アルゴリズム

```javascript
// analyzers/text-coords.js

function extractTextWithCoords(options = {}) {
  const {
    level = 'word',            // 最も細かい粒度
    includeHidden = false,
    includeOffscreen = false,
    maxWords = 5000,
  } = options;

  const scrollX = window.scrollX, scrollY = window.scrollY;
  const vw = window.innerWidth, vh = window.innerHeight;
  
  // ステップ1: テキストノードをTree Walkerで全取得
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        
        // script/style内のテキストは除外
        const tag = parent.tagName;
        if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','MATH'].includes(tag))
          return NodeFilter.FILTER_REJECT;
        
        // 空白のみのノードは除外
        if (!node.textContent.trim()) return NodeFilter.FILTER_SKIP;
        
        // 非表示要素の扱い
        if (!includeHidden) {
          const cs = getComputedStyle(parent);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')
            return NodeFilter.FILTER_REJECT;
        }
        
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const words = [];
  let blockNum = 0, parNum = 0, lineNum = 0, wordNum = 0;
  let lastBlockEl = null, lastParEl = null, lastLineY = -Infinity;
  const LINE_THRESHOLD = 4; // px差でline変わりと判定

  while (walker.nextNode() && words.length < maxWords) {
    const textNode = walker.currentNode;
    const parent = textNode.parentElement;
    
    // ブロック要素変わりでblock_num++
    const blockEl = findBlockAncestor(parent);
    if (blockEl !== lastBlockEl) {
      blockNum++;
      parNum = 0;
      lastBlockEl = blockEl;
    }
    
    // インライン要素の段落区切りで par_num++
    if (isBlockLevel(parent) && parent !== lastParEl) {
      parNum++;
      lastParEl = parent;
    }

    // 単語を正規表現で分割して1単語ずつ座標取得
    const wordRegex = /\S+/g;
    let match;
    while ((match = wordRegex.exec(textNode.textContent)) !== null) {
      let rect;
      try {
        const range = document.createRange();
        range.setStart(textNode, match.index);
        range.setEnd(textNode, match.index + match[0].length);
        rect = range.getBoundingClientRect();
      } catch (_) { continue; }
      
      // 座標0x0は実質非表示
      if (rect.width === 0 && rect.height === 0) continue;
      
      // ビューポート外の除外
      const inViewport = rect.top >= 0 && rect.bottom <= vh && rect.left >= 0 && rect.right <= vw;
      if (!includeOffscreen && !inViewport) continue;
      
      // Y座標でライン変わりを判定
      if (Math.abs(rect.top - lastLineY) > LINE_THRESHOLD) {
        lineNum++;
        lastLineY = rect.top;
      }

      const absX = Math.round(rect.left + scrollX);
      const absY = Math.round(rect.top + scrollY);
      const cs = getComputedStyle(parent);

      words.push({
        // ── Tesseract互換フィールド ──────────────────────
        level: 5,
        page_num: 1,
        block_num: blockNum,
        par_num: parNum,
        line_num: lineNum,
        word_num: ++wordNum,
        left: absX,          // ← Tesseractの left は絶対座標
        top: absY,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        conf: 100,           // ブラウザ抽出なので信頼度100
        text: match[0],
        // ── 拡張フィールド ───────────────────────────────
        element: parent.tagName.toLowerCase(),
        elementId: parent.id || null,
        elementClasses: [...parent.classList].slice(0, 5).join(' ') || null,
        xpath: getSimpleXPath(parent),
        fontSize: parseFloat(cs.fontSize),
        fontFamily: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        isLink: !!parent.closest('a'),
        inViewport,
        isHidden: !inViewport && !includeOffscreen,
        viewportX: Math.round(rect.left),
        viewportY: Math.round(rect.top),
        absoluteX: absX,     // left の別名（明示的）
        absoluteY: absY,     // top の別名（明示的）
      });
    }
  }

  return words;
}

// ブロックレベル要素かどうか
function isBlockLevel(el) {
  const BLOCK_TAGS = new Set(['DIV','P','H1','H2','H3','H4','H5','H6',
    'SECTION','ARTICLE','ASIDE','MAIN','HEADER','FOOTER','LI','TD','TH',
    'BLOCKQUOTE','PRE','FIGURE','FORM','TABLE']);
  return BLOCK_TAGS.has(el.tagName);
}

// 最近傍ブロック祖先を取得
function findBlockAncestor(el) {
  let node = el;
  while (node && node !== document.body) {
    if (isBlockLevel(node)) return node;
    node = node.parentElement;
  }
  return document.body;
}

// 簡易XPath（ID優先、なければタグ+インデックス）
function getSimpleXPath(el) {
  const parts = [];
  let node = el;
  while (node && node !== document.body) {
    if (node.id) { parts.unshift(`//*[@id="${node.id}"]`); break; }
    const tag = node.tagName.toLowerCase();
    const siblings = [...node.parentElement?.children || []].filter(c => c.tagName === node.tagName);
    const idx = siblings.indexOf(node) + 1;
    parts.unshift(`${tag}[${idx}]`);
    node = node.parentElement;
  }
  return parts.length ? (parts[0].startsWith('//*') ? parts[0] : '/html/body/' + parts.join('/')) : '/html/body';
}
```

### 4.5 ブロック・ライン集約

```javascript
// word配列からline/blockを逆算して集約
function aggregateLines(words) {
  const lineMap = new Map(); // `${block_num}-${line_num}` → word[]
  for (const w of words) {
    const key = `${w.block_num}-${w.line_num}`;
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key).push(w);
  }
  
  return [...lineMap.values()].map((ws, i) => {
    const left   = Math.min(...ws.map(w => w.left));
    const top    = Math.min(...ws.map(w => w.top));
    const right  = Math.max(...ws.map(w => w.left + w.width));
    const bottom = Math.max(...ws.map(w => w.top + w.height));
    return {
      level: 4, page_num: 1,
      block_num: ws[0].block_num, par_num: ws[0].par_num, line_num: ws[0].line_num,
      left, top, width: right - left, height: bottom - top,
      conf: 100,
      text: ws.map(w => w.text).join(' '),
      wordCount: ws.length,
      element: ws[0].element,
      absoluteX: left, absoluteY: top,
      viewportX: ws[0].viewportX, viewportY: ws[0].viewportY,
    };
  });
}
```

### 4.6 テキストプラグイン定義

```javascript
// analyzers/text-coords.js (プラグインとして登録)

export const textCoordsPlugin = {
  id: 'text-coords',
  name: 'Text Coordinate Extractor',
  version: '1.0.0',
  runAt: 'DOMContentLoaded',
  realtime: false,
  priority: 5,                    // UIカタログより先
  requires: [],                   // 全ページで動く
  emitType: 'TEXT_COORDS',
  cacheTarget: 'visual/text-coords.json',

  install(api) {
    // リアルタイム監視: DOMが大幅に変化したら再収集
    let reextractTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(reextractTimer);
      reextractTimer = setTimeout(() => {
        const data = this.collect(api);
        api.emit(this.emitType, data, false);
      }, 1000); // DOM安定後1秒
    });
    // install時点ではbodyがないことも → load後に設置
    window.addEventListener('load', () => {
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    }, { once: true });
  },

  collect(api) {
    const options = api.getConfig().options?.textCoords || {};
    const words = extractTextWithCoords(options);
    const lines = aggregateLines(words);
    const blocks = aggregateBlocks(words);
    
    return {
      capturedAt: Date.now(),
      pageUrl: location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      totalWords: words.length,
      totalLines: lines.length,
      totalBlocks: blocks.length,
      words,          // Tesseract互換
      lines,          // level=4
      blocks,         // level=2
      fullText: words.map(w => w.text).join(' '),
    };
  },

  teardown() {}
};
```

### 4.7 キャッシュ保存先と_index.jsonへの追加

```json
// _index.jsonへの追加分
{
  "files": {
    "text_coords": "visual/text-coords.json"
  },
  "reading_guide": {
    "for_ocr_compatible_text": "visual/text-coords.json",
    "for_visual_automation": ["visual/text-coords.json", "ui/elements.json"]
  }
}
```

---

## 5. フレームワークアダプタシステム

### 5.1 アダプタ一覧と検出シグナル

| アダプタID | 対象 | 検出シグナル | 取得できる情報 |
|------------|------|------------|--------------|
| `react-fiber` | React 16-18+ | `__REACT_DEVTOOLS_GLOBAL_HOOK__` | コンポーネントツリー, hooks, Redux, Router |
| `vue3-devtool` | Vue 3 | `window.__VUE__` or `el.__vueParentComponent` | コンポーネントツリー, reactive state, Pinia |
| `vue2-devtool` | Vue 2 | `window.Vue` or `el.__vue__` | コンポーネントツリー, Vuex store |
| `angular-ng` | Angular 2+ | `window.getAllAngularRootElements` | コンポーネントツリー, services, NgRx |
| `svelte-meta` | Svelte | `el.__svelte_meta` or `window.__svelte__` | コンポーネント定義, stores |
| `preact-fiber` | Preact | `el.__k` (preact vnode) | コンポーネントツリー |
| `alpine-js` | Alpine.js | `window.Alpine` | store, data stacks |
| `solid-js` | Solid.js | `window._$HY` | reactive tree |
| `ember-app` | Ember | `window.Ember.__loader` | route info, services |
| `dom-generic` | 全て（フォールバック） | 常に動く | DOM構造, ARIAツリー, セマンティクス |

### 5.2 アダプタインターフェース

```typescript
interface FrameworkAdapter extends InspectorPlugin {
  // フレームワーク固有
  frameworkId: string;          // 'react' | 'vue3' | 'angular' | ...
  detect(): boolean;            // このアダプタが有効かどうか
  
  // フレームワーク固有の収集
  getComponentTree(): ComponentNode | null;
  getGlobalState(): Record<string, unknown> | null;
  getRoutes(): RouteInfo[] | null;
  getStores(): StoreInfo[] | null;
}

interface ComponentNode {
  name: string;
  type: 'component' | 'element' | 'text' | 'context' | 'provider';
  depth: number;
  props?: Record<string, unknown>;
  state?: Record<string, unknown>;
  children: ComponentNode[];
  // フレームワーク固有の拡張フィールド
  _fw: string;          // どのフレームワークから
  _raw?: unknown;        // デバッグ用（省略可）
}
```

### 5.3 各アダプタの実装詳細

#### React Adapter（既存を移植）

```javascript
// adapters/react.js
export const reactPlugin = {
  id: 'react-fiber',
  frameworkId: 'react',
  name: 'React Fiber Analyzer',
  version: '1.0.0',
  runAt: 'document_start',   // フック設置はdocument_start必須
  realtime: false,
  priority: 10,
  requires: [],
  emitType: 'REACT_SNAPSHOT',
  cacheTarget: 'react/',

  detect() {
    return !!(
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__?._renderers?.size ||
      window.React
    );
  },

  install(api) {
    // 既存のonCommitFiberRootフック設置コード
    // (SPEC.md Section 4.2.1 参照)
  },

  collect(api) {
    // 既存のserializeFiber + collectReactInternals
    // (SPEC.md Section 4.2.2-4 参照)
  }
};
```

#### Vue 3 Adapter

```javascript
// adapters/vue3.js

export const vue3Plugin = {
  id: 'vue3-devtool',
  frameworkId: 'vue3',
  name: 'Vue 3 Analyzer',
  version: '1.0.0',
  runAt: 'load',             // Vue は load 後に初期化完了していることが多い
  realtime: false,
  priority: 10,
  emitType: 'VUE3_SNAPSHOT',
  cacheTarget: 'vue/',

  detect() {
    return !!(window.__VUE__ ||
      document.querySelector('[data-v-app]') ||
      document.querySelector('#app')?.__vue_app__);
  },

  install(api) {
    // Vue 3 の DevTools hook を傍受
    // __VUE_DEVTOOLS_GLOBAL_HOOK__ が存在すれば setup/mountApp を捕捉
    const existing = window.__VUE_DEVTOOLS_GLOBAL_HOOK__;
    if (existing) {
      const _orig = existing.emit?.bind(existing);
      if (_orig) {
        existing.emit = function(event, ...args) {
          if (event === 'app:init') {
            this._SI_app = args[0]; // Vue appインスタンスを保持
          }
          return _orig(event, ...args);
        };
      }
    }
  },

  collect(api) {
    // Vue 3 アプリインスタンスを取得する複数の方法を試す
    const app = this._findVueApp();
    if (!app) return null;

    return {
      version: app.version,
      componentTree: this._traverseVue3(app._instance),
      globalProperties: Object.keys(app.config.globalProperties || {}),
      plugins: app._context.provides ? Object.keys(app._context.provides) : [],
      pinia: this._extractPinia(app),
    };
  },

  _findVueApp() {
    // 方法1: DevTools hookから
    if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__?._SI_app) {
      return window.__VUE_DEVTOOLS_GLOBAL_HOOK__._SI_app;
    }
    // 方法2: DOM要素から
    const root = document.querySelector('[data-v-app]') || document.querySelector('#app');
    if (root?.__vue_app__) return root.__vue_app__;
    // 方法3: windowスキャン
    for (const key of Object.keys(window)) {
      try {
        if (window[key]?._context?.app) return window[key];
      } catch (_) {}
    }
    return null;
  },

  _traverseVue3(instance, depth = 0) {
    if (!instance || depth > 40) return null;
    const node = {
      name: instance.type?.name || instance.type?.__name || 'Anonymous',
      depth,
      props: this._safeClone(instance.props),
      setupState: this._safeClone(instance.setupState),  // script setup の ref 値
      data: this._safeClone(instance.data),
      children: [],
      _fw: 'vue3',
    };
    const subTree = instance.subTree;
    if (subTree?.component) {
      const child = this._traverseVue3(subTree.component, depth + 1);
      if (child) node.children.push(child);
    }
    if (subTree?.children) {
      for (const child of (Array.isArray(subTree.children) ? subTree.children : [])) {
        if (child?.component) {
          const c = this._traverseVue3(child.component, depth + 1);
          if (c) node.children.push(c);
        }
      }
    }
    return node;
  },

  _extractPinia(app) {
    // Piniaの場合 app._context.provides にストアが入る
    try {
      const piniaSymbol = Object.getOwnPropertySymbols(app._context.provides || {})
        .find(s => s.toString().includes('pinia'));
      if (piniaSymbol) {
        const pinia = app._context.provides[piniaSymbol];
        return {
          stores: Object.keys(pinia._s || {}),
          state: Object.fromEntries(
            [...(pinia._s || new Map()).entries()].map(([id, store]) => {
              try { return [id, JSON.parse(JSON.stringify(pinia.state.value[id] || {}))]; }
              catch { return [id, '[unserializable]']; }
            })
          )
        };
      }
    } catch (_) {}
    return null;
  },

  _safeClone(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    try { return JSON.parse(JSON.stringify(obj).slice(0, 2000)); } catch { return '[object]'; }
  },
};
```

#### Angular Adapter

```javascript
// adapters/angular.js

export const angularPlugin = {
  id: 'angular-ng',
  frameworkId: 'angular',
  name: 'Angular Analyzer',
  version: '1.0.0',
  runAt: 'load',
  realtime: false,
  priority: 10,
  emitType: 'ANGULAR_SNAPSHOT',
  cacheTarget: 'angular/',

  detect() {
    return !!(window.getAllAngularRootElements || window.ng || window.angular);
  },

  install(api) {},

  collect(api) {
    // Angular の場合、ng オブジェクトから取得
    if (!window.ng) return null;
    
    const roots = window.getAllAngularRootElements?.() || [];
    const tree = roots.map(el => this._traverseAngular(el));
    
    return {
      version: this._detectVersion(),
      componentTree: tree,
      services: this._getServices(roots[0]),
    };
  },

  _traverseAngular(el, depth = 0) {
    if (!el || depth > 40) return null;
    
    // Angular 2+: ng.getComponent / ng.getDirectives
    let component = null;
    try { component = window.ng.getComponent?.(el); } catch (_) {}
    
    const node = {
      name: component?.constructor?.name || el.tagName?.toLowerCase() || 'unknown',
      depth,
      inputs: null,
      outputs: null,
      children: [],
      _fw: 'angular',
    };
    
    // コンポーネントのinput/outputを取得
    if (component) {
      try {
        const lView = component[Object.getOwnPropertySymbols(component)
          .find(s => s.toString().includes('lView'))];
        if (lView) {
          node.inputs = Object.fromEntries(
            Object.entries(component).filter(([k]) => !k.startsWith('_'))
          );
        }
      } catch (_) {}
    }

    // 子要素を再帰
    for (const child of el.children || []) {
      const c = this._traverseAngular(child, depth + 1);
      if (c) node.children.push(c);
    }
    
    return node;
  },

  _detectVersion() {
    try {
      return window.ng?.getVersion?.() || 
             document.querySelector('[ng-version]')?.getAttribute('ng-version') ||
             null;
    } catch { return null; }
  },

  _getServices(rootEl) {
    try {
      const injector = window.ng?.getInjector?.(rootEl);
      if (!injector) return null;
      // ngRx store の検出
      const store = injector.get?.('Store');
      return store ? { hasNgRx: true } : null;
    } catch { return null; }
  },
};
```

#### Svelte Adapter

```javascript
// adapters/svelte.js

export const sveltePlugin = {
  id: 'svelte-meta',
  frameworkId: 'svelte',
  name: 'Svelte Analyzer',
  version: '1.0.0',
  runAt: 'load',
  realtime: false,
  priority: 10,
  emitType: 'SVELTE_SNAPSHOT',
  cacheTarget: 'svelte/',

  detect() {
    return !!(
      document.querySelector('[data-svelte]') ||
      document.querySelector('[data-svelte-h]') ||
      window.__svelte ||
      document.querySelector('[class*="svelte-"]')
    );
  },

  install(api) {
    // Svelte DevTools hook
    if (!window.__svelte) {
      window.__svelte = { components: [] };
    }
  },

  collect(api) {
    const components = [];
    
    // 方法1: __svelte_meta から
    document.querySelectorAll('[data-svelte-h]').forEach(el => {
      const meta = el.__svelte_meta || el.__s__;
      if (meta) components.push({ source: meta.loc?.file || 'unknown', el: el.tagName });
    });
    
    // 方法2: クラス名パターンから
    const svelteClasses = new Set();
    document.querySelectorAll('[class]').forEach(el => {
      [...el.classList].filter(c => /^svelte-[a-z0-9]+$/.test(c))
        .forEach(c => svelteClasses.add(c));
    });
    
    // 方法3: window.__svelte から
    const globalComponents = window.__svelte?.components || [];
    
    return {
      detectionMethod: components.length > 0 ? 'svelte-meta' : 'class-pattern',
      components,
      svelteHashes: [...svelteClasses],  // コンポーネントのスコープハッシュ
      globalComponents,
    };
  },
};
```

#### Alpine.js Adapter

```javascript
// adapters/alpine.js

export const alpinePlugin = {
  id: 'alpine-js',
  frameworkId: 'alpine',
  name: 'Alpine.js Analyzer',
  version: '1.0.0',
  runAt: 'load',
  realtime: false,
  priority: 10,
  emitType: 'ALPINE_SNAPSHOT',
  cacheTarget: 'alpine/',

  detect() {
    return !!(window.Alpine || document.querySelector('[x-data]'));
  },

  install(api) {},

  collect(api) {
    if (!window.Alpine) return { detected: true, apiAvailable: false };
    
    const components = [];
    document.querySelectorAll('[x-data]').forEach(el => {
      try {
        // Alpine.js v3: el._x_dataStack
        const dataStack = el._x_dataStack;
        components.push({
          element: el.tagName.toLowerCase(),
          id: el.id || null,
          data: dataStack ? JSON.parse(JSON.stringify(dataStack[0] || {}).slice(0, 2000)) : null,
        });
      } catch (_) {
        components.push({ element: el.tagName.toLowerCase(), id: el.id || null, data: null });
      }
    });

    // Alpine.store (global stores)
    const stores = {};
    try {
      const storeProxy = window.Alpine.store();
      if (storeProxy && typeof storeProxy === 'object') {
        for (const key of Object.keys(storeProxy)) {
          try { stores[key] = JSON.parse(JSON.stringify(storeProxy[key]).slice(0, 1000)); }
          catch { stores[key] = '[unserializable]'; }
        }
      }
    } catch (_) {}

    return {
      version: window.Alpine.version || null,
      components,
      stores,
    };
  },
};
```

#### Generic DOM Adapter（フォールバック）

```javascript
// adapters/dom-generic.js
// フレームワーク非依存。全ページで動く。

export const domGenericPlugin = {
  id: 'dom-generic',
  frameworkId: 'vanilla',
  name: 'Generic DOM Analyzer',
  version: '1.0.0',
  runAt: 'load',
  realtime: false,
  priority: 99,           // 最後に動く（他のアダプタのフォールバック）
  emitType: 'DOM_GENERIC_SNAPSHOT',
  cacheTarget: 'dom/',

  detect() { return true; }, // 常にtrue

  install(api) {},

  collect(api) {
    // ARIAセマンティクスツリー
    const ariaTree = this._buildAriaTree(document.body, 0);

    // グローバル変数スキャン（状態管理の手がかり）
    const globals = this._scanGlobals();

    // カスタム要素（Web Components）
    const customElements = this._findCustomElements();

    // グローバルEventListenerの推定（addEventListener をパッチしていた場合のみ）
    
    return {
      ariaTree,
      globals,
      customElements,
      docTitle: document.title,
      documentLang: document.documentElement.lang || null,
      metaTags: this._getMeta(),
    };
  },

  _buildAriaTree(el, depth) {
    if (!el || depth > 20) return null;
    const role = el.getAttribute('aria-role') || el.getAttribute('role') || 
                 this._implicitRole(el);
    if (!role && el.children.length === 0) return null;
    
    const node = {
      tag: el.tagName.toLowerCase(),
      role: role || null,
      label: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || 
             el.getAttribute('title') || null,
      children: [],
    };
    for (const child of el.children) {
      const c = this._buildAriaTree(child, depth + 1);
      if (c) node.children.push(c);
    }
    return node;
  },

  _implicitRole(el) {
    const map = { BUTTON:'button', A:'link', INPUT:'textbox', 
                  NAV:'navigation', MAIN:'main', HEADER:'banner', 
                  FOOTER:'contentinfo', SECTION:'region' };
    return map[el.tagName] || null;
  },

  _scanGlobals() {
    // 既知のグローバル状態オブジェクトを探す
    const candidates = {};
    const INTERESTING = [
      '__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__PRELOADED_STATE__',
      '__APP_STATE__', '__STORE__', '__STATE__', 'APP_DATA', 'CONFIG',
      '__webpack_require__', '__vite_plugin_react_preamble_installed__',
    ];
    for (const key of INTERESTING) {
      try {
        if (key in window && window[key] !== undefined) {
          const v = window[key];
          candidates[key] = typeof v === 'object'
            ? JSON.parse(JSON.stringify(v).slice(0, 500))
            : String(v).slice(0, 200);
        }
      } catch (_) {}
    }
    return candidates;
  },

  _findCustomElements() {
    return [...new Set(
      [...document.querySelectorAll('*')]
        .map(el => el.tagName.toLowerCase())
        .filter(t => t.includes('-'))
    )];
  },

  _getMeta() {
    return [...document.querySelectorAll('meta[name],meta[property]')].map(m => ({
      key: m.getAttribute('name') || m.getAttribute('property'),
      value: m.getAttribute('content'),
    }));
  },
};
```

### 5.4 アダプタ自動検出ロジック

```javascript
// adapters/detector.js

export function detectAndRegister(registry) {
  const ALL_ADAPTERS = [
    reactPlugin,   // document_start必須（最優先）
    vue3Plugin,
    vue2Plugin,
    angularPlugin,
    sveltePlugin,
    preactPlugin,
    alpinePlugin,
    solidPlugin,
    domGenericPlugin,  // フォールバック（常に登録）
  ];

  for (const adapter of ALL_ADAPTERS) {
    registry.register(adapter);
  }

  // 検出結果をemit（どのフレームワークが動いているか）
  window.addEventListener('load', () => {
    const detected = ALL_ADAPTERS
      .filter(a => { try { return a.detect?.(); } catch { return false; } })
      .map(a => ({ id: a.id, frameworkId: a.frameworkId, name: a.name }));
    
    window.postMessage({
      __SITE_INSPECTOR__: true,
      type: 'ADAPTERS_DETECTED',
      payload: detected,
    }, '*');
  });
}
```

---

## 6. 新ディレクトリ構造

```
browser-whiskor/
├── docs/
│   ├── SPEC.md                    ← v1仕様書
│   └── DESIGN_V2.md               ← このファイル（v2設計）
│
├── extension/
│   ├── manifest.json
│   ├── injected/
│   │   ├── plugin-system.js       ★ NEW: PluginRegistry
│   │   ├── activation.js          ★ NEW: アクティベーションモード管理
│   │   ├── collector.js           ↑ 改訂: プラグインシステムのエントリポイントに
│   │   ├── bridge.js              ↑ 改訂: CONFIG_UPDATE の中継を追加
│   │   ├── adapters/
│   │   │   ├── detector.js        ★ NEW: アダプタ自動検出
│   │   │   ├── react.js           ★ NEW: 既存コードをアダプタとして分離
│   │   │   ├── vue3.js            ★ NEW
│   │   │   ├── vue2.js            ★ NEW
│   │   │   ├── angular.js         ★ NEW
│   │   │   ├── svelte.js          ★ NEW
│   │   │   ├── preact.js          ★ NEW
│   │   │   ├── alpine.js          ★ NEW
│   │   │   └── dom-generic.js     ★ NEW: フォールバック
│   │   └── analyzers/
│   │       ├── text-coords.js     ★ NEW: テキスト座標抽出
│   │       ├── network.js         ★ NEW: 既存ネットワークフックを分離
│   │       ├── css.js             ★ NEW: 既存CSS解析を分離
│   │       ├── ui-catalog.js      ★ NEW: 既存UIカタログを分離
│   │       ├── perf.js            ★ NEW: 既存パフォーマンス観測を分離
│   │       └── dom-mutations.js   ★ NEW: 既存DOM監視を分離
│   ├── background/
│   │   └── sw.js                  ↑ 改訂: config制御 + scripting API追加
│   ├── devtools/
│   │   ├── devtools.html
│   │   └── devtools.js
│   └── panel/
│       ├── panel.html             ↑ 改訂: テキスト座標タブ + フレームワーク表示追加
│       └── panel.js
│
├── server/
│   ├── index.js
│   ├── cache-writer.js            ↑ 改訂: TEXT_COORDS, 各fw snapshot の書き込み追加
│   ├── mcp-server.js              ↑ 改訂: text/get_text_coords ツール追加
│   ├── mock-data.js
│   └── dashboard.html
│
├── package.json
├── start.bat
└── start.sh
```

---

## 7. データスキーマ追加分

### 7.1 _index.json 更新版（追加フィールドのみ）

```json
{
  "summary": {
    "detectedAdapters": ["react-fiber", "dom-generic"],
    "textWordCount": 3420,
    "textBlockCount": 89
  },
  "files": {
    "text_coords":       "visual/text-coords.json",
    "vue_snapshot":      "vue/snapshot.json",
    "angular_snapshot":  "angular/snapshot.json",
    "svelte_snapshot":   "svelte/snapshot.json",
    "dom_generic":       "dom/snapshot.json",
    "adapters_detected": "meta.json"
  },
  "reading_guide": {
    "for_ocr_text":        "visual/text-coords.json",
    "for_text_search":     "visual/text-coords.json → words[].text + words[].left/top",
    "for_click_target":    "ui/elements.json or visual/text-coords.json → absoluteX/Y",
    "for_framework_state": "react/redux.json OR vue/snapshot.json OR angular/snapshot.json"
  }
}
```

### 7.2 visual/text-coords.json

```json
{
  "capturedAt": 1715780000000,
  "pageUrl": "https://example.com",
  "viewport": { "width": 1280, "height": 800, "scrollX": 0, "scrollY": 0 },
  "totalWords": 342,
  "totalLines": 58,
  "totalBlocks": 12,
  "fullText": "Welcome to Example Domain ...",
  "words": [
    {
      "level": 5, "page_num": 1,
      "block_num": 1, "par_num": 1, "line_num": 1, "word_num": 1,
      "left": 100, "top": 200, "width": 80, "height": 24,
      "conf": 100, "text": "Welcome",
      "element": "h1", "elementId": null, "elementClasses": "title main-header",
      "xpath": "/html/body/div[1]/h1[1]",
      "fontSize": 32, "fontFamily": "Inter", "fontWeight": "700",
      "fontStyle": "normal", "color": "rgb(31, 35, 40)",
      "backgroundColor": "rgba(0, 0, 0, 0)",
      "isLink": false, "inViewport": true, "isHidden": false,
      "viewportX": 100, "viewportY": 200,
      "absoluteX": 100, "absoluteY": 200
    }
  ],
  "lines": [
    {
      "level": 4, "page_num": 1,
      "block_num": 1, "par_num": 1, "line_num": 1,
      "left": 100, "top": 200, "width": 480, "height": 24,
      "conf": 100, "text": "Welcome to Example Domain",
      "wordCount": 4,
      "element": "h1", "absoluteX": 100, "absoluteY": 200,
      "viewportX": 100, "viewportY": 200
    }
  ],
  "blocks": [
    {
      "level": 2, "page_num": 1, "block_num": 1,
      "left": 80, "top": 180, "width": 520, "height": 200,
      "conf": 100, "text": "Welcome to Example Domain ...",
      "element": "div", "elementId": "main",
      "role": "main",
      "absoluteX": 80, "absoluteY": 180,
      "viewportX": 80, "viewportY": 180
    }
  ]
}
```

---

## 8. 制御フロー詳細

### 8.1 CONFIG_UPDATE の伝播

```
[外部HTTP] POST /api/config { mode: "selective", plugins: { "text-coords": true } }
    ↓
[server/index.js] config を受信
    ↓
[server → sw.js] WS message: { type: "SET_CONFIG", config: {...} }
    ↓
[sw.js] chrome.storage.local.set({ SI_CONFIG: config })
        + chrome.scripting.executeScript (全タブ) でMAIN worldに直接postMessage
    ↓
[collector.js] window.addEventListener('message') で CONFIG_UPDATE 受信
               registry.updateConfig(config) → 各プラグインのON/OFF切り替え
               
[bridge.js] chrome.storage.onChanged → window.postMessage (二重保険)
```

### 8.2 manual収集トリガー

```
[DevTools Panel] ユーザーが「Collect Text」ボタンをクリック
    ↓
[panel.js] port.postMessage({ type: 'MANUAL_COLLECT', plugins: ['text-coords'] })
    ↓
[sw.js] chrome.scripting.executeScript に転送
    ↓
[MAIN world] registry.runAt('manual', api) → textCoordsPlugin.collect()
    ↓
emit('TEXT_COORDS', data) → bridge.js → sw.js → サーバー → キャッシュ書き込み
```

### 8.3 アクティベーションモードの状態遷移

```
             install時
                │
                ▼
    ┌───────────────────────┐
    │   chrome.storage から   │
    │   SI_CONFIG を読み込む  │
    └───────────┬───────────┘
                │
    ┌───────────▼──────────────────────────────────────────────────┐
    │ mode = 'always_on' │ mode = 'manual' │ mode = 'api' | 'selective' │
    │   全プラグイン動く  │  明示的トリガー待ち │  外部制御待ち             │
    └───────────┬─────────────────────────────────────────────────┘
                │ CONFIG_UPDATE
                ▼
         registry.updateConfig()
         → 新しいmode/pluginsに基づいて
           各プラグインのisEnabled() が変化
```

---

## 9. デバッグ設計

### 9.1 ログレベル

```javascript
// 全プラグインの共通ログフォーマット
api.log('info',  '[SI:react-fiber] Fiber snapshot captured, 247 components');
api.log('warn',  '[SI:vue3-devtool] App instance not found via hook, trying DOM method');
api.log('error', '[SI:text-coords] TreeWalker threw:', err);
```

コンソールで確認: `window.__SI_LOGS__` に全ログを配列で保持（最新100件）

### 9.2 プラグイン状態確認

```javascript
// DevTools Consoleで確認可能
window.__SI_REGISTRY__.debug()
// → {
//     installedPlugins: ['react-fiber', 'text-coords', 'dom-generic'],
//     detectedFrameworks: ['react'],
//     config: { mode: 'always_on', ... },
//     lastEmit: { type: 'REACT_SNAPSHOT', ts: 1715780000000, payloadSize: 4832 }
//   }
```

### 9.3 プラグイン手動実行

```javascript
// DevTools ConsoleからプラグインをON/OFF
window.__SI_REGISTRY__.enable('text-coords');
window.__SI_REGISTRY__.disable('dom-mutations');

// 特定プラグインを今すぐ実行
window.__SI_REGISTRY__.runPlugin('text-coords');
```

### 9.4 サーバー側デバッグ

```bash
# 受信メッセージをすべてログ出力
node server/index.js --verbose

# モックデータでダッシュボードを確認
node server/index.js --mock

# 特定のメッセージタイプだけフィルタ
node server/index.js --filter REACT_SNAPSHOT,TEXT_COORDS
```

---

## 10. 実装優先度

### フェーズ1（即実装）

| 項目 | ファイル | 工数目安 |
|------|---------|---------|
| `text-coords.js` アナライザ | `analyzers/text-coords.js` | S |
| `plugin-system.js` | `injected/plugin-system.js` | M |
| `activation.js` | `injected/activation.js` | S |
| bridge.js の CONFIG_UPDATE 対応 | `injected/bridge.js` | S |
| sw.js の SET_CONFIG 対応 | `background/sw.js` | S |
| `dom-generic.js` アダプタ | `adapters/dom-generic.js` | S |
| サーバー `/api/config` エンドポイント | `server/index.js` | S |
| `_index.json` の text_coords フィールド追加 | `server/cache-writer.js` | S |

### フェーズ2（次期）

| 項目 | ファイル | 工数目安 |
|------|---------|---------|
| `react.js` アダプタ（既存コードを移植） | `adapters/react.js` | M |
| `vue3.js` アダプタ | `adapters/vue3.js` | M |
| `angular.js` アダプタ | `adapters/angular.js` | M |
| `svelte.js` アダプタ | `adapters/svelte.js` | S |
| `alpine.js` アダプタ | `adapters/alpine.js` | S |
| MCPツール `get_text_coords` 追加 | `server/mcp-server.js` | S |
| panelにテキスト座標タブ追加 | `panel/panel.html/js` | M |

### フェーズ3（将来）

- Preact / Solid.js / Ember アダプタ
- iframe内コンテンツのテキスト座標（`chrome.scripting` 経由）
- スクロールして画面外のテキストを全取得
- WebSocketフレーム内容の傍受
- Shadow DOM内のテキスト座標

---

## 付録: Tesseract.jsとの互換性比較

| フィールド | Tesseract.js | Site Inspector | 備考 |
|-----------|-------------|----------------|------|
| `level` | ✓ 1-5 | ✓ 1-5 | 完全互換 |
| `page_num` | ✓ | ✓ (常に1) | 互換 |
| `block_num` | ✓ | ✓ | 互換 |
| `par_num` | ✓ | ✓ | 互換 |
| `line_num` | ✓ | ✓ | 互換 |
| `word_num` | ✓ | ✓ | 互換 |
| `left` | ✓ (相対) | ✓ (**絶対座標**) | **差異: SIは scroll込み絶対座標** |
| `top` | ✓ (相対) | ✓ (**絶対座標**) | **差異: 同上** |
| `width` | ✓ | ✓ | 互換 |
| `height` | ✓ | ✓ | 互換 |
| `conf` | ✓ 0-100 | ✓ (常に100) | 互換 |
| `text` | ✓ | ✓ | 完全互換 |
| `element` | ✗ | ✓ 追加 | DOM要素タグ |
| `fontSize` | ✗ | ✓ 追加 | px単位 |
| `fontFamily` | ✗ | ✓ 追加 | |
| `color` | ✗ | ✓ 追加 | rgb() 文字列 |
| `xpath` | ✗ | ✓ 追加 | DOM上の位置 |
| `inViewport` | ✗ | ✓ 追加 | 表示中かどうか |
| `absoluteX/Y` | ✗ | ✓ 追加 | left/topの別名（明示的） |
| `viewportX/Y` | ✗ | ✓ 追加 | ビューポート相対 |

**使用側での互換処理（最小コード）:**
```javascript
// Tesseract互換として使う場合、Tesseractが返した座標とのズレに注意
// Site Inspectorのleft/topはscroll込みの絶対座標なので、
// ビューポート相対で使いたい場合は viewportX/Y を使う

const words = textCoords.words;
// Tesseract互換ライブラリに渡す場合
const tesseractFormat = words.map(w => ({ ...w, left: w.viewportX, top: w.viewportY }));
```
