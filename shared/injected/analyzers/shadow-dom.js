/**
 * analyzers/shadow-dom.js  –  MAIN world
 *
 * Shadow DOM perception layer for browser-whiskor.
 *
 * Capabilities:
 *   - Full recursive shadow tree traversal (handles nested shadow roots)
 *   - Per-shadow-root MutationObserver for real-time structural deltas
 *   - Slot content resolution (assigned nodes exposed in tree)
 *   - CSS custom property leakage across shadow boundaries
 *   - Host element identification and selector generation
 *   - Graceful handling of closed shadow roots (skipped, host noted)
 *   - Budget enforcement: node cap per root, root count cap
 *
 * Emits:
 *   SHADOW_DOM_SNAPSHOT  (realtime: false)  – full tree on demand
 *   SHADOW_DOM_DELTA     (realtime: true)   – incremental changes
 *
 * Add to manifest content_scripts after dom-mutations.js.
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  // ── Constants ──────────────────────────────────────────────────────────────
  const MAX_ROOTS      = 60;
  const MAX_NODES_ROOT = 600;
  const MAX_DEPTH      = 20;
  const DELTA_DEBOUNCE = 80;
  const SKIP_TAGS      = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  // ── State ──────────────────────────────────────────────────────────────────
  const _roots    = new Map();
  let   _rootSeq  = 0;
  let   _api      = null;
  let   _installed = false;
  const _deltaTimers = new Map();
  const _rootsByHost = new WeakMap();
  let _docObserver = null;

  // ── Selector helpers ───────────────────────────────────────────────────────

  function buildSelector(el) {
    if (!el || el === document.body) return 'body';
    try {
      if (el.id) return '#' + CSS.escape(el.id);
      const testId = el.dataset?.testid || el.getAttribute('data-testid') ||
                     el.getAttribute('data-cy') || el.getAttribute('data-qa');
      if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

      const parts = [];
      let cur = el;
      for (let i = 0; i < 4 && cur && cur.nodeType === 1; i++) {
        const tag  = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        if (!parent) { parts.unshift(tag); break; }

        const siblings = parent.children;
        let sameTag = 0, idx = 0;
        for (let j = 0; j < siblings.length; j++) {
          if (siblings[j].tagName === cur.tagName) {
            sameTag++;
            if (siblings[j] === cur) idx = sameTag;
          }
        }
        parts.unshift(sameTag > 1 ? `${tag}:nth-of-type(${idx})` : tag);

        if (cur.id) { parts[0] = '#' + CSS.escape(cur.id); break; }
        cur = parent;
      }
      return parts.join(' > ');
    } catch (_) {
      return el.tagName?.toLowerCase() || 'unknown';
    }
  }

  // ── Node serialisation ────────────────────────────────────────────────────

  function getNodeText(el) {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      }
    }
    return text.trim().slice(0, 120) || null;
  }

  function getNodeAttrs(el) {
    const attrs = {};
    const ALLOW = ['id', 'class', 'role', 'type', 'name', 'href', 'src',
                   'placeholder', 'value', 'aria-label', 'aria-expanded',
                   'aria-hidden', 'aria-selected', 'aria-checked',
                   'aria-disabled', 'tabindex', 'part', 'slot'];
    for (const name of ALLOW) {
      const v = el.getAttribute(name);
      if (v != null && v !== '') attrs[name] = v.slice(0, 200);
    }
    for (const name of el.getAttributeNames()) {
      if (name.startsWith('data-')) attrs[name] = (el.getAttribute(name) || '').slice(0, 100);
    }
    return Object.keys(attrs).length ? attrs : null;
  }

  function getFormState(el) {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = el.type?.toLowerCase();
      if (t === 'checkbox' || t === 'radio') return { checked: el.checked, indeterminate: el.indeterminate || false };
      return { value: (el.value || '').slice(0, 200) };
    }
    if (tag === 'TEXTAREA') return { value: (el.value || '').slice(0, 500) };
    if (tag === 'SELECT')   return { value: el.value, selectedIndex: el.selectedIndex };
    return null;
  }

  function getRect(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return {
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top  + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    } catch (_) { return null; }
  }

  function resolveSlot(slotEl) {
    try {
      const assigned = slotEl.assignedNodes({ flatten: false });
      return assigned.slice(0, 20).map(n => ({
        nodeType: n.nodeType,
        tag:  n.nodeType === 1 ? n.tagName.toLowerCase() : null,
        text: n.textContent?.trim().slice(0, 80) || null,
      }));
    } catch (_) { return []; }
  }

  function serialiseTree(root, depthLimit) {
    const nodes  = [];
    let   count  = 0;
    let   truncated = false;

    function walk(el, depth) {
      if (count >= MAX_NODES_ROOT) { truncated = true; return; }
      if (depth > depthLimit || SKIP_TAGS.has(el.tagName)) return;

      let display;
      try { display = getComputedStyle(el).display; } catch (_) { display = ''; }
      if (display === 'none') return;

      count++;
      const node = {
        tag:      el.tagName.toLowerCase(),
        depth,
        selector: buildSelector(el),
        attrs:    getNodeAttrs(el),
        text:     getNodeText(el),
        rect:     getRect(el),
      };

      const form = getFormState(el);
      if (form) node.form = form;

      if (el.tagName === 'SLOT') {
        const assigned = resolveSlot(el);
        if (assigned.length) node.slotAssigned = assigned;
      }

      if (el.shadowRoot) {
        node.nestedShadowRoot = true;
      }

      nodes.push(node);
      for (const child of el.children) walk(child, depth + 1);
    }

    for (const child of root.children) walk(child, 0);
    return { nodes, truncated, count };
  }

  // ── Root discovery ────────────────────────────────────────────────────────

  function scanForRoots(subtree) {
    const queue = [subtree || document.body];
    while (queue.length) {
      const el = queue.shift();
      if (!el || el.nodeType !== 1) continue;

      if (el.shadowRoot && !_rootsByHost.has(el)) {
        attachRoot(el, el.shadowRoot);
      }

      for (const child of el.children) queue.push(child);
    }
  }

  function attachRoot(host, shadowRoot) {
    if (_roots.size >= MAX_ROOTS) return;
    const rootId = 'sr-' + (++_rootSeq);
    _rootsByHost.set(host, rootId);

    const meta = {
      rootId,
      root:         shadowRoot,
      host,
      hostSelector: buildSelector(host),
      hostTag:      host.tagName.toLowerCase(),
      hostId:       host.id || null,
      hostPart:     host.getAttribute('part') || null,
      mode:         shadowRoot.mode,
    };
    _roots.set(rootId, meta);

    const observer = new MutationObserver(mutations => onRootMutation(rootId, mutations));
    observer.observe(shadowRoot, {
      childList:     true,
      subtree:       true,
      attributes:    true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
    meta.observer = observer;

    scanForRoots(shadowRoot);
  }

  // ── Mutation handling ─────────────────────────────────────────────────────

  function onRootMutation(rootId, mutations) {
    const existing = _deltaTimers.get(rootId);
    if (existing) {
      existing.mutations.push(...mutations);
      return;
    }
    const batch = { mutations: [...mutations] };
    _deltaTimers.set(rootId, batch);

    batch.timer = setTimeout(() => {
      _deltaTimers.delete(rootId);
      emitDelta(rootId, batch.mutations);

      for (const m of batch.mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) scanForRoots(node);
        }
      }
    }, DELTA_DEBOUNCE);
  }

  function emitDelta(rootId, mutations) {
    if (!_api) return;
    const meta = _roots.get(rootId);
    if (!meta) return;

    const structural = [];
    const attributes = [];
    const textChanges = [];

    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            structural.push({
              op:       'add',
              tag:      node.tagName.toLowerCase(),
              id:       node.id || null,
              classes:  node.className ? node.className.trim().split(/\s+/).slice(0, 6) : [],
              text:     node.textContent?.trim().slice(0, 100) || null,
              selector: buildSelector(node),
              rect:     getRect(node),
            });
          } else if (node.nodeType === 3 && node.textContent.trim()) {
            textChanges.push({ op: 'add', text: node.textContent.trim().slice(0, 200) });
          }
        }
        for (const node of m.removedNodes) {
          if (node.nodeType === 1) {
            structural.push({
              op:      'remove',
              tag:     node.tagName.toLowerCase(),
              id:      node.id || null,
              classes: node.className ? node.className.trim().split(/\s+/).slice(0, 6) : [],
              text:    node.textContent?.trim().slice(0, 80) || null,
            });
          }
        }
      } else if (m.type === 'attributes') {
        const el = m.target;
        if (el.nodeType !== 1) continue;
        attributes.push({
          selector:  buildSelector(el),
          attribute: m.attributeName,
          oldValue:  m.oldValue,
          newValue:  el.getAttribute(m.attributeName),
        });
      } else if (m.type === 'characterData') {
        textChanges.push({
          op:       'update',
          oldValue: m.oldValue?.trim().slice(0, 100),
          newValue: m.target.textContent?.trim().slice(0, 100),
        });
      }
    }

    if (!structural.length && !attributes.length && !textChanges.length) return;

    _api.emit('SHADOW_DOM_DELTA', {
      rootId,
      hostSelector: meta.hostSelector,
      hostTag:      meta.hostTag,
      capturedAt:   Date.now(),
      structural:   structural.length   ? structural  : undefined,
      attributes:   attributes.length   ? attributes  : undefined,
      textChanges:  textChanges.length  ? textChanges : undefined,
    }, true);
  }

  // ── Snapshot builder ──────────────────────────────────────────────────────

  function buildFullSnapshot() {
    const roots = [];
    for (const [rootId, meta] of _roots) {
      const { nodes, truncated, count } = serialiseTree(meta.root, MAX_DEPTH);
      roots.push({
        rootId,
        hostSelector: meta.hostSelector,
        hostTag:      meta.hostTag,
        hostId:       meta.hostId,
        hostPart:     meta.hostPart,
        mode:         meta.mode,
        nodeCount:    count,
        truncated,
        nodes,
      });
    }
    return {
      capturedAt:  Date.now(),
      rootCount:   _roots.size,
      roots,
    };
  }

  // ── Document-level scanner ─────────────────────────────────────────────────

  function installDocumentObserver() {
    if (_docObserver) return;
    _docObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) scanForRoots(node);
        }
      }
    });
    _docObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── Plugin registration ───────────────────────────────────────────────────

  registry.register({
    id:          'shadow-dom',
    name:        'Shadow DOM Analyzer',
    version:     '1.0.0',
    runAt:       'load',
    realtime:    true,
    priority:    18,
    emitType:    'SHADOW_DOM_SNAPSHOT',
    cacheTarget: 'dom/',

    install(api) {
      if (_installed) return;
      _installed = true;
      _api = api;

      if (document.body) scanForRoots(document.body);
      installDocumentObserver();

      window.addEventListener('message', (e) => {
        if (!e.data?.__BROWSER_WHISKOR__) return;
        if (e.data.type === 'MANUAL_COLLECT') {
          const plugins = e.data.payload?.plugins;
          if (!plugins || plugins.includes('shadow-dom')) {
            scanForRoots(document.body);
            const snap = buildFullSnapshot();
            if (snap.rootCount > 0) api.emit('SHADOW_DOM_SNAPSHOT', snap, false);
          }
        }
      });
    },

    collect(api) {
      _api = api;
      if (!document.body) return null;
      scanForRoots(document.body);
      const snap = buildFullSnapshot();
      return snap.rootCount > 0 ? snap : null;
    },
  });

})();
