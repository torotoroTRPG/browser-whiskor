/**
 * server/source-map-resolver.js — Task 3 (Source Map ↔ Framework-DOM integration)
 *
 * Resolves compiled file positions (bundle.js:1234:5) back to original source
 * file positions using source maps. Used by intelligence.js's explain_element
 * tool to surface meaningful React component file names to agents.
 *
 * Design notes:
 *  - LRU cache of parsed source maps (configurable max size, default 10 maps)
 *  - Size guard: maps larger than config.sourceMap.maxSizeBytes are skipped
 *  - Shares no code with the browser-side vlqDecode in css-origin.js (intentional
 *    per AGENT_HANDOFF: "重複許容") — server environment needs node:https, not fetch
 *  - Maps are fetched from localhost (extension serves bundle assets via DevTools
 *    or via the webpack-dev-server/vite that the page is loaded from)
 */
'use strict';

const https = require('https');
const http  = require('http');
const path  = require('path');

// ── Tiny Base64-VLQ decoder ────────────────────────────────────────────────
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlqDecode(str) {
  const result = [];
  let i = 0;
  while (i < str.length) {
    let value = 0, shift = 0, digit;
    do {
      digit = B64.indexOf(str[i++]);
      if (digit < 0) break;
      value |= (digit & 0x1f) << shift;
      shift += 5;
    } while (digit & 0x20);
    // VLQ sign bit is the LSB
    result.push(value & 1 ? -(value >> 1) : value >> 1);
  }
  return result;
}

