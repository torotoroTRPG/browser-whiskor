/**
 * analyzers/text-coords.js  –  MAIN world
 * Extracts all visible text with absolute page coordinates.
 * Output is Tesseract.js-compatible (level/page_num/block_num/etc.)
 * plus browser-specific extensions (xpath, fontSize, color, ...).
 *
 * New: fuzzy text search with similarity scoring + AI context hints.
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  // ── Constants ─────────────────────────────────────────────────────────────
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','MATH','CANVAS','AUDIO','VIDEO']);
  const BLOCK_TAGS = new Set([
    'DIV','P','H1','H2','H3','H4','H5','H6',
    'SECTION','ARTICLE','ASIDE','MAIN','HEADER','FOOTER',
    'LI','TD','TH','BLOCKQUOTE','PRE','FIGURE','FORM','TABLE',
    'ADDRESS','DETAILS','SUMMARY','CAPTION','COL','COLGROUP',
    'DT','DD','DL','TR',
  ]);
  const LINE_THRESHOLD = 4; // px Y-diff to consider a new line

  // ── Fuzzy Matching (zero-dependency) ──────────────────────────────────────

  /**
   * Tokenize: split into lowercase words, strip punctuation.
   */
  function tokenize(text) {
    return (text || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  }

  /**
   * Character bigram set for short-string comparison.
   */
  function bigrams(str) {
    const s = str.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) {
      set.add(s.substring(i, i + 2));
    }
    return set;
  }

  /**
   * Jaccard similarity between two sets.
   */
  function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const item of a) { if (b.has(item)) intersection++; }
    return intersection / (a.size + b.size - intersection);
  }

  /**
   * Compute similarity score (0.0 – 1.0) between query and target text.
   * Combines:
   *   1. Exact substring match → 1.0
   *   2. Token Jaccard overlap → weighted
   *   3. Bigram overlap → weighted for short strings
   */
  function similarityScore(query, target) {
    const q = query.toLowerCase().trim();
    const t = target.toLowerCase().trim();

    // Exact substring → perfect match
    if (t.includes(q)) return 1.0;

    // Token overlap
    const qTokens = new Set(tokenize(q));
    const tTokens = new Set(tokenize(t));
    const tokenSim = jaccard(qTokens, tTokens);

    // Bigram overlap (more useful for short strings)
    const qBigrams = bigrams(q);
    const tBigrams = bigrams(t);
    const bigramSim = jaccard(qBigrams, tBigrams);

    // Weighted combination
    // For very short queries (< 5 chars), bigrams matter more
    const bigramWeight = q.length < 5 ? 0.6 : 0.3;
    const tokenWeight = 1 - bigramWeight;

    return Math.round((tokenSim * tokenWeight + bigramSim * bigramWeight) * 1000) / 1000;
  }

  // ── Context Hints (AI-oriented) ───────────────────────────────────────────

  /**
   * Generate a short description of the element's role/context.
   * Helps the agent understand *why* this text appears and in what context.
   */
  function getContextHint(el) {
    if (!el || !el.tagName) return 'text node';

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || el.getAttribute('aria-role') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const type = el.getAttribute('type') || '';
    const parentTag = el.parentElement ? el.parentElement.tagName.toLowerCase() : '';
    const isInteractive = !!el.closest('a, button, [role="button"], input, select, textarea, [tabindex]');

    // Heading
    if (/^h[1-6]$/.test(tag)) return `heading (${tag})`;

    // Link
    if (tag === 'a') {
      if (el.closest('nav') || el.closest('[role="navigation"]')) return 'navigation link';
      return 'link';
    }

    // Button
    if (tag === 'button' || role === 'button') {
      if (el.closest('form')) return 'form button';
      if (el.closest('nav') || el.closest('[role="navigation"]')) return 'navigation button';
      return 'button';
    }

    // Input
    if (tag === 'input') {
      const typeMap = { text: 'text input', password: 'password field', email: 'email field',
                        search: 'search field', number: 'number input', checkbox: 'checkbox',
                        radio: 'radio button', submit: 'submit button', hidden: 'hidden field' };
      return typeMap[type] || 'form input';
    }

    // Select / Textarea
    if (tag === 'select') return 'dropdown select';
    if (tag === 'textarea') return 'text area';

    // Label
    if (tag === 'label') return 'form label';

    // List items
    if (tag === 'li') {
      if (el.closest('nav') || el.closest('[role="navigation"]')) return 'navigation item';
      return 'list item';
    }

    // Table cells
    if (tag === 'td') return 'table cell';
    if (tag === 'th') return 'table header';

    // Semantic HTML5
    if (tag === 'nav' || role === 'navigation') return 'navigation';
    if (tag === 'header') return 'page header';
    if (tag === 'footer') return 'page footer';
    if (tag === 'main') return 'main content';
    if (tag === 'aside') return 'sidebar';
    if (tag === 'article') return 'article';
    if (tag === 'section') return 'section';

    // Interactive elements
    if (isInteractive) {
      if (el.closest('nav') || el.closest('[role="navigation"]')) return 'interactive nav element';
      if (el.closest('form')) return 'form element';
      return 'interactive element';
    }

    // Paragraph / generic block
    if (tag === 'p') return 'paragraph';
    if (tag === 'span') return 'inline text';
    if (tag === 'strong' || tag === 'b') return 'bold text';
    if (tag === 'em' || tag === 'i') return 'italic text';

    // Fallback: use class/id hints
    const classes = [...el.classList].join(' ');
    if (/nav|menu|toolbar/.test(classes)) return 'navigation';
    if (/card|tile|panel/.test(classes)) return 'card';
    if (/modal|dialog|overlay|popup/.test(classes)) return 'dialog';
    if (/alert|toast|notification|banner/.test(classes)) return 'notification';
    if (/footer/.test(classes)) return 'footer';
    if (/header|hero|banner/.test(classes)) return 'header';
    if (/sidebar|drawer/.test(classes)) return 'sidebar';
    if (/content|main|body/.test(classes)) return 'main content';
    if (/form|input-group|field/.test(classes)) return 'form area';

    // Check parent context
    if (parentTag === 'nav' || parentTag === 'header') return `text in ${parentTag}`;
    if (parentTag === 'form') return 'form text';
    if (parentTag === 'footer') return 'footer text';

    return `${tag} element`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function isBlockLevel(el) {
    if (!el) return false;
    if (BLOCK_TAGS.has(el.tagName)) return true;
    try {
      const d = getComputedStyle(el).display;
      return d === 'block' || d === 'flex' || d === 'grid' || d === 'table';
    } catch { return false; }
  }

  function findBlockAncestor(el) {
    let node = el;
    while (node && node !== document.body) {
      if (isBlockLevel(node)) return node;
      node = node.parentElement;
    }
    return document.body;
  }

  function getSimpleXPath(el) {
    const parts = [];
    let node = el;
    while (node && node !== document.documentElement) {
      if (node.id) { parts.unshift(`//*[@id="${node.id}"]`); break; }
      const tag = node.tagName.toLowerCase();
      const sibs = [...(node.parentElement?.children || [])].filter(c => c.tagName === node.tagName);
      const idx  = sibs.indexOf(node) + 1;
      parts.unshift(sibs.length > 1 ? `${tag}[${idx}]` : tag);
      node = node.parentElement;
    }
    if (!parts.length) return '/html/body';
    if (parts[0].startsWith('//*')) return parts[0];
    return '/html/body/' + parts.join('/');
  }

  // ── Core extraction ───────────────────────────────────────────────────────
  function extractTextWithCoords(options = {}) {
    const {
      includeHidden    = false,
      includeOffscreen = false,
      maxWords         = 5000,
    } = options;

    const scrollX = window.scrollX, scrollY = window.scrollY;
    const vw = window.innerWidth,   vh = window.innerHeight;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (!node.textContent.trim()) return NodeFilter.FILTER_SKIP;
          if (!includeHidden) {
            try {
              const cs = getComputedStyle(p);
              if (cs.display === 'none' || cs.visibility === 'hidden' ||
                  parseFloat(cs.opacity) === 0) return NodeFilter.FILTER_REJECT;
            } catch (_) {}
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const words = [];
    let blockNum = 0, parNum = 0, lineNum = 0, wordNum = 0;
    let lastBlockEl = null, lastParEl = null, lastLineY = -Infinity;

    while (walker.nextNode() && words.length < maxWords) {
      const textNode = walker.currentNode;
      const parent   = textNode.parentElement;

      // Block / paragraph counters
      const blockEl = findBlockAncestor(parent);
      if (blockEl !== lastBlockEl) {
        blockNum++;
        parNum = 0;
        lastBlockEl = blockEl;
      }
      if (isBlockLevel(parent) && parent !== lastParEl) {
        parNum++;
        lastParEl = parent;
      }

      // Split into words by whitespace
      const wordRe = /\S+/g;
      let match;
      while ((match = wordRe.exec(textNode.textContent)) !== null) {
        let rect;
        try {
          const range = document.createRange();
          range.setStart(textNode, match.index);
          range.setEnd(textNode, match.index + match[0].length);
          rect = range.getBoundingClientRect();
        } catch (_) { continue; }

        if (rect.width === 0 && rect.height === 0) continue;

        const inViewport = (rect.top >= 0 && rect.bottom <= vh &&
                            rect.left >= 0 && rect.right <= vw);
        if (!includeOffscreen && !inViewport) continue;

        // Line detection by Y position
        if (Math.abs(rect.top - lastLineY) > LINE_THRESHOLD) {
          lineNum++;
          lastLineY = rect.top;
        }

        const absX = Math.round(rect.left + scrollX);
        const absY = Math.round(rect.top  + scrollY);

        let cs;
        try { cs = getComputedStyle(parent); } catch (_) { cs = {}; }

        words.push({
          // ── Tesseract互換フィールド ──────────────────────────────
          level:     5,
          page_num:  1,
          block_num: blockNum,
          par_num:   parNum,
          line_num:  lineNum,
          word_num:  ++wordNum,
          left:      absX,
          top:       absY,
          width:     Math.round(rect.width),
          height:    Math.round(rect.height),
          conf:      100,
          text:      match[0],
          // ── 拡張フィールド ───────────────────────────────────────
          element:          parent.tagName.toLowerCase(),
          elementId:        parent.id || null,
          elementClasses:   [...parent.classList].slice(0, 5).join(' ') || null,
          xpath:            getSimpleXPath(parent),
          fontSize:         parseFloat(cs.fontSize) || null,
          fontFamily:       (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim() || null,
          fontWeight:       cs.fontWeight || null,
          fontStyle:        cs.fontStyle || null,
          color:            cs.color || null,
          backgroundColor:  cs.backgroundColor || null,
          isLink:           !!parent.closest('a'),
          inViewport,
          isHidden:         false,
          viewportX:        Math.round(rect.left),
          viewportY:        Math.round(rect.top),
          absoluteX:        absX,
          absoluteY:        absY,
          // ── AI context hint ─────────────────────────────────────
          contextHint:      getContextHint(parent),
        });
      }
    }

    return words;
  }

  // ── Aggregations ──────────────────────────────────────────────────────────
  function aggregateLines(words) {
    const map = new Map();
    for (const w of words) {
      const key = `${w.block_num}-${w.line_num}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(w);
    }
    return [...map.values()].map(ws => {
      const left   = Math.min(...ws.map(w => w.left));
      const top    = Math.min(...ws.map(w => w.top));
      const right  = Math.max(...ws.map(w => w.left + w.width));
      const bottom = Math.max(...ws.map(w => w.top  + w.height));
      // Context hint: use the most specific hint from the group
      const hints = ws.map(w => w.contextHint).filter(h => h && h !== 'text node' && h !== 'inline text');
      const contextHint = hints.length ? hints[0] : 'text line';
      return {
        level: 4, page_num: 1,
        block_num: ws[0].block_num, par_num: ws[0].par_num, line_num: ws[0].line_num,
        left, top, width: right - left, height: bottom - top,
        conf: 100,
        text:      ws.map(w => w.text).join(' '),
        wordCount: ws.length,
        element:   ws[0].element,
        absoluteX: left, absoluteY: top,
        viewportX: ws[0].viewportX, viewportY: ws[0].viewportY,
        contextHint,
      };
    });
  }

  function aggregateBlocks(words) {
    const map = new Map();
    for (const w of words) {
      if (!map.has(w.block_num)) map.set(w.block_num, []);
      map.get(w.block_num).push(w);
    }
    return [...map.values()].map(ws => {
      const left   = Math.min(...ws.map(w => w.left));
      const top    = Math.min(...ws.map(w => w.top));
      const right  = Math.max(...ws.map(w => w.left + w.width));
      const bottom = Math.max(...ws.map(w => w.top  + w.height));
      const el     = document.querySelector(`[id="${ws[0].elementId}"]`) ||
                     findBlockAncestor(document.body);
      // Context hint: aggregate from word-level hints
      const hints = ws.map(w => w.contextHint).filter(h => h && h !== 'text node' && h !== 'inline text');
      const contextHint = hints.length ? hints[0] : 'content block';
      return {
        level: 2, page_num: 1, block_num: ws[0].block_num,
        left, top, width: right - left, height: bottom - top,
        conf: 100,
        text: ws.map(w => w.text).join(' ').slice(0, 200),
        element:   ws[0].element,
        elementId: ws[0].elementId,
        role:      el?.getAttribute?.('role') || el?.getAttribute?.('aria-role') || null,
        absoluteX: left, absoluteY: top,
        viewportX: ws[0].viewportX, viewportY: ws[0].viewportY,
        contextHint,
      };
    });
  }

  // ── Plugin ────────────────────────────────────────────────────────────────
  // ── Form field values (opt-in: config.options.textCoords.includeFormValues) ──
  // text-coords collects *rendered* text, which excludes the live `value` of
  // inputs/textareas (a property, not a DOM text node). When the agent opts in we
  // also harvest those values — defensively. Sensitive fields (password, hidden,
  // payment, or name/label hinting at a secret) carry NO value, only their type;
  // any value that does ride along is redacted server-side by secret-guard
  // (core.js routeMessage → redactDeep) before any log / cache / agent read.
  const SENSITIVE_FIELD_RE = /pass(word)?|secret|token|cvv|cvc|ssn|otp|\bpin\b/i;
  const SENSITIVE_AUTOCOMPLETE = new Set([
    'current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp', 'one-time-code',
  ]);
  const MAX_FORM_VALUE_LEN = 1000;

  function isSensitiveFormField(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (SENSITIVE_AUTOCOMPLETE.has(ac)) return true;
    const hay = [el.getAttribute('name'), el.id, el.getAttribute('aria-label')].filter(Boolean).join(' ');
    return SENSITIVE_FIELD_RE.test(hay);
  }

  function extractFormValues() {
    const out = [];
    let nodes;
    try {
      nodes = document.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable="true"]');
    } catch (_) { return out; }
    for (const el of nodes) {
      try {
        const tag  = el.tagName.toLowerCase();
        const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
        // Non-value inputs (button/submit/file/...) carry nothing to read.
        if (tag === 'input' && /^(button|submit|reset|image|file)$/.test(type)) continue;
        const rect = el.getBoundingClientRect();
        const meta = {
          xpath:       getSimpleXPath(el),
          element:     tag,
          type,
          name:        el.getAttribute('name') || el.id || null,
          contextHint: getContextHint(el),
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top  + window.scrollY),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
        if (isSensitiveFormField(el)) {
          out.push({ ...meta, value: null, valueOmitted: true, reason: 'sensitive-field' });
          continue;
        }
        if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
          out.push({ ...meta, value: el.checked ? 'checked' : 'unchecked', checked: !!el.checked });
          continue;
        }
        let v = (tag === 'input' || tag === 'textarea') ? el.value : (el.textContent || '');
        if (typeof v !== 'string') v = String(v == null ? '' : v);
        if (v.length > MAX_FORM_VALUE_LEN) {
          out.push({ ...meta, value: v.slice(0, MAX_FORM_VALUE_LEN), truncated: true });
        } else {
          out.push({ ...meta, value: v });
        }
      } catch (_) { /* skip problematic element */ }
    }
    return out;
  }

  registry.register({
    id: 'text-coords',
    name: 'Text Coordinate Extractor',
    version: '1.0.0',
    runAt: 'DOMContentLoaded',
    realtime: false,
    priority: 5,
    emitType: 'TEXT_COORDS',
    cacheTarget: 'visual/text-coords.json',

    _observer: null,
    _reextractTimer: null,

    install(api) {
      const self = this;
      const setupObserver = () => {
        if (!document.body || self._observer) return;
        self._observer = new MutationObserver(() => {
          clearTimeout(self._reextractTimer);
          self._reextractTimer = setTimeout(() => {
            if (!registry._isEnabled('text-coords')) return;
            const data = self.collect(api);
            if (data) api.emit(self.emitType, data, false);
          }, 200);
        });
        self._observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupObserver, { once: true });
      } else {
        setupObserver();
      }
    },

    collect(api) {
      const opts  = api.getConfig().options?.textCoords || {};
      const words = extractTextWithCoords(opts);
      const lines = aggregateLines(words);
      const blocks = aggregateBlocks(words);

      const result = {
        capturedAt:  Date.now(),
        pageUrl:     location.href,
        viewport: {
          width:   window.innerWidth,
          height:  window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
        totalWords:  words.length,
        totalLines:  lines.length,
        totalBlocks: blocks.length,
        words,
        lines,
        blocks,
        fullText: words.map(w => w.text).join(' '),
      };
      // Form values are opt-in (config.options.textCoords.includeFormValues) and
      // minimised at source; whatever rides along is redacted server-side.
      if (opts.includeFormValues) result.formValues = extractFormValues();
      return result;
    },

    teardown() {
      this._observer?.disconnect();
      clearTimeout(this._reextractTimer);
    },
  });

  // ── Scroll & resize tracking (realtime viewport overlay) ──────────────────
  let _vpTimer = null;
  function emitViewport() {
    clearTimeout(_vpTimer);
    _vpTimer = setTimeout(() => {
      window.postMessage({
        __BROWSER_WHISKOR__: true,
        type: 'VIEWPORT_UPDATE',
        payload: {
          width:   window.innerWidth,
          height:  window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          capturedAt: Date.now(),
        }
      }, '*');
    }, 100);
  }
  window.addEventListener('scroll', emitViewport, { passive: true, capture: true });
  window.addEventListener('resize', emitViewport, { passive: true });

  // ── Expose fuzzy search for server-side use ───────────────────────────────
  // The server can call this via execute_js for on-demand fuzzy matching
  window.__SI_FUZZY_SEARCH__ = {
    similarityScore,
    tokenize,
    getContextHint,
  };
})();
