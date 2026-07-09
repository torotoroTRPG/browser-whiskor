/**
 * server/pattern-registry.js
 *
 * UIパターン定義の永続化レジストリ。
 * pnpmのハードリンクのように「定義は1回だけ保存、後は参照IDで共有」。
 *
 * パターン種類:
 *   - motion: 要素の動き（スクロール、スライド、フェード等）
 *   - appearance: 新規出現パターン（モーダル、トースト等）
 *   - state_change: 状態変化パターン（ローディング→完了等）
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
// WHISKOR_PATTERN_DIR: test isolation (mirrors WHISKOR_CACHE_DIR). Parallel test
// processes sharing the default dir race clearAll() against saveIndex().
const PATTERN_DIR = process.env.WHISKOR_PATTERN_DIR || path.join(__dirname, 'cache', 'patterns');
const INDEX_FILE  = path.join(PATTERN_DIR, 'index.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(PATTERN_DIR)) {
    fs.mkdirSync(PATTERN_DIR, { recursive: true });
  }
}

function hashPattern(def) {
  // 定義の正規化されたJSONからSHA-256ハッシュの先頭8桁
  const normalized = JSON.stringify(def, Object.keys(def).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

function loadIndex() {
  ensureDir();
  if (fs.existsSync(INDEX_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveIndex(index) {
  // The registry is a best-effort persistence cache: losing one save must not
  // crash delta aggregation. ENOENT here means another process (tests) removed
  // the directory between ensureDir and the write — recreate and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ensureDir();
      fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
      return;
    } catch (e) {
      if (attempt === 1) console.warn(`[pattern-registry] index save failed: ${e.message}`);
    }
  }
}

// ── Pattern Classification ────────────────────────────────────────────────────
function classifyPattern(delta) {
  // 動きのパターンを自動分類
  const { vector, elements, contentChange } = delta;

  // スクロール検知: 大部分の要素が同じベクトルで動いている
  if (vector && elements && elements.length > 3) {
    const sameVector = elements.filter(e =>
      Math.abs(e.dx - vector.x) < 2 && Math.abs(e.dy - vector.y) < 2
    ).length;
    if (sameVector > elements.length * 0.7) {
      return {
        type: 'motion',
        subtype: 'scroll',
        label: `scroll_${vector.x > 0 ? 'right' : vector.x < 0 ? 'left' : 'vertical'}_${Math.abs(vector.y || vector.x)}`,
      };
    }
  }

  // 部分移動: 一部の要素グループが同じベクトルで動く
  if (vector && elements && elements.length > 0) {
    return {
      type: 'motion',
      subtype: 'slide',
      label: `slide_${vector.x}_${vector.y}_${elements.length}elems`,
    };
  }

  // コンテンツ変化
  if (contentChange) {
    return {
      type: 'state_change',
      subtype: contentChange.subtype || 'text',
      label: `${contentChange.subtype || 'text'}_${(contentChange.newText || '').slice(0, 20)}`,
    };
  }

  // 新規出現
  if (delta.appeared) {
    return {
      type: 'appearance',
      subtype: delta.appeared.subtype || 'element',
      label: `appear_${delta.appeared.subtype || 'element'}_${(delta.appeared.text || '').slice(0, 20)}`,
    };
  }

  return { type: 'unknown', subtype: 'generic', label: 'generic' };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * パターンを登録。既存なら ref のみ、新規なら定義も返す。
 * @param {string} tabId - タブID
 * @param {object} delta - 差分データ
 * @returns {{ ref: string, isNew: boolean, def?: object }}
 */
function registerPattern(tabId, delta) {
  const classification = classifyPattern(delta);
  // Hashable definition (excludes timestamps and volatile fields)
  const hashDef = {
    ...classification,
    vector: delta.vector || null,
    elementCount: delta.elements?.length || 0,
    contentChange: delta.contentChange || null,
    appeared: delta.appeared || null,
  };

  const hash = hashPattern(hashDef);
  const ref = `pat-${hash}`;
  const index = loadIndex();

  if (index[ref]) {
    // 既存パターン → 参照のみ
    index[ref].lastSeen = Date.now();
    index[ref].seenCount = (index[ref].seenCount || 1) + 1;
    saveIndex(index);
    return { ref, isNew: false };
  }

  // 新規パターン → 定義を保存
  const def = {
    ...hashDef,
    sampleIds: (delta.elements || []).slice(0, 3).map(e => e.id),
    firstSeen: Date.now(),
  };
  const detailPath = path.join(PATTERN_DIR, `${ref}.json`);
  fs.writeFileSync(detailPath, JSON.stringify(def, null, 2), 'utf8');

  index[ref] = {
    label: classification.label,
    type: classification.type,
    firstSeen: def.firstSeen,
    lastSeen: def.firstSeen,
    seenCount: 1,
    tabId,
  };
  saveIndex(index);

  return { ref, isNew: true, def };
}

/**
 * パターンの詳細を取得（lookup_pattern MCP用）
 * @param {string} ref - パターン参照ID
 * @returns {object|null}
 */
function getPatternDetail(ref) {
  const index = loadIndex();
  if (!index[ref]) return null;

  const detailPath = path.join(PATTERN_DIR, `${ref}.json`);
  if (!fs.existsSync(detailPath)) return null;

  try {
    const detail = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
    return {
      ref,
      ...detail,
      meta: index[ref],
    };
  } catch {
    return null;
  }
}

/**
 * タブに関連するパターン一覧を取得
 * @param {string} tabId
 * @returns {Array}
 */
function getPatternsForTab(tabId) {
  const index = loadIndex();
  return Object.entries(index)
    .filter(([, meta]) => meta.tabId === tabId)
    .map(([ref, meta]) => ({ ref, ...meta }));
}

/**
 * パターンレジストリをクリア（テスト用）
 */
function clearAll() {
  if (fs.existsSync(PATTERN_DIR)) {
    fs.rmSync(PATTERN_DIR, { recursive: true, force: true });
  }
}

module.exports = {
  registerPattern,
  getPatternDetail,
  getPatternsForTab,
  hashPattern,
  classifyPattern,
  clearAll,
  PATTERN_DIR,
};
