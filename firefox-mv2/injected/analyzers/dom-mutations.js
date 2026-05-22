/**
 * analyzers/dom-mutations.js  –  MAIN world  (v2 rewrite)
 *
 * High-fidelity DOM mutation streaming for browser-whiskor.
 *
 * Improvements over v1:
 *   - Records before/after values for attribute changes
 *   - Records meaningful content for added/removed nodes
 *     (tag, id, classes, data-*, textContent snippet, rect)
 *   - characterData tracking (text node changes)
 *   - Smart batching with per-category rate limiting
 *   - Budget guard: when overwhelmed, excess ops are summarised
 *   - Overflow counter so consumers know data was compressed
 *   - Debounce 80ms for snappier realtime feel
 *
 * Emits: DOM_MUTATIONS (realtime: true)
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  // ── Tunables ───────────────────────────────────────────────────────────────
  const DEBOUNCE_MS       = 80;
  const MAX_STRUCTURAL    = 40;
  const MAX_TEXT          = 30;
  const MAX_ATTRS_PER_EL  = 10;
  const TEXT_PREVIEW_LEN  = 120;
  const NODE_TEXT_LEN     = 100;

  // ── Selector helper ───────────────────────────────────────────────────────
  function quickSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    try {
      if (el.id) return '#' + CSS.escape(el.id);
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-cy') ||
                     el.getAttribute('data-qa');
      if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
      const tag = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (!parent) return tag;
      const siblings = parent.querySelectorAll(':scope > ' + tag);
      if (siblings.length === 1) return tag;
      const idx = [...siblings].indexOf(el) + 1;
      return `${tag}:nth-of-type(${idx})`;
    } catch (_) {
      return el.tagName?.toLowerCase() || 'unknown';
    }
  }

  function getNodeSummary(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      return text ? { nodeType: 'text', text: text.slice(0, TEXT_PREVIEW_LEN) } : null;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const summary = {
      tag:     node.tagName.toLowerCase(),
      id:      node.id || null,
      classes: node.className
                 ? node.className.trim().split(/\s+/).slice(0, 8)
                 : [],
    };

    const dataAttrs = {};
    for (const name of node.getAttributeNames()) {
      if (name.startsWith('data-')) dataAttrs[name] = (node.getAttribute(name) || '').slice(0, 80);
    }
    if (Object.keys(dataAttrs).length) summary.data = dataAttrs;

    const semantic = {};
    for (const a of ['role', 'type', 'name', 'href', 'src', 'aria-label',
                      'aria-hidden', 'placeholder', 'value']) {
      const v = node.getAttribute(a);
      if (v != null) semantic[a] = v.slice(0, 120);
    }
    if (Object.keys(semantic).length) summary.attrs = semantic;

    let directText = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) directText += child.textContent;
    }
    const trimmed = directText.trim();
    if (trimmed) {
      summary.text = trimmed.slice(0, NODE_TEXT_LEN);
    } else {
      const full = node.textContent?.trim();
      if (full) summary.text = full.slice(0, NODE_TEXT_LEN);
    }

    try {
      const r = node.getBoundingClientRect();
      if (r.width || r.height) {
        summary.rect = {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top  + window.scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }
    } catch (_) {}

    summary.childCount = node.children.length;
    return summary;
  }

  // ── Batch accumulator ──────────────────────────────────────────────────────

  function newBatch() {
    return {
      structural:           [],
      attrs:                new Map(),
      text:                 [],
      structural_overflow:  0,
      text_overflow:        0,
    };
  }

  let _batch   = newBatch();
  let _timer   = null;
  let _api     = null;
  let _observer = null;

  function flushBatch() {
    _timer = null;
    if (!_api) return;

    const b = _batch;
    _batch = newBatch();

    const attrsList = [];
    for (const [el, attrMap] of b.attrs) {
      for (const [attr, entry] of attrMap) {
        attrsList.push(entry);
      }
    }

    const hasData = b.structural.length || attrsList.length || b.text.length;
    if (!hasData) return;

    _api.emit('DOM_MUTATIONS', {
      ts:         Date.now(),
      structural: b.structural.length   ? b.structural : undefined,
      attributes: attrsList.length      ? attrsList    : undefined,
      text:       b.text.length         ? b.text       : undefined,
      _overflow: (b.structural_overflow || b.text_overflow) ? {
        structural: b.structural_overflow,
        text:       b.text_overflow,
      } : undefined,
    }, true);
  }

  function scheduleBatch() {
    if (_timer) return;
    _timer = setTimeout(flushBatch, DEBOUNCE_MS);
  }

  // ── Mutation handler ───────────────────────────────────────────────────────

  function handleMutations(mutations) {
    for (const m of mutations) {

      if (m.type === 'childList' && m.addedNodes.length) {
        for (const node of m.addedNodes) {
          const summary = getNodeSummary(node);
          if (!summary) continue;
          if (_batch.structural.length < MAX_STRUCTURAL) {
            _batch.structural.push({ op: 'add', ...summary });
          } else {
            _batch.structural_overflow++;
          }
        }
      }

      if (m.type === 'childList' && m.removedNodes.length) {
        for (const node of m.removedNodes) {
          const summary = getNodeSummary(node);
          if (!summary) continue;
          delete summary.rect;
          if (_batch.structural.length < MAX_STRUCTURAL) {
            _batch.structural.push({ op: 'remove', ...summary });
          } else {
            _batch.structural_overflow++;
          }
        }
      }

      if (m.type === 'attributes' && m.target.nodeType === 1) {
        const el = m.target;
        if (!_batch.attrs.has(el)) _batch.attrs.set(el, new Map());
        const attrMap = _batch.attrs.get(el);

        if (attrMap.size < MAX_ATTRS_PER_EL) {
          attrMap.set(m.attributeName, {
            selector:  quickSelector(el),
            tag:       el.tagName.toLowerCase(),
            attribute: m.attributeName,
            oldValue:  m.oldValue,
            newValue:  el.getAttribute(m.attributeName),
          });
        }
      }

      if (m.type === 'characterData') {
        const parent = m.target.parentElement;
        if (_batch.text.length < MAX_TEXT) {
          _batch.text.push({
            oldValue:       m.oldValue?.trim().slice(0, TEXT_PREVIEW_LEN),
            newValue:       m.target.textContent?.trim().slice(0, TEXT_PREVIEW_LEN),
            parentTag:      parent?.tagName?.toLowerCase() || null,
            parentSelector: parent ? quickSelector(parent) : null,
          });
        } else {
          _batch.text_overflow++;
        }
      }
    }

    scheduleBatch();
  }

  // ── Plugin registration ────────────────────────────────────────────────────

  registry.register({
    id:          'dom-mutations',
    name:        'DOM Mutation Observer',
    version:     '2.0.0',
    runAt:       'document_start',
    realtime:    true,
    priority:    4,
    emitType:    'DOM_MUTATIONS',
    cacheTarget: null,

    install(api) {
      if (_observer) return;
      _api = api;

      const observe = () => {
        if (!document.body) return;
        _observer = new MutationObserver(handleMutations);
        _observer.observe(document.body, {
          childList:              true,
          subtree:                true,
          attributes:             true,
          attributeOldValue:      true,
          characterData:          true,
          characterDataOldValue:  true,
        });
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observe, { once: true });
      } else {
        observe();
      }
    },

    collect(_api) { return null; },
  });

})();
