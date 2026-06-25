/**
 * analyzers/source-fetcher.js  —  MAIN world
 *
 * Intelligence Layer: Source Layer (Subsystem 2)
 *
 * SOURCE_CATALOGが収集したURL一覧を元に、CSSおよびJSファイルの
 * テキストコンテンツを取得・ハッシュ化し、クロスセッションの
 * ファイル変更検出（SOURCE_CHANGED）を可能にする。
 *
 * Acquisition levels:
 *   Level 1 — chrome.devtools.inspectedWindow.getResources() (DevTools only)
 *   Level 2 — document.styleSheets cssRules (same-origin CSS)
 *   Level 3 — fetch() with CORS check
 *   Level 4 — URL + hash-only (no text available)
 *
 * Emits: SOURCE_CONTENT (per file)
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  // ── FNV-32 hash (same algorithm as state-fingerprint) ─────────────────────
  function fnv32(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  // ── Simple SHA-256-like fingerprint using fnv32 on chunks ─────────────────
  // Note: For proper SHA-256 we'd need crypto.subtle, but for content-change
  // detection purposes FNV-32 on the full text is sufficient and synchronous.
  function hashContent(text) {
    return fnv32(text) + '_' + text.length;
  }

  // ── Fetch with CORS pre-check ──────────────────────────────────────────────
  async function fetchText(url) {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
    try {
      const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!r.ok) return null;
      return await r.text();
    } catch (_) { return null; }
  }

  // ── MIME type classifier ───────────────────────────────────────────────────
  function classifyUrl(url) {
    if (!url) return null;
    const u = url.split('?')[0].toLowerCase();
    if (u.endsWith('.css'))                           return 'css';
    if (u.endsWith('.js') || u.endsWith('.mjs'))      return 'js';
    if (u.match(/\/(css|styles?)\b/))                 return 'css';
    if (u.match(/\/(js|scripts?|bundle)\b/))          return 'js';
    return null;
  }

  // ── Main collect ──────────────────────────────────────────────────────────
  registry.register({
    id:          'source-fetcher',
    name:        'Source Layer Fetcher',
    version:     '1.0.0',
    runAt:       'load',
    realtime:    false,
    priority:    7,
    emitType:    'SOURCE_CONTENT',
    dependencies: ['css', 'css-origin'],

    install(api) {},

    async collect(api, ctx) {
      const cfg = api.getConfig()?.plugins?.intelligence?.sourceFetcher || {};
      if (cfg.enabled === false) return null;

      const storeJs        = cfg.storeJs          || false;
      const maxCssBytes    = cfg.maxCssSizeBytes   || 524288;  // 512 KB
      const maxJsBytes     = cfg.maxJsSizeBytes    || 5242880; // 5 MB
      const updateDetect   = cfg.updateDetection   !== false;

      // Gather URLs: from ctx, from document.styleSheets, and from script tags
      const urls = new Set();

      // From explicit context (e.g. SOURCE_CATALOG data passed in)
      if (ctx && Array.isArray(ctx.urls)) {
        for (const u of ctx.urls) urls.add(u);
      }

      // CSS stylesheets from CSSOM
      for (const sheet of document.styleSheets) {
        if (sheet.href) urls.add(sheet.href);
      }

      // Script tags
      for (const s of document.querySelectorAll('script[src]')) {
        urls.add(s.src);
      }
      // Link tags (preload, modulepreload)
      for (const l of document.querySelectorAll('link[href][rel]')) {
        if (l.rel.includes('stylesheet') || l.rel.includes('preload')) {
          urls.add(l.href);
        }
      }

      const results = [];
      const previousHashes = ctx?.previousHashes || {};

      for (const url of urls) {
        const kind = classifyUrl(url);
        if (!kind) continue;
        if (kind === 'js' && !storeJs) {
          // Hash-only for JS
          const text = await fetchText(url);
          if (!text) {
            results.push({ url, kind, acquisition_level: 4, hash: null, byteLength: null, stored: false });
            continue;
          }
          const hash = hashContent(text);
          const changed = updateDetect && previousHashes[url] && previousHashes[url] !== hash;
          results.push({
            url, kind,
            acquisition_level: 3,
            hash,
            byteLength: text.length,
            stored: false,
            changed,
            previousHash: changed ? previousHashes[url] : null,
          });
          continue;
        }

        // CSS (and JS if storeJs=true): fetch full text
        const text = await fetchText(url);
        if (!text) {
          results.push({ url, kind, acquisition_level: 4, hash: null, byteLength: null, stored: false });
          continue;
        }

        const maxBytes = kind === 'js' ? maxJsBytes : maxCssBytes;
        if (text.length > maxBytes) {
          // Exceeds cap: hash only
          const hash = hashContent(text);
          results.push({ url, kind, acquisition_level: 3, hash, byteLength: text.length, stored: false, capped: true });
          continue;
        }

        const hash = hashContent(text);
        const changed = updateDetect && previousHashes[url] && previousHashes[url] !== hash;

        results.push({
          url, kind,
          acquisition_level: 3,
          hash,
          byteLength: text.length,
          stored: true,
          content: text,
          changed,
          previousHash: changed ? previousHashes[url] : null,
        });
      }

      return {
        timestamp: Date.now(),
        files: results,
        count: results.length,
      };
    },
  });

})();
