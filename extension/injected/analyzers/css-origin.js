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

  // ── Main: analyse one element, one or more properties ─────────────────────
  async function analyzeElement(el, properties, maxProps, acquisitionLevel) {
    const cs = window.getComputedStyle(el);
    const propList = properties && properties.length
      ? properties.slice(0, maxProps)
      : Array.from(cs).slice(0, maxProps);

    const result = {};
    const sheetsCache = new Map(); // href → { text, level }

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

        for (let ri = 0; ri < rules.length; ri++) {
          const rule = rules[ri];
          if (!(rule instanceof CSSStyleRule)) continue;
          // Check if rule applies to element
          try {
            if (!el.matches(rule.selectorText)) continue;
          } catch (_) { continue; }

          // Check if rule declares this property
          const declaredValue = rule.style.getPropertyValue(prop).trim();
          if (!declaredValue) continue;

          const spec = computeSpecificity(rule.selectorText);
          if (spec > bestSpecificity || (spec === bestSpecificity && si > bestSheetIdx)) {
            if (spec === bestSpecificity && si === bestSheetIdx && ri > bestRuleIdx) {
              tieCount++;
            } else if (spec === bestSpecificity) {
              tieCount++;
            } else {
              tieCount = 0;
            }
            bestSpecificity = spec;
            bestSheetIdx = si;
            bestRuleIdx = ri;
            bestCandidate = rule;
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
      let confidence = 0.93; // Level 2 default

      // Try to get source line from fetched text
      if (href && acquisitionLevel >= 3) {
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
        rule: {
          selectorText: bestCandidate.selectorText,
          ruleText: bestCandidate.cssText,
          specificity: bestSpecificity,
          sheetHref: href,
          sheetIndex: bestSheetIdx,
          ruleIndex: bestRuleIdx,
          sourceLine,
          originalFile: null,
          originalLine: null,
        },
        acquisition_level: sourceLine ? 3 : 2,
        confidence,
      };
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
      let acqLevel    = cfg.acquisitionLevel       || 4;
      const properties  = ctx.properties             || null;

      // Level 1: DevTools bridge — use cached full CSS from devtools panel if available
      const devtoolsCache = window.__SI_DEVTOOLS_CSS_CACHE__;
      if (acqLevel <= 1 && Array.isArray(devtoolsCache) && devtoolsCache.length > 0) {
        // Build a sheets cache from DevTools data (bypasses CORS restrictions)
        for (const entry of devtoolsCache) {
          if (entry.href && entry.rules) {
            window.__SI_DEVTOOLS_SHEET_TEXT__ = window.__SI_DEVTOOLS_SHEET_TEXT__ || {};
            window.__SI_DEVTOOLS_SHEET_TEXT__[entry.href] = entry.rules.join('\n');
          }
        }
      }

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
