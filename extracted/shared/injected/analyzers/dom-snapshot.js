/**
 * analyzers/dom-snapshot.js  –  MAIN world
 *
 * High-fidelity structural DOM snapshot for browser-whiskor.
 *
 * Complementary to accessibility and dom-generic analyzers — focuses on
 * complete structural fidelity:
 *
 *   - Every meaningful element (not just ARIA roles)
 *   - Full attribute set: id, class, data-*, role, form attrs, aria-*
 *   - textContent (direct text, not deep) to preserve meaning without bloat
 *   - Unique CSS selector per node (shortest path, prefer id/data-testid)
 *   - Bounding rect for every captured node
 *   - Form state: value, checked, selectedIndex
 *   - Computed visibility gate (display:none subtrees pruned)
 *   - Same-origin iframe support (iframe.contentDocument traversed)
 *   - Node budget: 3000 nodes max, summarise overflow
 *   - Targeted mode: pass rootSelector to snapshot only a subtree
 *   - Incremental realtime: MutationObserver emits STRUCTURAL deltas
 *
 * Emits:
 *   DOM_SNAPSHOT       (realtime: false)  – full/partial snapshot
 *   DOM_SNAPSHOT_DELTA (realtime: true)   – subtree structural change summaries
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  // ── Tunables ───────────────────────────────────────────────────────────────
  const DEFAULT_MAX_NODES = 3000;
  const DEFAULT_MAX_DEPTH = 30;
  const DELTA_DEBOUNCE_MS = 100;
  const MAX_DELTA_OPS     = 50;
  const MAX_TEXT_LEN      = 120;
  const MAX_ATTR_VAL_LEN  = 200;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK',
    'TITLE', 'HEAD', 'BASE',
  ]);

  const LEAF_TAGS = new Set([
    'INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS',
    'SVG', 'MATH', 'IFRAME',
  ]);

  const CORE_ATTRS = [
    'id', 'name', 'type', 'href', 'src', 'action', 'method',
    'role', 'tabindex', 'target', 'rel', 'for',
    'placeholder', 'value', 'min', 'max', 'step', 'pattern',
    'required', 'disabled', 'readonly', 'multiple', 'checked', 'selected',
    'aria-label', 'aria-labelledby', 'aria-describedby',
    'aria-expanded', 'aria-hidden', 'aria-selected', 'aria-checked',
    'aria-disabled', 'aria-pressed', 'aria-live', 'aria-atomic',
    'aria-current', 'aria-controls', 'aria-owns', 'aria-haspopup',
    'part', 'slot', 'exportparts',
    'title', 'alt', 'lang',
  ];

  // ── Visibility check ───────────────────────────────────────────────────────

  function isSubtreeInvisible(el) {
    try {
      const cs = getComputedStyle(el);
      return cs.display === 'none';
    } catch (_) {
      return false;
    }
  }

  // ── Selector generation ────────────────────────────────────────────────────

  function buildSelector(el) {
    if (!el || el === document.documentElement) return ':root';
    if (el === document.body) return 'body';
    try {
      if (el.id) return '#' + CSS.escape(el.id);

      const tid = el.getAttribute('data-testid') || el.getAttribute('data-cy') ||
                  el.getAttribute('data-qa')     || el.getAttribute('data-e2e');
      if (tid) return `[data-testid="${CSS.escape(tid)}"]`;

      const parts = [];
      let cur = el;
      for (let i = 0; i < 5 && cur && cur.nodeType === 1 && cur !== document.body; i++) {
        const tag    = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        if (!parent) { parts.unshift(tag); break; }

        const cls = [...(cur.classList || [])].find(c =>
          c.length > 2 && !c.match(/^(active|selected|open|visible|is-|has-)/)
        );

        let part;
        if (cur.id) {
          parts.unshift('#' + CSS.escape(cur.id));
          break;
        } else if (cls) {
          const candidates = parent.getElementsByClassName(cls);
          part = candidates.length === 1
            ? `${tag}.${CSS.escape(cls)}`
            : `${tag}.${CSS.escape(cls)}:nth-of-type(${nthOfType(cur)})`;
        } else {
          const nth = nthOfType(cur);
          part = nth > 1 ? `${tag}:nth-of-type(${nth})` : tag;
        }
        parts.unshift(part);
        cur = parent;
      }

      return parts.join(' > ') || el.tagName.toLowerCase();
    } catch (_) {
      return el.tagName?.toLowerCase() || 'unknown';
    }
  }

  function nthOfType(el) {
    const parent = el.parentElement;
    if (!parent) return 1;
    let count = 0;
    for (const child of parent.children) {
      if (child.tagName === el.tagName) count++;
      if (child === el) return count;
    }
    return 1;
  }

  // ── Attribute collection ───────────────────────────────────────────────────

  function collectAttrs(el) {
    const out = {};
    for (const name of CORE_ATTRS) {
      const v = el.getAttribute(name);
      if (v != null && v !== '') out[name] = v.slice(0, MAX_ATTR_VAL_LEN);
    }
    for (const name of el.getAttributeNames()) {
      if (name.startsWith('data-')) {
        out[name] = (el.getAttribute(name) || '').slice(0, MAX_ATTR_VAL_LEN);
      }
    }
    if (el.classList.length) {
      out._classes = [...el.classList].slice(0, 20);
    }
    return Object.keys(out).length ? out : null;
  }

  // ── Form state ─────────────────────────────────────────────────────────────

  function collectFormState(el) {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') {
        return { checked: el.checked, indeterminate: !!el.indeterminate };
      }
      if (t === 'hidden') return null;
      return { value: (el.value || '').slice(0, 500) };
    }
    if (tag === 'TEXTAREA') {
      return { value: (el.value || '').slice(0, 1000) };
    }
    if (tag === 'SELECT') {
      const opts = [];
      for (const opt of el.options) {
        opts.push({ value: opt.value, text: opt.text.trim(), selected: opt.selected });
      }
      return { value: el.value, selectedIndex: el.selectedIndex, options: opts.slice(0, 50) };
    }
    return null;
  }

  // ── Rect ───────────────────────────────────────────────────────────────────

  function getRect(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return {
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top  + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
        vx: Math.round(r.left),
        vy: Math.round(r.top),
      };
    } catch (_) { return null; }
  }

  // ── Direct text content ────────────────────────────────────────────────────

  function getDirectText(el) {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    }
    const t = text.trim();
    if (t) return t.slice(0, MAX_TEXT_LEN);
    if (el.children.length === 0) {
      const full = el.textContent?.trim();
      return full ? full.slice(0, MAX_TEXT_LEN) : null;
    }
    return null;
  }

  // ── Tree builder ───────────────────────────────────────────────────────────

  function buildTree(root, opts) {
    const maxNodes  = opts.maxNodes || DEFAULT_MAX_NODES;
    const maxDepth  = opts.maxDepth || DEFAULT_MAX_DEPTH;
    const nodes     = [];
    let   truncated = false;
    let   iframeCount = 0;

    function walk(el, depth, parentIndex) {
      if (nodes.length >= maxNodes) { truncated = true; return; }
      if (depth > maxDepth) return;
      if (el.nodeType !== 1) return;
      if (SKIP_TAGS.has(el.tagName)) return;

      if (depth > 0 && isSubtreeInvisible(el)) return;

      const myIndex = nodes.length;
      const node = {
        index:       myIndex,
        parentIndex: parentIndex ?? null,
        depth,
        tag:         el.tagName.toLowerCase(),
        selector:    buildSelector(el),
      };

      const attrs = collectAttrs(el);
      if (attrs) node.attrs = attrs;

      const text = getDirectText(el);
      if (text) node.text = text;

      const rect = getRect(el);
      if (rect) node.rect = rect;

      if (el.shadowRoot) node.hasShadowRoot = true;

      const slot = el.getAttribute('slot');
      if (slot) node.slot = slot;

      nodes.push(node);

      if (LEAF_TAGS.has(el.tagName)) {
        if (el.tagName === 'IFRAME') {
          iframeCount++;
          const frameDoc = tryGetIframeDoc(el);
          if (frameDoc) {
            const iframeRoot = frameDoc.body || frameDoc.documentElement;
            if (iframeRoot) {
              node.iframeOrigin = 'same';
              node.iframeUrl = el.src || null;
              walk(iframeRoot, depth + 1, myIndex);
            }
          } else {
            node.iframeOrigin = 'cross';
            node.iframeUrl = el.src || null;
          }
        } else {
          const formState = collectFormState(el);
          if (formState) node.form = formState;
        }
        return;
      }

      for (const child of el.children) walk(child, depth + 1, myIndex);
    }

    walk(root, 0, null);
    return { nodes, truncated, iframeCount };
  }

  function tryGetIframeDoc(iframe) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc && doc.body) return doc;
    } catch (_) {}
    return null;
  }

  // ── Snapshot entry point ───────────────────────────────────────────────────

  function snapshot(opts) {
    opts = opts || {};
    const root = opts.rootSelector
      ? (document.querySelector(opts.rootSelector) || document.body)
      : (document.body || document.documentElement);

    const cfg   = registry._config?.options?.domSnapshot || {};
    const treeOpts = {
      maxNodes: opts.maxNodes || cfg.maxNodes || DEFAULT_MAX_NODES,
      maxDepth: opts.maxDepth || cfg.maxDepth || DEFAULT_MAX_DEPTH,
    };

    const { nodes, truncated, iframeCount } = buildTree(root, treeOpts);

    return {
      capturedAt:      Date.now(),
      pageUrl:         location.href,
      docTitle:        document.title,
      rootSelector:    opts.rootSelector || null,
      nodeCount:       nodes.length,
      truncated,
      iframeCount,
      nodes,
      _note: truncated
        ? `Node budget (${treeOpts.maxNodes}) reached. Use rootSelector for targeted snapshots.`
        : undefined,
    };
  }

  // ── Realtime delta via MutationObserver ────────────────────────────────────

  let _deltaObserver = null;
  let _deltaBatch     = [];
  let _deltaTimer     = null;
  let _api           = null;

  function flushDelta() {
    _deltaTimer = null;
    if (!_api || !_deltaBatch.length) return;

    const ops = _deltaBatch.splice(0, MAX_DELTA_OPS);
    const overflow = _deltaBatch.length;
    _deltaBatch = [];

    _api.emit('DOM_SNAPSHOT_DELTA', {
      ts:       Date.now(),
      pageUrl:  location.href,
      ops,
      overflow: overflow || undefined,
    }, true);
  }

  function scheduleDelta() {
    if (_deltaTimer) return;
    _deltaTimer = setTimeout(flushDelta, DELTA_DEBOUNCE_MS);
  }

  function handleDeltaMutations(mutations) {
    for (const m of mutations) {
      if (m.type !== 'childList') continue;

      for (const node of m.addedNodes) {
        if (node.nodeType !== 1 || SKIP_TAGS.has(node.tagName)) continue;
        _deltaBatch.push({
          op:         'add',
          tag:        node.tagName.toLowerCase(),
          selector:   buildSelector(node),
          attrs:      collectAttrs(node),
          text:       getDirectText(node),
          rect:       getRect(node),
          childCount: node.children.length,
        });
      }

      for (const node of m.removedNodes) {
        if (node.nodeType !== 1 || SKIP_TAGS.has(node.tagName)) continue;
        _deltaBatch.push({
          op:         'remove',
          tag:        node.tagName.toLowerCase(),
          id:         node.id || null,
          classes:    [...(node.classList || [])].slice(0, 6),
          text:       node.textContent?.trim().slice(0, 80) || null,
          childCount: node.children.length,
        });
      }
    }

    if (_deltaBatch.length) scheduleDelta();
  }

  function installDeltaObserver() {
    if (_deltaObserver || !document.body) return;
    _deltaObserver = new MutationObserver(handleDeltaMutations);
    _deltaObserver.observe(document.body, {
      childList: true,
      subtree:   true,
    });
  }

  // ── Plugin registration ────────────────────────────────────────────────────

  registry.register({
    id:          'dom-snapshot',
    name:        'DOM Structural Snapshot',
    version:     '1.0.0',
    runAt:       'load',
    realtime:    true,
    priority:    22,
    emitType:    'DOM_SNAPSHOT',
    cacheTarget: 'dom/',

    install(api) {
      _api = api;
      if (document.body) installDeltaObserver();
      else document.addEventListener('DOMContentLoaded', installDeltaObserver, { once: true });

      window.addEventListener('message', (e) => {
        if (!e.data?.__BROWSER_WHISKOR__) return;
        if (e.data.type === 'MANUAL_COLLECT') {
          const plugins = e.data.payload?.plugins;
          if (!plugins || plugins.includes('dom-snapshot')) {
            const data = _api ? snapshot(e.data.payload?.options) : null;
            if (data) api.emit('DOM_SNAPSHOT', data, false);
          }
        }
        if (e.data.type === 'SNAPSHOT_ELEMENT' && e.data.payload?.selector) {
          const data = snapshot({
            rootSelector: e.data.payload.selector,
            maxNodes:     e.data.payload.maxNodes || 500,
            maxDepth:     e.data.payload.maxDepth || DEFAULT_MAX_DEPTH,
          });
          api.emit('DOM_SNAPSHOT', { ...data, _targeted: true }, false);
        }
      });
    },

    collect(api, opts) {
      _api = api;
      return snapshot(opts || {});
    },
  });

})();
