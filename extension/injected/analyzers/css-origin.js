/**
 * analyzers/css-origin.js  —  MAIN world
 *
 * Intelligence Layer: CSS Origin Tracker (Subsystem 1)
 *
 * 指定したDOM要素の各CSSプロパティについて、どのスタイルシートの
 * どのルールが適用されているかを特定し、ソースファイルへ遡る。
 *
 * Acquisition levels (fallback chain):
 *   Level 1 — chrome.devtools.inspectedWindow.getResources()  (DevTools context only)
 *   Level 2 — document.styleSheets[i].cssRules traversal (same-origin / CORS-OK)
 *   Level 3 — fetch(styleSheet.href)                          (CORS-permissive sheets)
 *   Level 4 — URL + inline record only
 *
 * Output: CSS_ORIGIN_MAP message via plugin emit path.
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  // ── Specificity computation ────────────────────────────────────────────────
  // S(selector) → packed 32-bit integer: id*65536 + (class+attr+pseudo)*256 + element
  function computeSpecificity(selectorText) {
    let ids = 0, classes = 0, elements = 0;
    // Strip pseudo-elements (count as element) and :not/:is/:where content
    let s = selectorText;

    // :where() contributes 0 specificity; remove it including its argument
    s = s.replace(/:where\([^)]*\)/g, '');
    // :is() — count highest specificity of arguments (simplified: treat as 1 class)
    s = s.replace(/:is\([^)]*\)/g, '.is-placeholder');
    // :not() — count its content but not :not itself
    s = s.replace(/:not\(([^)]*)\)/g, '$1');

    // Pseudo-elements count as 1 element
    const pseudoEls = (s.match(/::[\w-]+/g) || []).length;
    elements += pseudoEls;
    s = s.replace(/::[\w-]+/g, '');

    // IDs
    ids = (s.match(/#[\w-]+/g) || []).length;
    s = s.replace(/#[\w-]+/g, '');

    // Classes, attributes, pseudo-classes
    classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
    s = s.replace(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g, '');

    // Elements/pseudo-elements (remaining word tokens, excluding * and combinators)
    const elMatches = s.match(/[a-zA-Z][\w-]*/g) || [];
    elements += elMatches.length;

    return ids * 65536 + classes * 256 + elements;
  }

  // ── Unique selector for an element ────────────────────────────────────────
  function computeSelector(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return el?.tagName?.toLowerCase() || 'unknown';
    }
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && depth < 5) {
      let seg = cur.tagName.toLowerCase();
      const cls = [...(cur.classList || [])].filter(c => !/^[a-z]{1,3}-[a-zA-Z0-9]{4,8}$/.test(c) && !/^\d/.test(c));
      if (cls.length) seg += '.' + CSS.escape(cls[0]);
      const par = cur.parentElement;
      if (par) {
        const sibs = [...par.children].filter(s => s.tagName === cur.tagName);
        if (sibs.length > 1) seg += `:nth-child(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = par; depth++;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  // ── Level 1: Request DevTools getResources() via postMessage bridge ─────────
  // DevTools context (devtools.js) holds the only handle to getResources().
  // We send a request with a correlation ID, devtools.js calls getResources(),
  // strips non-CSS entries, and posts the result back via SW → executeScript.
  // Resolves once the response arrives or times out (500 ms → fallback).
  let _level1Cache = null;     // Session-scoped cache: Map<href, { content, sourceMapURL }>
  let _level1Pending = null;   // Promise<Map> while an in-flight request is active

  function requestLevel1Resources() {
    if (_level1Cache) return Promise.resolve(_level1Cache);
    if (_level1Pending) return _level1Pending;

    _level1Pending = new Promise((resolve) => {
      const reqId = `css1-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onResponse);
        _level1Pending = null;
        resolve(new Map()); // graceful fallback to Level 2+
      }, 500);

      function onResponse(event) {
        if (event.source !== window) return;
        const d = event.data;
        if (!d?.__BROWSER_WHISKOR__) return;
        if (d.type !== 'CSS_ORIGIN_RESOURCE_RESPONSE') return;
        if (d.reqId !== reqId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', onResponse);
        _level1Pending = null;
        const map = new Map();
        for (const item of (d.resources || [])) {
          if (item.href && item.content != null) {
            map.set(item.href, { content: item.content, sourceMapURL: item.sourceMapURL || null });
          }
        }
        _level1Cache = map;
        resolve(map);
      }

      window.addEventListener('message', onResponse);
      // bridge.js forwards to SW → panel port → devtools.js
      window.postMessage({
        __BROWSER_WHISKOR__: true,
        type: 'CSS_ORIGIN_RESOURCE_REQUEST',
        reqId,
      }, '*');
    });
    return _level1Pending;
  }

  // ── Tiny Base64-VLQ decoder for sourcemap resolution ─────────────────────
  // Based on the Source Map Spec (https://sourcemaps.info/spec.html)
  // Resolves a generated line/column → { source, originalLine, originalColumn }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_MAP = new Map();
  for (let i = 0; i < B64.length; i++) B64_MAP.set(B64[i], i);

  function vlqDecode(str) {
    const result = [];
    let i = 0;
    while (i < str.length) {
      let value = 0, shift = 0, digit;
      do {
        digit = B64_MAP.get(str[i++]);
        if (digit === undefined) break;
        value |= (digit & 0x1f) << shift;
        shift += 5;
      } while (digit & 0x20);
      if (digit === undefined) break;
      // VLQ sign bit is the LSB
      result.push(value & 1 ? -(value >> 1) : value >> 1);
    }
    return result;
  }

  // Session-scoped sourcemap cache to avoid re-fetching
  const _sourceMapCache = new Map(); // mapURL → parsed map | null

  async function fetchSourceMap(sheetHref, sourceMapURL) {
    if (!sourceMapURL) return null;
    const resolvedURL = sourceMapURL.startsWith('data:')
      ? sourceMapURL
      : new URL(sourceMapURL, sheetHref).href;
    if (_sourceMapCache.has(resolvedURL)) return _sourceMapCache.get(resolvedURL);

    try {
      let mapText;
      if (resolvedURL.startsWith('data:application/json')) {
        // Inline sourcemap: data:application/json;base64,...  or data:...;charset=utf-8,...
        const [, rest] = resolvedURL.split(',');
        mapText = resolvedURL.includes('base64')
          ? atob(rest)
          : decodeURIComponent(rest);
      } else {
        const r = await fetch(resolvedURL, { credentials: 'omit', cache: 'default' });
        if (!r.ok) { _sourceMapCache.set(resolvedURL, null); return null; }
        mapText = await r.text();
      }
      const map = JSON.parse(mapText);
      _sourceMapCache.set(resolvedURL, map);
      return map;
    } catch (_) {
      _sourceMapCache.set(resolvedURL, null);
      return null;
    }
  }

  // Given a parsed sourcemap and a 1-based generated line, return the first
  // mapping on that line: { originalFile, originalLine, originalColumn }
  function resolveSourceLine(map, generatedLine) {
    if (!map?.mappings || !map?.sources) return null;
    // Parse mappings lazily up to the target line (0-based internally)
    const targetLine = generatedLine - 1;
    const groups = map.mappings.split(';');
    if (targetLine >= groups.length) return null;

    let sourceIdx = 0, origLine = 0, origCol = 0;

    for (let lineIdx = 0; lineIdx <= targetLine; lineIdx++) {
      const segs = groups[lineIdx].split(',');
      for (const seg of segs) {
        if (!seg) continue;
        const fields = vlqDecode(seg);
        if (fields.length >= 4) {
          sourceIdx += fields[1];
          origLine  += fields[2];
          origCol   += fields[3];
        }
      }
    }

    const sourceFile = (map.sourceRoot || '') + (map.sources[sourceIdx] || '');
    return {
      originalFile: sourceFile,
      originalLine: origLine + 1,    // back to 1-based
      originalColumn: origCol,
    };
  }

  // ── Fetch source text of a stylesheet (Level 3) ───────────────────────────
  async function tryFetchSheet(href) {
    if (!href || href.startsWith('blob:') || href.startsWith('data:')) return null;
    try {
      const r = await fetch(href, { credentials: 'omit', cache: 'no-store' });
      if (!r.ok) return null;
      const acao = r.headers.get('access-control-allow-origin');
      // Accept same-origin (no header) or explicit CORS
      if (href.startsWith(location.origin) || acao) {
        return await r.text();
      }
      return null;
    } catch (_) { return null; }
  }

  // ── Source line estimation from raw CSS text ──────────────────────────────
  function findRuleLineInSource(sourceText, selectorText) {
    if (!sourceText || !selectorText) return null;
    const lines = sourceText.split('\n');
    const needle = selectorText.trim().replace(/\s+/g, '\\s+');
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, (c) => {
      // escape regex but keep \s+ we inserted
      return c === '\\' ? c : `\\${c}`;
    }));
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(selectorText) || re.test(lines[i])) return i + 1;
    }
    return null;
  }

  // ── Recursive rule flattener for @layer, @scope, @media, @supports ─────────
  // Returns flat array of { rule: CSSStyleRule, layerOrder: number, inScope: boolean, scopeProximity: number }
  //
  // layerOrder semantics (per CSS Cascade 5 spec):
  //   - unlayered styles win over all layered styles → layerOrder = Infinity
  //   - among layered styles, LATER-declared layer wins → higher layerOrder number wins
  //   - layerOrder 0 = first declared, 1 = second, etc.
  //
  // scopeProximity semantics (per CSS Cascading 4 @scope spec):
  //   - rules inside @scope have a "proximity" score: how close the scope root is to the target element
  //   - proximity overrides specificity (CSS Cascading 4: proximity > specificity)
  //   - un-scoped rules get scopeProximity = -1 (lose to any scoped rule at same layerOrder)
  //   - scoped rules get scopeProximity = 1/(DOM depth + 1), so closer ancestors score higher
  //
  // We pass a `layerRegistry` Map(layerName→order) built from @layer statements
  // at the start of each sheet, then assign orders as we encounter @layer blocks.
  let _layerCounter = 0;

  /**
   * Compute @scope proximity score for a target element against a CSSScopeRule.
   * Returns a non-negative number (higher = scope root is closer to target).
   * Returns 0 if the scope rule has no parseable root selector.
   *
   * Spec: CSS Cascading 4 — proximity = inverse of ancestor distance.
   */
  function computeScopeProximity(scopeRule, targetEl) {
    // CSSScopeRule.scopeStart holds the scope-start selector text, e.g. ".card"
    // Older Chrome versions expose it differently — try both APIs.
    let rootSel = null;
    try {
      if (scopeRule.scopeStart) {
        // Modern Chrome / Firefox: CSSRule.scopeStart is a CSSSelectorList text
        rootSel = typeof scopeRule.scopeStart === 'string'
          ? scopeRule.scopeStart
          : (scopeRule.scopeStart.selectorText || null);
      }
    } catch (_) {}

    if (!rootSel) return 0; // No parseable root → treat as unscoped

    // Walk up from targetEl to find the nearest ancestor matching rootSel.
    // scopeLower (scope end) is respected by checking scopeRule.scopeEnd if present.
    let lowerSel = null;
    try {
      if (scopeRule.scopeEnd) {
        lowerSel = typeof scopeRule.scopeEnd === 'string'
          ? scopeRule.scopeEnd
          : (scopeRule.scopeEnd.selectorText || null);
      }
    } catch (_) {}

    let depth = 0;
    let node = targetEl;
    while (node && node !== document.documentElement.parentNode) {
      try {
        // If we've passed the lower bound, stop searching upward.
        if (lowerSel && depth > 0 && node.matches && node.matches(lowerSel)) break;
        if (node.matches && node.matches(rootSel)) {
          // proximity = 1 / (depth + 1): depth 0 means element IS the root → highest proximity
          return 1 / (depth + 1);
        }
      } catch (_) { break; }
      node = node.parentElement;
      depth++;
    }
    return 0; // targetEl is not inside this scope
  }

  function buildLayerRegistry(ruleList) {
    // Pre-scan @layer statements to establish declaration order
    const registry = new Map(); // name → order (higher = later = wins)
    let order = 0;
    for (let i = 0; i < ruleList.length; i++) {
      const rule = ruleList[i];\
      if (typeof CSSLayerStatementRule !== 'undefined' && rule instanceof CSSLayerStatementRule) {
        for (const name of (rule.nameList || [])) {
          if (!registry.has(name)) registry.set(name, order++);
        }
      } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
        const name = rule.name || `__anon_${order}`;
        if (!registry.has(name)) registry.set(name, order++);
      }
    }
    return registry;
  }

  /**
   * flattenRules — now threads scopeRule through recursion so we can compute
   * proximity against the target element at cascade-sort time.
   *
   * @param {CSSRuleList} ruleList
   * @param {number}      layerOrder
   * @param {boolean}     inScope
   * @param {Map}         layerRegistry
   * @param {CSSRule|null} activeScopeRule  — the innermost @scope rule in scope, or null
   */
  function flattenRules(ruleList, layerOrder, inScope, layerRegistry, activeScopeRule = null) {
    if (!layerRegistry) layerRegistry = buildLayerRegistry(ruleList);
    const result = [];
    for (let i = 0; i < ruleList.length; i++) {
      const rule = ruleList[i];
      if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
        const name = rule.name || `__anon_${i}`;
        // Use the pre-registered order (or assign a new one if anonymous)
        const lo = layerRegistry.has(name) ? layerRegistry.get(name) : ++_layerCounter;
        const nested = buildLayerRegistry(rule.cssRules);
        result.push(...flattenRules(rule.cssRules, lo, inScope, nested, activeScopeRule));
        continue;
      }
      if (typeof CSSLayerStatementRule !== 'undefined' && rule instanceof CSSLayerStatementRule) {
        continue; // order-declaration only, no rules
      }
      if (typeof CSSScopeRule !== 'undefined' && rule instanceof CSSScopeRule) {
        // Pass this scope rule down so leaf CSSStyleRules can record it for proximity calc.
        result.push(...flattenRules(rule.cssRules, layerOrder, true, layerRegistry, rule));
        continue;
      }
      // @media, @supports, @container, @document — recurse same layer
      if (rule.cssRules) {
        result.push(...flattenRules(rule.cssRules, layerOrder, inScope, layerRegistry, activeScopeRule));
        continue;
      }
      if (rule instanceof CSSStyleRule) {
        result.push({ rule, layerOrder, inScope, activeScopeRule });
      }
    }
    return result;
  }

  // ── Main: analyse one element, one or more properties ─────────────────────
  async function analyzeElement(el, properties, maxProps, acquisitionLevel) {
    const cs = window.getComputedStyle(el);
    const propList = properties && properties.length
      ? properties.slice(0, maxProps)
      : Array.from(cs).slice(0, maxProps);

    const result = {};
    const sheetsCache = new Map(); // href → { text, level }

    // Level 1: pre-fetch DevTools resources (gives exact source text + sourcemap)
    // Falls back gracefully to Map() on timeout (non-DevTools contexts)
    let level1Map = new Map();
    if (acquisitionLevel >= 1) {
      level1Map = await requestLevel1Resources();
    }

    // Build ordered sheet list: last sheet = highest precedence at equal specificity
    const sheets = Array.from(document.styleSheets);

    for (const prop of propList) {
      const computedValue = cs.getPropertyValue(prop).trim();

      // Inline style wins unconditionally
      if (el.style.getPropertyValue(prop)) {
        result[prop] = {
          computedValue,
          source: 'inline',
          rule: null,
          acquisition_level: 1,
          confidence: 1.00,
        };
        continue;
      }

      let bestCandidate = null;
      let bestSpecificity = -1;
      let bestLayerOrder  = -1;  // -1 = no match yet; Infinity = unlayered
      let bestScopeProximity = -1; // -1 = unscoped; ≥0 = scoped (higher wins)
      let bestSheetIdx = -1;
      let bestRuleIdx = -1;
      let tieCount = 0;

      for (let si = sheets.length - 1; si >= 0; si--) {
        const sheet = sheets[si];
        let rules = null;
        let sheetAcqLevel = 4;

        try {
          rules = sheet.cssRules; // throws if CORS-blocked
          if (rules) sheetAcqLevel = 2;
        } catch (_) {
          // CORS-blocked
          if (acquisitionLevel >= 3 && sheet.href) {
            // Try Level 3 fetch
            if (!sheetsCache.has(sheet.href)) {
              const text = await tryFetchSheet(sheet.href);
              sheetsCache.set(sheet.href, { text, level: text ? 3 : 4 });
            }
            const cached = sheetsCache.get(sheet.href);
            if (cached.text) {
              // We have source but can't enumerate rules from it directly; skip matching
              // (we'd need a CSS parser; record as level 3 "URL known" for this property)
            }
          }
          continue; // Can't match without cssRules
        }

        if (!rules) continue;

        _layerCounter = 0; // reset per sheet
        const flatRules = flattenRules(rules, Infinity, false); // Infinity = unlayered

        for (let ri = 0; ri < flatRules.length; ri++) {
          const { rule, layerOrder, activeScopeRule } = flatRules[ri];
          // Check if rule applies to element
          try {
            if (!el.matches(rule.selectorText)) continue;
          } catch (_) { continue; }

          // Check if rule declares this property
          const declaredValue = rule.style.getPropertyValue(prop).trim();
          if (!declaredValue) continue;

          const spec = computeSpecificity(rule.selectorText);

          // Compute @scope proximity for this rule (CSS Cascading 4: proximity > specificity).
          // -1 means unscoped (loses to any scoped rule at the same layerOrder).
          // 0 means scoped but target is outside the scope (skip this rule).
          // >0 means scoped and in-scope; higher = scope root is closer to target.
          let proximity = -1; // unscoped default
          if (activeScopeRule) {
            proximity = computeScopeProximity(activeScopeRule, el);
            if (proximity === 0) continue; // target is outside this @scope
          }

          // Cascade order (high-to-low priority):
          //   1. layerOrder (Infinity = unlayered = highest)
          //   2. scopeProximity (-1 = unscoped loses to any scoped at same layer)
          //   3. specificity
          //   4. sheet order (later sheet wins)
          //   5. rule order within sheet
          const winsOverBest =
            layerOrder > bestLayerOrder ||
            (layerOrder === bestLayerOrder && proximity > bestScopeProximity) ||
            (layerOrder === bestLayerOrder && proximity === bestScopeProximity && spec > bestSpecificity) ||
            (layerOrder === bestLayerOrder && proximity === bestScopeProximity && spec === bestSpecificity && si > bestSheetIdx) ||
            (layerOrder === bestLayerOrder && proximity === bestScopeProximity && spec === bestSpecificity && si === bestSheetIdx && ri > bestRuleIdx);

          if (winsOverBest) {
            if (layerOrder === bestLayerOrder && proximity === bestScopeProximity && spec === bestSpecificity) {
              tieCount++;
            } else {
              tieCount = 0;
            }
            bestLayerOrder      = layerOrder;
            bestScopeProximity  = proximity;
            bestSpecificity     = spec;
            bestSheetIdx        = si;
            bestRuleIdx         = ri;
            bestCandidate       = rule;
          }
        }
      }

      if (!bestCandidate) {
        result[prop] = {
          computedValue,
          source: 'inherited',
          rule: null,
          acquisition_level: 4,
          confidence: 0.85,
        };
        continue;
      }

      const sheet = sheets[bestSheetIdx];
      const href = sheet.href || null;
      let sourceLine = null;
      let sourceMapURL = null;
      let confidence = 0.93; // Level 2 default

      // Level 1: DevTools resource has exact content + sourcemap reference
      if (href && level1Map.has(href)) {
        const l1 = level1Map.get(href);
        if (l1.content) {
          sourceLine = findRuleLineInSource(l1.content, bestCandidate.selectorText);
          sourceMapURL = l1.sourceMapURL;
          confidence = 0.99; // Level 1 — authoritative
        }
      }

      // Try to get source line from fetched text (Level 3) if Level 1 missed
      if (!sourceLine && href && acquisitionLevel >= 3) {
        if (!sheetsCache.has(href)) {
          const text = await tryFetchSheet(href);
          sheetsCache.set(href, { text, level: text ? 3 : 2 });
        }
        const cached = sheetsCache.get(href);
        if (cached.text) {
          sourceLine = findRuleLineInSource(cached.text, bestCandidate.selectorText);
          confidence = 0.88; // Level 3 fetch
        }
      }

      if (tieCount > 0) confidence = Math.max(0.30, confidence - 0.08);

      result[prop] = {
        computedValue,
        source: 'rule',
        rule: (() => {
          // Attempt sourcemap resolution for originalFile/originalLine
          // (async not possible here — resolved below via post-processing)
          return {
            selectorText: bestCandidate.selectorText,
            ruleText: bestCandidate.cssText,
            specificity: bestSpecificity,
            sheetHref: href,
            sheetIndex: bestSheetIdx,
            ruleIndex: bestRuleIdx,
            sourceLine,
            sourceMapURL,
            originalFile: null,
            originalLine: null,
            _pendingSourceMap: !!(sourceMapURL && sourceLine), // resolved after loop
          };
        })(),
        acquisition_level: level1Map.has(href || '') ? 1 : (sourceLine ? 3 : 2),
        confidence,
      };
    }

    // ── Post-loop: resolve sourceMap → originalFile / originalLine ───────────
    // Properties marked _pendingSourceMap need async sourcemap fetch + VLQ decode
    const pendingProps = Object.entries(result)
      .filter(([, v]) => v.source === 'rule' && v.rule?._pendingSourceMap);

    if (pendingProps.length > 0) {
      // Group by sheetHref so we fetch each sourcemap once
      const mapFetches = new Map(); // sheetHref → Promise<parsedMap>
      for (const [, v] of pendingProps) {
        const key = v.rule.sheetHref + '|' + v.rule.sourceMapURL;
        if (!mapFetches.has(key)) {
          mapFetches.set(key, fetchSourceMap(v.rule.sheetHref, v.rule.sourceMapURL));
        }
      }
      // Await all maps in parallel
      await Promise.all(mapFetches.values());

      for (const [, v] of pendingProps) {
        const key = v.rule.sheetHref + '|' + v.rule.sourceMapURL;
        const parsedMap = await mapFetches.get(key);
        if (parsedMap && v.rule.sourceLine) {
          const resolved = resolveSourceLine(parsedMap, v.rule.sourceLine);
          if (resolved) {
            v.rule.originalFile   = resolved.originalFile;
            v.rule.originalLine   = resolved.originalLine;
            v.acquisition_level   = 1; // sourcemap = authoritative
            v.confidence          = Math.min(v.confidence + 0.05, 1.0);
          }
        }
        delete v.rule._pendingSourceMap; // clean up internal flag
      }
    }
    // Clean up _pendingSourceMap on all entries (in case none were pending)
    for (const v of Object.values(result)) {
      if (v.rule) delete v.rule._pendingSourceMap;
    }

    // Map-level confidence = minimum across all property confidences
    const confidences = Object.values(result).map(v => v.confidence);
    const mapConfidence = confidences.length ? Math.min(...confidences) : 0;

    return {
      element: {
        selector: computeSelector(el),
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classList: [...el.classList],
      },
      properties: result,
      map_confidence: mapConfidence,
    };
  }

  // ── Plugin Registration ───────────────────────────────────────────────────
  registry.register({
    id:          'css-origin',
    name:        'CSS Origin Tracker',
    version:     '1.0.0',
    runAt:       'load',
    realtime:    false,
    priority:    6,
    emitType:    'CSS_ORIGIN_MAP',
    dependencies: ['css'],

    install(api) {},

    async collect(api, ctx) {
      if (!ctx || !ctx.targetSelector) return null;

      const cfg = window.__SI_CONFIG__?.plugins?.intelligence?.cssOrigin || {};
      const maxProps    = cfg.maxPropertiesPerElement || 20;
      const maxEls      = cfg.maxElements            || 50;
      const acqLevel    = cfg.acquisitionLevel       ?? 4;
      const properties  = ctx.properties             || null;

      const selectors = Array.isArray(ctx.targetSelector)
        ? ctx.targetSelector.slice(0, maxEls)
        : [ctx.targetSelector];

      const entries = [];
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (!el) {
            entries.push({ selector: sel, error: 'Element not found' });
            continue;
          }
          const entry = await analyzeElement(el, properties, maxProps, acqLevel);
          entries.push(entry);
        } catch (e) {
          entries.push({ selector: sel, error: e.message });
        }
      }

      return {
        timestamp: Date.now(),
        entries,
        count: entries.length,
      };
    },
  });

})();
