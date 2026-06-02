/**
 * analyzers/ui-catalog.js  –  MAIN world
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  function getRect(el) {
    try {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
               w: Math.round(r.width), h: Math.round(r.height) };
    } catch (_) { return null; }
  }

  function refText(el, attr) {
    const ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
    let out = '';
    for (const id of ids) {
      const ref = document.getElementById(id);
      if (ref) out += ' ' + (ref.textContent || '');
    }
    return out.trim();
  }

  // Accessible name for icon-only / labelled controls: surfaces aria-label, title,
  // alt, and the text of aria-labelledby / aria-describedby targets (e.g. a Material
  // tooltip "送信") AT THE ELEMENT'S OWN coordinates — so searching the catalog finds
  // the real control, not the floating tooltip overlay.
  function accessibleName(el) {
    const parts = [
      el.getAttribute('aria-label'),
      refText(el, 'aria-labelledby'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
      refText(el, 'aria-describedby'),
    ];
    return parts.map(s => (s || '').trim()).filter(Boolean).join(' ').slice(0, 80) || null;
  }

  // Best-effort guess of which Enter gesture submits a field (cannot read JS handlers,
  // so returns key:null honestly when unknown). Mirrors executor.js inferSubmitKey.
  function inferSubmitKey(el) {
    const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';
    // aria-keyshortcuts — an authoritative declared shortcut (e.g. "Control+Enter").
    const aks = attr('aria-keyshortcuts').toLowerCase();
    if (aks) {
      if (/(control|ctrl)\s*\+\s*(enter|return)/.test(aks)) return { key: 'ctrl-enter', confidence: 'aria', evidence: `aria-keyshortcuts=${aks}` };
      if (/(meta|cmd|command|⌘)\s*\+\s*(enter|return)/.test(aks)) return { key: 'cmd-enter', confidence: 'aria', evidence: `aria-keyshortcuts=${aks}` };
      if (/\b(enter|return)\b/.test(aks)) return { key: 'enter', confidence: 'aria', evidence: `aria-keyshortcuts=${aks}` };
    }
    const role = attr('role').toLowerCase();
    if (role === 'searchbox' || (typeof el.type === 'string' && el.type.toLowerCase() === 'search')) {
      return { key: 'enter', confidence: 'aria', evidence: role === 'searchbox' ? 'role=searchbox' : 'type=search' };
    }
    if (role === 'textbox') {
      const ml = attr('aria-multiline').toLowerCase();
      if (ml === 'false') return { key: 'enter', confidence: 'aria', evidence: 'role=textbox aria-multiline=false' };
      if (ml === 'true')  return { key: null, confidence: 'aria', evidence: 'role=textbox aria-multiline=true (newline)' };
    }
    try { if (el.closest && el.closest('[role="search"]')) return { key: 'enter', confidence: 'aria', evidence: 'inside role=search' }; } catch (_) {}
    const ekh = attr('enterkeyhint').toLowerCase();
    if (['send', 'go', 'search', 'done'].includes(ekh)) return { key: 'enter', confidence: 'attr', evidence: `enterkeyhint=${ekh}` };
    if (ekh === 'enter') return { key: null, confidence: 'attr', evidence: 'enterkeyhint=enter (newline)' };
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' && el.form) {
      const type = (el.type || 'text').toLowerCase();
      if (!['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image'].includes(type)) {
        return { key: 'enter', confidence: 'native', evidence: 'single-line <input> in a <form>' };
      }
    }
    if (tag === 'textarea') return { key: null, confidence: 'native', evidence: '<textarea>: Enter = newline' };
    const hint = [attr('placeholder'), attr('aria-label'), refText(el, 'aria-describedby')].filter(Boolean).join(' ').toLowerCase();
    if (/(ctrl|control|⌃)\s*\+?\s*(enter|return|↵|⏎)/.test(hint))   return { key: 'ctrl-enter', confidence: 'hint', evidence: 'hint: Ctrl+Enter' };
    if (/(cmd|command|meta|⌘)\s*\+?\s*(enter|return|↵|⏎)/.test(hint)) return { key: 'cmd-enter', confidence: 'hint', evidence: 'hint: Cmd+Enter' };
    if (/(shift|⇧)\s*\+?\s*(enter|return|↵|⏎)/.test(hint))          return { key: 'enter', confidence: 'hint', evidence: 'hint: Shift+Enter=newline' };
    if (/(送信|そうしん|to send|press (enter|return)|hit (enter|return)|(enter|return)\s*(で|to)\s*(send|送信)|return to send)/.test(hint)) return { key: 'enter', confidence: 'hint', evidence: 'hint: send/送信' };
    return { key: null, confidence: 'unknown', evidence: 'no signal' };
  }

  // Cheap collection-time clickability hint: is the element's own center the topmost
  // node there? clickable:true = reachable, false+by = covered by another element,
  // null = offscreen/unknown until scrolled. A hint (state at collection time), not a guarantee.
  function clickHint(el) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return null; }
    if (!r || r.width < 1 || r.height < 1) return { clickable: false, reason: 'zero-size' };
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
      return { clickable: null, reason: 'offscreen' };
    }
    let top;
    try { top = document.elementFromPoint(cx, cy); } catch (_) { return null; }
    if (!top) return { clickable: null, reason: 'no-hit' };
    if (top === el || el.contains(top) || top.contains(el)) return { clickable: true };
    const cls = (typeof top.className === 'string' ? top.className : (top.className && top.className.baseVal) || '');
    const by = top.id ? `#${top.id}` : (cls ? '.' + cls.trim().split(/\s+/).slice(0, 2).join('.') : top.tagName.toLowerCase());
    return { clickable: false, reason: 'obstructed', by };
  }

  registry.register({
    id: 'ui-catalog', name: 'UI Element Catalog', version: '1.0.0',
    runAt: 'DOMContentLoaded', realtime: false, priority: 15,
    emitType: 'UI_CATALOG', cacheTarget: 'ui/',

    install(api) {
      // Allow manual re-triggering
      window.addEventListener('message', (e) => {
        if (e.data?.__BROWSER_WHISKOR__ && e.data.type === 'MANUAL_COLLECT') {
          const plugins = e.data.payload?.plugins;
          if (!plugins || plugins.includes('ui-catalog')) {
            const data = this.collect(api);
            if (data) api.emit(this.emitType, data, false);
          }
        }
      });
    },

    collect(api) {
      // Surface inputs an action button depends on (e.g. a code field that must be
      // filled before "join" works), reusing the clickability analyzer's detector.
      const _click = window.__SI_CLICKABILITY__;
      const buttons = [...document.querySelectorAll('button,[role=button],[type=button],[type=submit]')]
        .slice(0, 200).map(el => { const h = clickHint(el);
          const rel = (_click && _click.findRelatedInputs) ? _click.findRelatedInputs(el) : [];
          return {
          text: el.textContent.trim().slice(0, 60),
          label: accessibleName(el),
          type: el.getAttribute('type') || null,
          disabled: el.disabled || null,
          clickable: h ? h.clickable : null,
          ...(h && h.by ? { obstructedBy: h.by } : {}),
          ...(rel.length ? { relatedInputs: rel, relatedInputsTip: _click.relatedInputTip(rel) } : {}),
          rect: getRect(el),
          classes: (typeof el.className === 'string' ? el.className : el.className?.baseVal || '')?.slice(0, 80),
        }; });

      // Includes contenteditable / role=textbox rich editors (chat boxes) alongside
      // native form fields, so they're searchable and carry an inferred enterKey.
      const inputs = [...document.querySelectorAll('input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"]')]
        .slice(0, 100).map(el => { const h = clickHint(el); return {
          type: el.isContentEditable ? 'contenteditable'
            : (el.tagName.toLowerCase() === 'input' ? (el.type || 'text') : el.tagName.toLowerCase()),
          name: el.name || null, id: el.id || null,
          placeholder: el.placeholder || el.getAttribute('data-placeholder') || null,
          label: accessibleName(el),
          required: el.required || null,
          enterKey: inferSubmitKey(el),
          clickable: h ? h.clickable : null,
          ...(h && h.by ? { obstructedBy: h.by } : {}),
          rect: getRect(el),
        }; });

      const links = [...document.querySelectorAll('a[href]')]
        .slice(0, 200).map(el => { const h = clickHint(el); return {
          text: el.textContent.trim().slice(0, 60),
          label: accessibleName(el),
          href: el.href,
          target: el.target || null,
          clickable: h ? h.clickable : null,
          ...(h && h.by ? { obstructedBy: h.by } : {}),
          rect: getRect(el),
        }; });

      const images = [...document.querySelectorAll('img[src]')]
        .slice(0, 100).map(el => ({
          src: el.src, alt: el.alt || null,
          naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight,
          rect: getRect(el),
        }));

      const hidden = [...document.querySelectorAll('[hidden],[style*="display:none"],[style*="display: none"]')]
        .slice(0, 50).map(el => ({
          tag: el.tagName.toLowerCase(), id: el.id || null,
          classes: (typeof el.className === 'string' ? el.className : el.className?.baseVal || '')?.slice(0, 60),
        }));

      return {
        capturedAt: Date.now(),
        counts: { buttons: buttons.length, inputs: inputs.length,
                  links: links.length, images: images.length, hidden: hidden.length },
        buttons, inputs, links, images, hidden,
      };
    },
  });
})();
