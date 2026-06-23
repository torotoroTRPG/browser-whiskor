/**
 * server/mcp/resources.js
 * MCP resources プリミティブ — 収集済みセッションを読み取り可能な context として公開。
 *
 * resources は「エージェントが文脈として添付できるデータ」を宣言する MCP の
 * プリミティブ。browser-whiskor はタブごとの観測結果（フレームワーク状態・
 * UIカタログ・ネットワーク等）をセッションとして保持しているので、それを
 *   - whiskor://sessions          … 全アクティブセッションの一覧 (常設)
 *   - whiskor://session/{tabId}   … 1セッションの詳細 (テンプレート + 動的列挙)
 * として読み取り可能にする。
 *
 * データは registry の `cache` callback 経由で取る:
 *   - 非proxyモード: in-process の cache（同期）
 *   - proxyモード:   worker への HTTP 転送（Promise）
 * どちらも await すれば同じに扱える。cache 未配線時は空一覧へ degrade する
 * （resources capability 自体は宣言を保つ＝壊れない）。
 */
'use strict';

const SESSIONS_URI = 'whiskor://sessions';
const SESSION_PREFIX = 'whiskor://session/';
const JSON_MIME = 'application/json';

function getCache(callbacks) {
  return callbacks && callbacks.cache ? callbacks.cache : null;
}

// 常設リソース + アクティブな各セッションを具体リソースとして列挙する。
async function listResources(callbacks) {
  const resources = [{
    uri: SESSIONS_URI,
    name: 'Active sessions',
    description: 'List of all browser tabs currently instrumented by whiskor (tabId, title, url).',
    mimeType: JSON_MIME,
  }];

  const cache = getCache(callbacks);
  if (cache && typeof cache.getSessionList === 'function') {
    try {
      const list = (await cache.getSessionList({ brief: true })) || [];
      for (const s of list) {
        if (s == null || s.tabId === undefined) continue;
        const label = s.title || s.url || `tab ${s.tabId}`;
        resources.push({
          uri: `${SESSION_PREFIX}${s.tabId}`,
          name: `Session: ${label}`,
          description: `Collected perception data for tab ${s.tabId}${s.url ? ` (${s.url})` : ''}.`,
          mimeType: JSON_MIME,
        });
      }
    } catch {
      // degrade to the static resource only — never fail the list
    }
  }
  return resources;
}

// パラメータ付きリソースのテンプレート宣言。セッションが1つも無くても
// 「session/{tabId} という形のリソースが読める」ことをクライアントに示せる。
function listResourceTemplates() {
  return [{
    uriTemplate: `${SESSION_PREFIX}{tabId}`,
    name: 'Session detail',
    description: 'Full collected perception data for a single tab by its id.',
    mimeType: JSON_MIME,
  }];
}

// 1リソースを読み取る。未知の uri は -32602 で投げ、transport が JSON-RPC
// エラーに変換する。
async function readResource(uri, callbacks) {
  const cache = getCache(callbacks);

  if (uri === SESSIONS_URI) {
    const list = cache && typeof cache.getSessionList === 'function'
      ? ((await cache.getSessionList({ brief: true })) || [])
      : [];
    return contents(uri, list);
  }

  if (uri.startsWith(SESSION_PREFIX)) {
    const tabId = uri.slice(SESSION_PREFIX.length);
    if (!tabId) throw invalid(`Missing tabId in resource uri: ${uri}`);
    if (!cache || typeof cache.getSessionData !== 'function') {
      throw invalid(`Session data is not available in this mode.`);
    }
    const data = await cache.getSessionData(tabId);
    if (!data) throw invalid(`No session found for tab ${tabId}.`);
    return contents(uri, data);
  }

  throw invalid(`Unknown resource uri: ${uri}. Known: ${SESSIONS_URI}, ${SESSION_PREFIX}{tabId}.`);
}

function contents(uri, value) {
  return { contents: [{ uri, mimeType: JSON_MIME, text: JSON.stringify(value, null, 2) }] };
}

function invalid(message) {
  const err = new Error(message);
  err.code = -32602;
  return err;
}

module.exports = {
  listResources,
  listResourceTemplates,
  readResource,
  SESSIONS_URI,
  SESSION_PREFIX,
};