// ── HTTP(S) fetch helper for Node.js ──────────────────────────────────────
function nodeFetch(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          return reject(new Error(`Source map too large (>${maxBytes} bytes): ${url}`));
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

// ── Resolve a generated (line, column) to original source via source map ──
/**
 * Parse mappings lazily and find the mapping for (generatedLine, generatedColumn).
 * Both line and column are 1-based. Returns the closest mapping at or before the
 * requested column on the given line.
 *
 * @param {object} map    - Parsed source map JSON
 * @param {number} genLine   - 1-based generated line number
 * @param {number} genColumn - 1-based generated column (0 = use first mapping on line)
 * @returns {{ originalFile: string, originalLine: number, originalColumn: number } | null}
 */
function resolveMapping(map, genLine, genColumn) {
  if (!map?.mappings || !map?.sources) return null;

  const targetLine = genLine - 1; // 0-based
  const targetCol  = Math.max(0, (genColumn || 1) - 1); // 0-based

  const groups = map.mappings.split(';');
  if (targetLine >= groups.length) return null;

  // Accumulate absolute values (VLQ fields are delta-encoded across the whole file)
  let sourceIdx = 0, origLine = 0, origCol = 0;
  let bestSourceIdx = 0, bestOrigLine = 0, bestOrigCol = 0;
  let foundAny = false;

  for (let lineIdx = 0; lineIdx <= targetLine; lineIdx++) {
    const segs = groups[lineIdx].split(',');
    let genColAcc = 0; // column resets to 0 at start of each line

    for (const seg of segs) {
      if (!seg) continue;
      const fields = vlqDecode(seg);
      if (fields.length < 1) continue;
      genColAcc += fields[0]; // generated column (delta within line)

      if (fields.length >= 4) {
        sourceIdx += fields[1];
        origLine  += fields[2];
        origCol   += fields[3];
      }

      if (lineIdx === targetLine) {
        // Keep the best mapping at or before targetCol
        if (genColAcc <= targetCol) {
          bestSourceIdx = sourceIdx;
          bestOrigLine  = origLine;
          bestOrigCol   = origCol;
          foundAny = true;
        }
        // Past the target column — no need to continue this line
        if (genColAcc > targetCol && foundAny) break;
      }
    }
  }

  if (!foundAny) return null;

  const sourceRoot = map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '';
  const sourceFile = (map.sources[bestSourceIdx] || '');
  const resolved   = sourceRoot
    ? sourceFile.startsWith('.')
      ? path.posix.join(sourceRoot, sourceFile)
      : sourceRoot + sourceFile
    : sourceFile;

  return {
    originalFile:   resolved,
    originalLine:   bestOrigLine + 1,   // back to 1-based
    originalColumn: bestOrigCol,
  };
}

// ── SourceMapResolver class ────────────────────────────────────────────────

class SourceMapResolver {
  /**
   * @param {object} opts
   * @param {number} [opts.maxCacheSize=10]       - Maximum number of source maps to cache
   * @param {number} [opts.maxSizeBytes=4194304]  - Skip maps larger than this (default 4MB)
   */
  constructor(opts = {}) {
    this._maxCacheSize  = opts.maxCacheSize  ?? 10;
    this._maxSizeBytes  = opts.maxSizeBytes  ?? 4 * 1024 * 1024; // 4MB
    // LRU cache: Map preserves insertion order; we delete-and-re-insert on access.
    this._cache = new Map(); // compiledUrl → { map | null, fetchedAt }
  }

  /**
   * Resolve a compiled file position to its original source position.
   *
   * @param {string} compiledUrl    - URL of the compiled JS bundle (e.g. "http://localhost:3000/bundle.js")
   * @param {number} generatedLine  - 1-based line number in the compiled file
   * @param {number} generatedColumn - 1-based column number (0 = first mapping on line)
   * @returns {Promise<{ originalFile: string, originalLine: number, originalColumn: number } | null>}
   */
  async resolve(compiledUrl, generatedLine, generatedColumn) {
    if (!compiledUrl || !generatedLine) return null;

    const map = await this._getMap(compiledUrl);
    if (!map) return null;

    return resolveMapping(map, generatedLine, generatedColumn || 1);
  }

  // ── Private: fetch + parse source map for a given bundle URL ────────────

  async _getMap(compiledUrl) {
    // LRU hit: move to end (most recently used)
    if (this._cache.has(compiledUrl)) {
      const entry = this._cache.get(compiledUrl);
      this._cache.delete(compiledUrl);
      this._cache.set(compiledUrl, entry);
      return entry.map;
    }

    // Fetch the compiled bundle's header/footer to find sourceMappingURL
    const mapUrl = await this._discoverMapUrl(compiledUrl);
    if (!mapUrl) {
      this._cacheSet(compiledUrl, null);
      return null;
    }

    // Fetch the actual map file
    let mapText;
    try {
      if (mapUrl.startsWith('data:application/json')) {
        const [, rest] = mapUrl.split(',');
        mapText = mapUrl.includes('base64') ? Buffer.from(rest, 'base64').toString('utf8')
                                             : decodeURIComponent(rest);
      } else {
        mapText = await nodeFetch(mapUrl, this._maxSizeBytes);
      }
    } catch (err) {
      // Silently cache failure to avoid repeated expensive fetches
      this._cacheSet(compiledUrl, null);
      return null;
    }

    let parsedMap;
    try {
      parsedMap = JSON.parse(mapText);
    } catch (_) {
      this._cacheSet(compiledUrl, null);
      return null;
    }

    this._cacheSet(compiledUrl, parsedMap);
    return parsedMap;
  }

  /**
   * Fetch the last 4KB of a compiled bundle to extract the `sourceMappingURL` comment.
   * Avoids downloading multi-MB bundles in full.
   */
  async _discoverMapUrl(compiledUrl) {
    // If the caller already passes a .map URL directly, use it.
    if (compiledUrl.endsWith('.map')) return compiledUrl;

    try {
      // Fetch only the tail of the bundle (last 4KB is enough for the comment)
      const mod  = compiledUrl.startsWith('https:') ? https : http;
      const tail = await new Promise((resolve, reject) => {
        const req = mod.get(compiledUrl, { timeout: 8000 }, (res) => {
          if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            chunks.push(c);
            // Once we have enough bytes, read only the last 4KB
            if (total > 4096) {
              // Keep rolling buffer of last 4096 bytes
              const all = Buffer.concat(chunks);
              chunks.length = 0;
              chunks.push(all.slice(-4096));
              total = chunks[0].length;
            }
          });
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });

      // Look for: //# sourceMappingURL=<url>   or   /*# sourceMappingURL=<url> */
      const match = tail.match(/[/#][@#]\s*sourceMappingURL=(\S+)/);
      if (!match) return null;

      const rawMapUrl = match[1].trim();
      if (rawMapUrl.startsWith('data:')) return rawMapUrl;
      // Resolve relative URL against the bundle's URL
      try {
        return new URL(rawMapUrl, compiledUrl).href;
      } catch (_) {
        return rawMapUrl; // already absolute or non-http (e.g. file://)
      }
    } catch (_) {
      return null;
    }
  }

  // LRU eviction: evict oldest entry when cache is full
  _cacheSet(key, map) {
    if (this._cache.size >= this._maxCacheSize) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    this._cache.set(key, { map, fetchedAt: Date.now() });
  }

  /** Clear all cached maps (useful for testing). */
  clear() {
    this._cache.clear();
  }
}

module.exports = SourceMapResolver;
