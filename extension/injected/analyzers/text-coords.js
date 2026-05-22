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

  // ── Seen Texts Cache (IntersectionObserver) ───────────────────────────────
  // Tracks text elements that have entered the viewport at least once.
  // Allows AI to search for text that is currently offscreen but was seen before.
  const seenTexts = new Map(); // key: xpath -> { text, absoluteX, absoluteY, width, height, element, contextHint, lastSeen }
  let _seenObserver = null;

  function initSeenObserver() {
    if (_seenObserver) return;
    _seenObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const el = entry.target;
          const xpath = getSimpleXPath(el);
          const rect = el.getBoundingClientRect();
          const scrollX = window.scrollX, scrollY = window.scrollY;
          seenTexts.set(xpath, {
            text: el.textContent?.trim().slice(0, 200) || '',
            absoluteX: Math.round(rect.left + scrollX),
            absoluteY: Math.round(rect.top + scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            element: el.tagName.toLowerCase(),
            contextHint: getContextHint(el),
            lastSeen: Date.now(),
          });
        }
      }
    }, { threshold: 0.1 });

    // Observe all text-containing elements
    const textElements = document.body.querySelectorAll(':not(script):not(style):not(noscript)');
    for (const el of textElements) {
      if (el.textContent?.trim()) {
        _seenObserver.observe(el);
      }
    }

    // Also observe new elements via MutationObserver
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.textContent?.trim()) {
            _seenObserver.observe(node);
            node.querySelectorAll(':not(script):not(style):not(noscript)').forEach(el => {
              if (el.textContent?.trim()) _seenObserver.observe(el);
            });
          }
        }
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Core extraction ───────────────────────────────────────────────────────
  function extractTextWithCoords(options = {}) {
    const {
      includeHidden    = false,
      includeOffscreen = false,
      maxWords         = 5000,
    } = options;

    // Initialize seen texts cache on first run
    if (!window.__SI_SEEN_TEXTS_INITIALIZED__) {
      initSeenObserver();
      window.__SI_SEEN_TEXTS_INITIALIZED__ = true;
    }

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

    // Merge with seen texts cache (offscreen but previously seen)
    if (!includeOffscreen && seenTexts.size > 0) {
      const currentXPaths = new Set(words.map(w => w.xpath));
      for (const [xpath, info] of seenTexts.entries()) {
        if (!currentXPaths.has(xpath) && words.length < maxWords) {
          // Add seen text as offscreen word
          words.push({
            level: 5, page_num: 1, block_num: 0, par_num: 0, line_num: 0, word_num: ++wordNum,
            left: info.absoluteX, top: info.absoluteY, width: info.width, height: info.height, conf: 90,
            text: info.text.slice(0, 50), // Limit text length for cache
            element: info.element, elementId: null, elementClasses: null, xpath,
            fontSize: null, fontFamily: null, fontWeight: null, fontStyle: null,
            color: null, backgroundColor: null, isLink: false,
            inViewport: false, isHidden: false,
            viewportX: info.absoluteX - scrollX, viewportY: info.absoluteY - scrollY,
            absoluteX: info.absoluteX, absoluteY: info.absoluteY,
            contextHint: info.contextHint,
            fromCache: true,
          });
        }
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

      // Start beacon tracking on first collect
      if (!registry._beaconStarted) {
        registry._beaconStarted = true;
        startBeaconTracking(words);
      }

      return {
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
    },

    teardown() {
      this._observer?.disconnect();
      clearTimeout(this._reextractTimer);
      if (this._scrollHandler) window.removeEventListener('scroll', this._scrollHandler, true);
      if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
      stopBeaconTracking();
      registry._beaconStarted = false;
    },
  });

  // ── Seen Text Tracker: Continuous monitoring of cached texts ──────────────
  // Tracks text elements that have entered the viewport at least once.
  // Monitors position changes, content updates, and movement status.
  // Prioritizes "moving" texts for frequent updates.
  { // block-scoped to avoid duplicate declaration conflict with first copy
  const seenTexts = new Map(); // key: xpath -> { xpath, text, x, y, w, h, lastChecked, status, changeCount, lastChange, element }
  let _seenObserver = null;
  let _recheckTimer = null;
  let _isTracking = false;
  let _scrollCollectTimer = null;
  
  const RECHECK_INTERVAL_MOVING = 100;  // ms: check moving texts frequently
  const RECHECK_INTERVAL_STABLE = 2000; // ms: check stable texts occasionally
  const STABLE_THRESHOLD = 5;           // checks without change to consider stable
  const SCROLL_COLLECT_DELAY = 300;     // ms: debounce delay for scroll-triggered collection

  function initSeenTracker(api) {
    if (_seenObserver) return;
    
    // IntersectionObserver: register texts when they enter viewport
    _seenObserver = new IntersectionObserver((entries) => {
      let newEntriesFound = false;
      for (const entry of entries) {
        if (entry.isIntersecting) {
          if (registerSeenElement(entry.target)) {
            newEntriesFound = true;
          }
        }
      }
      // If new texts appeared, schedule a collection to update cache
      if (newEntriesFound && api) {
        clearTimeout(_scrollCollectTimer);
        _scrollCollectTimer = setTimeout(() => {
          if (registry._isEnabled('text-coords')) {
            const data = registry._plugins.get('text-coords')?.collect(api);
            if (data) api.emit('TEXT_COORDS', data, false);
          }
        }, SCROLL_COLLECT_DELAY);
      }
    }, { threshold: 0.1 });

    // Observe existing elements
    observeAllTextElements();

    // Observe new elements via MutationObserver
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.textContent?.trim()) registerSeenElement(node);
            node.querySelectorAll(':not(script):not(style):not(noscript)').forEach(el => {
              if (el.textContent?.trim()) registerSeenElement(el);
            });
          }
        }
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    
    _isTracking = true;
    startRecheckLoop();
  }

  function observeAllTextElements() {
    const elements = document.body.querySelectorAll(':not(script):not(style):not(noscript)');
    for (const el of elements) {
      if (el.textContent?.trim() && _seenObserver) {
        _seenObserver.observe(el);
      }
    }
  }

  function registerSeenElement(el) {
    const xpath = getSimpleXPath(el);
    const isNew = !seenTexts.has(xpath);
    
    const rect = el.getBoundingClientRect();
    const scrollX = window.scrollX, scrollY = window.scrollY;
    const entry = seenTexts.get(xpath) || {
      xpath,
      text: '',
      x: 0, y: 0, w: 0, h: 0,
      lastChecked: 0,
      status: 'new',
      changeCount: 0,
      lastChange: 0,
      element: el.tagName.toLowerCase(),
      contextHint: getContextHint(el),
      inView: false,
    };

    const newX = Math.round(rect.left + scrollX);
    const newY = Math.round(rect.top + scrollY);
    const newW = Math.round(rect.width);
    const newH = Math.round(rect.height);
    const newText = el.textContent.trim().slice(0, 200);

    // Check for changes
    const hasMoved = (entry.x !== newX || entry.y !== newY || entry.w !== newW || entry.h !== newH);
    const hasTextChanged = (entry.text !== newText);

    if (hasMoved || hasTextChanged) {
      entry.changeCount++;
      entry.lastChange = Date.now();
      entry.status = entry.changeCount > STABLE_THRESHOLD ? 'moving' : 'checking';
    } else {
      if (entry.status === 'checking' && entry.changeCount >= STABLE_THRESHOLD) {
        entry.status = 'stable';
      }
    }

    entry.text = newText;
    entry.x = newX;
    entry.y = newY;
    entry.w = newW;
    entry.h = newH;
    entry.lastChecked = Date.now();
    entry.element = el.tagName.toLowerCase();
    entry.contextHint = getContextHint(el);
    entry.inView = true;

    if (isNew) {
      seenTexts.set(xpath, entry);
    }
    return isNew;
  }

  function startRecheckLoop() {
    if (_recheckTimer) return;
    
    const loop = () => {
      if (!_isTracking) return;
      
      const now = Date.now();
      const deltas = [];
      
      // Sort by priority: moving > checking > new > stable
      const entries = [...seenTexts.values()].sort((a, b) => {
        const priority = { moving: 3, checking: 2, new: 1, stable: 0 };
        return (priority[b.status] || 0) - (priority[a.status] || 0);
      });

      // Check a subset of texts per frame to avoid performance hit
      const maxChecksPerFrame = 50;
      let checked = 0;

      for (const entry of entries) {
        if (checked >= maxChecksPerFrame) break;
        
        // Determine check interval based on status
        const interval = entry.status === 'moving' ? RECHECK_INTERVAL_MOVING : RECHECK_INTERVAL_STABLE;
        if (now - entry.lastChecked < interval) continue;

        // Find element and check current state
        try {
          const el = document.evaluate(entry.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (!el) {
            // Element removed from DOM
            if (entry.status !== 'removed') {
              entry.status = 'removed';
              deltas.push({ ...entry, disappeared: true });
            }
            continue;
          }

          const rect = el.getBoundingClientRect();
          const scrollX = window.scrollX, scrollY = window.scrollY;
          const newX = Math.round(rect.left + scrollX);
          const newY = Math.round(rect.top + scrollY);
          const newW = Math.round(rect.width);
          const newH = Math.round(rect.height);
          const newText = el.textContent.trim().slice(0, 200);

          const hasMoved = (entry.x !== newX || entry.y !== newY || entry.w !== newW || entry.h !== newH);
          const hasTextChanged = (entry.text !== newText);
          const inView = rect.width > 0 && rect.height > 0 && 
                         rect.bottom >= 0 && rect.top <= window.innerHeight &&
                         rect.right >= 0 && rect.left <= window.innerWidth;

          if (hasMoved || hasTextChanged || entry.inView !== inView) {
            entry.changeCount++;
            entry.lastChange = Date.now();
            entry.status = entry.changeCount > STABLE_THRESHOLD ? 'moving' : 'checking';
            
            deltas.push({
              beaconId: hashBeaconId(entry.text, entry.xpath, entry.element),
              xpath: entry.xpath,
              text: newText,
              absoluteX: newX,
              absoluteY: newY,
              width: newW,
              height: newH,
              inView,
              status: entry.status,
              changeCount: entry.changeCount,
              textChanged: hasTextChanged,
            });

            entry.text = newText;
            entry.x = newX;
            entry.y = newY;
            entry.w = newW;
            entry.h = newH;
            entry.inView = inView;
          } else {
            // No change
            if (entry.status === 'checking' && entry.changeCount >= STABLE_THRESHOLD) {
              entry.status = 'stable';
            }
          }
          entry.lastChecked = Date.now();
        } catch (_) {
          // XPath evaluation failed
        }
        
        checked++;
      }

      // Emit deltas if any changes detected
      if (deltas.length > 0) {
        window.postMessage({
          __BROWSER_WHISKOR__: true,
          type: 'TEXT_COORD_DELTA',
          payload: {
            deltas,
            capturedAt: Date.now(),
            viewStateOnly: false, // Includes position/content changes
          }
        }, '*');
      }

      _recheckTimer = setTimeout(loop, 50); // Base loop interval
    };

    loop();
  }

  function stopSeenTracker() {
    _isTracking = false;
    if (_recheckTimer) {
      clearTimeout(_recheckTimer);
      _recheckTimer = null;
    }
    if (_scrollCollectTimer) {
      clearTimeout(_scrollCollectTimer);
      _scrollCollectTimer = null;
    }
    if (_seenObserver) {
      _seenObserver.disconnect();
      _seenObserver = null;
    }
    seenTexts.clear();
  }

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

  // ── Beacon tracking: lightweight viewport-state tracker ───────────────────
  // Not a full re-scan — just tracks which words are in/out of viewport
  // based on scroll position. Used as fallback/sanity check, not primary.
  let _beaconWords = [];       // { beaconId, text, xpath, element, lastX, lastY, lastW, lastH, inView }
  let _beaconRunning = false;
  const BEACON_SCAN_MS = 500;  // slow interval — fallback only, not primary

  function hashBeaconId(text, xpath, element) {
    let h = 0;
    const s = text + '|' + xpath + '|' + element;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return 'b' + (h >>> 0).toString(36);
  }

  function isInViewport(x, y, w, h) {
    const sx = window.scrollX, sy = window.scrollY;
    const vw = window.innerWidth, vh = window.innerHeight;
    const cx = x - sx, cy = y - sy;
    return cx + w >= 0 && cx <= vw && cy + h >= 0 && cy <= vh;
  }

  function startBeaconTracking(words) {
    // Only track a subset to keep it light (every 10th word, max 200)
    const step = Math.max(1, Math.floor(words.length / 200));
    _beaconWords = [];
    for (let i = 0; i < words.length; i += step) {
      const w = words[i];
      _beaconWords.push({
        beaconId: hashBeaconId(w.text, w.xpath || '', w.element || ''),
        text: w.text,
        xpath: w.xpath || '',
        element: w.element || '',
        lastX: w.absoluteX || 0,
        lastY: w.absoluteY || 0,
        lastW: w.width || 0,
        lastH: w.height || 0,
        inView: isInViewport(w.absoluteX || 0, w.absoluteY || 0, w.width || 0, w.height || 0),
      });
    }
    _beaconRunning = true;
  }

  // Lazy scan: only runs on scroll/resize, throttled
  let _beaconScanTimer = null;
  let _beaconDirty = [];

  function _beaconScan() {
    if (!_beaconRunning) return;
    _beaconDirty = [];
    for (let i = 0; i < _beaconWords.length; i++) {
      const b = _beaconWords[i];
      const nowInView = isInViewport(b.lastX, b.lastY, b.lastW, b.lastH);
      if (b.inView !== nowInView) {
        b.inView = nowInView;
        _beaconDirty.push(b.beaconId);
      }
    }
    if (_beaconDirty.length > 0) {
      window.postMessage({
        __BROWSER_WHISKOR__: true,
        type: 'TEXT_COORD_DELTA',
        payload: {
          deltas: _beaconDirty.map(id => {
            const b = _beaconWords.find(w => w.beaconId === id);
            return b ? { beaconId: b.beaconId, inView: b.inView, absoluteX: b.lastX, absoluteY: b.lastY, width: b.lastW, height: b.lastH } : null;
          }).filter(Boolean),
          capturedAt: Date.now(),
          viewStateOnly: true,
        }
      }, '*');
    }
  }

  function scheduleBeaconScan() {
    if (!_beaconRunning) return;
    clearTimeout(_beaconScanTimer);
    _beaconScanTimer = setTimeout(_beaconScan, BEACON_SCAN_MS);
  }
  window.addEventListener('scroll', scheduleBeaconScan, { passive: true, capture: true });
  window.addEventListener('resize', scheduleBeaconScan, { passive: true });

  function stopBeaconTracking() {
    _beaconRunning = false;
    _beaconWords = [];
    _beaconDirty = [];
    clearTimeout(_beaconScanTimer);
  }

  // On-demand query (lightweight — just reads cached state)
  window.__SI_BEACON_QUERY__ = {
    getViewState() {
      if (!_beaconRunning || !_beaconWords.length) return null;
      let inView = 0;
      for (const b of _beaconWords) { if (b.inView) inView++; }
      return { total: _beaconWords.length, inView, outOfView: _beaconWords.length - inView };
    },
  };

  // ── Expose fuzzy search for server-side use ───────────────────────────────
  // The server can call this via execute_js for on-demand fuzzy matching
  window.__SI_FUZZY_SEARCH__ = {
    similarityScore,
    tokenize,
    getContextHint,
  };
})();
