/**
 * injected/executor.js  –  MAIN world
 * Handles EXECUTE_ACTION_IN_PAGE commands from the SW.
 * Performs DOM manipulations: click, type, scroll, hover, etc.
 */
'use strict';

(function () {
  if (window.__SI_EXECUTOR_INIT__) return;
  window.__SI_EXECUTOR_INIT__ = true;

  // ── Native dialog guard ───────────────────────────────────────────────────────
  // Native alert/confirm/prompt BLOCK the page's event loop, which freezes our action
  // handlers and times the action out (the classic "click hangs because a modal popped").
  // Override them so they never block: capture the message, auto-respond per policy, and
  // record each with causal attribution to the in-flight action — so the agent learns
  // "your click triggered this alert" instead of just timing out.
  const DIALOG_LOG = [];
  let ACTION_CTX = null;            // { id, label, startedAt } while an action runs
  let _lastAction = null;          // { id, label, endedAt } for indirect attribution
  const DIALOG_POLICY = { confirm: true, prompt: null }; // defaults; per-action override via act.dialog

  function recordDialog(type, message, defaultValue, response) {
    const now = Date.now();
    let causality = 'none', action = null;
    if (ACTION_CTX) {
      causality = 'direct'; action = { id: ACTION_CTX.id, label: ACTION_CTX.label };
    } else if (_lastAction && now - _lastAction.endedAt < 1500) {
      causality = 'indirect'; action = { id: _lastAction.id, label: _lastAction.label };
    }
    const entry = {
      type,
      message: String(message == null ? '' : message).slice(0, 500),
      ...(defaultValue != null ? { defaultValue: String(defaultValue).slice(0, 200) } : {}),
      response,
      causality,
      action,
      ts: now,
    };
    DIALOG_LOG.push(entry);
    if (DIALOG_LOG.length > 50) DIALOG_LOG.shift();
    return entry;
  }

  (function installDialogGuard() {
    if (window.__SI_DIALOG_GUARD__) return;
    window.__SI_DIALOG_GUARD__ = true;
    try {
      window.alert   = function (msg)      { recordDialog('alert', msg, undefined, 'dismissed'); };
      window.confirm = function (msg)      { const r = DIALOG_POLICY.confirm !== false; recordDialog('confirm', msg, undefined, r); return r; };
      window.prompt  = function (msg, def) { const r = DIALOG_POLICY.prompt ?? null;   recordDialog('prompt', msg, def, r); return r; };
    } catch (_) { /* some pages freeze these props — best effort */ }
    try { window.__SI_DIALOGS__ = () => DIALOG_LOG.slice(); } catch (_) {}
  })();

  // ── Post-click state settle ───────────────────────────────────────────────────
  // A click can trigger *async* navigation — SPA/Turbo do `fetch → DOM swap`, which a
  // fixed short delay misses, so diagnoseClickResult sees the old URL/title and reports
  // a false `no_state_change` (the GitHub "Releases" Turbo-link bug). Instead of polling,
  // wait event-driven: a MutationObserver (DOM swap) plus popstate/hashchange (history
  // nav) fire the instant the page reacts; we resolve as soon as a *meaningful* change is
  // observable (href / title / dialog count / target detached), or give up after maxWait.
  // Turbo's pushState emits no event, but its DOM swap does — and by then location.href
  // is already updated, so the mutation path catches it. A click that genuinely changes
  // nothing waits out maxWait and is still correctly reported as no_state_change.
  function waitForClickSettle(fp, el, maxWait = 800) {
    const changed = () => {
      try {
        if (location.href !== fp.url) return true;
        if (document.title !== fp.title) return true;
        if (el && !document.contains(el)) return true;
        const dlg = document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;
        if (dlg !== fp.dialogCount) return true;
      } catch (_) {}
      return false;
    };
    if (changed()) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false, mo = null, timer = null;
      const cleanup = () => {
        try { mo && mo.disconnect(); } catch (_) {}
        try { window.removeEventListener('popstate', check); } catch (_) {}
        try { window.removeEventListener('hashchange', check); } catch (_) {}
        if (timer) clearTimeout(timer);
      };
      const finish = () => { if (done) return; done = true; cleanup(); resolve(); };
      const check = () => { if (changed()) finish(); };
      try {
        mo = new MutationObserver(check);
        // childList+subtree で Turbo/SPA の DOM 差し替えを拾う。characterData は
        // 過剰（title だけ変わる稀ケースはタイムアウト経路で拾える）なので付けない。
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (_) {}
      try { window.addEventListener('popstate', check); } catch (_) {}
      try { window.addEventListener('hashchange', check); } catch (_) {}
      timer = setTimeout(finish, maxWait);
    });
  }

  // ── Element finders ──────────────────────────────────────────────────────────

  // Info about the last selector resolution — lets action results surface
  // ambiguity ("selector matched N elements") so the agent can refine it.
  let LAST_SELECTOR_INFO = null;

  // Info about the last text resolution — the ranked candidates and why the
  // winner was chosen (kind/score/signals). Surfaced as matchedBy on results so
  // the agent can see why THIS element beat the others. Reset on every resolve.
  let LAST_TEXT_MATCH = null;

  function findBySelector(selector) {
    LAST_SELECTOR_INFO = null;
    try {
      const all = document.querySelectorAll(selector);
      if (!all.length) return null;
      if (all.length === 1) return all[0];
      // Multiple matches (e.g. 7 elements sharing a degenerate id like
      // #bb-editor-textbox). A bare "first visible" pick is blind to where a
      // preceding click landed, so click(text)→type(selector) could split across
      // two different editors. Prefer the match tied to the *focused* element when
      // there is one — a click focuses its target, so this keeps click→type on the
      // same element. The focused candidate may be the host, an ancestor, or a
      // descendant of activeElement, so match in both directions.
      const active = document.activeElement;
      let focusIndex = -1;
      if (active && active !== document.body) {
        for (let i = 0; i < all.length; i++) {
          const m = all[i];
          if (!isElementVisible(m)) continue;
          if (m === active || m.contains(active) || active.contains(m)) { focusIndex = i; break; }
        }
      }
      if (focusIndex >= 0) {
        LAST_SELECTOR_INFO = { matches: all.length, pickedIndex: focusIndex, focusMatched: true };
        return all[focusIndex];
      }
      // No focused match: fall back to the first visible one — hidden twins (e.g.
      // MUI's autosize measurement textarea) and closed overlays often match first.
      let picked = null, pickedIndex = 0;
      for (let i = 0; i < all.length; i++) {
        if (isElementVisible(all[i])) { picked = all[i]; pickedIndex = i; break; }
      }
      if (!picked) { picked = all[0]; pickedIndex = 0; }
      LAST_SELECTOR_INFO = { matches: all.length, pickedIndex };
      return picked;
    } catch { return null; }
  }

  // Spreadable note for action results when the selector was ambiguous.
  function selectorAmbiguity(action) {
    if (!(action && action.selector && LAST_SELECTOR_INFO && LAST_SELECTOR_INFO.matches > 1)) return {};
    const base = { selectorMatches: LAST_SELECTOR_INFO.matches, selectorPickedIndex: LAST_SELECTOR_INFO.pickedIndex };
    return LAST_SELECTOR_INFO.focusMatched
      ? { ...base, selectorNote: 'Selector matched multiple elements; the currently focused one was used (keeps click→type on the same element). Tighten the selector if this is not the intended target.' }
      : { ...base, selectorNote: 'Selector matched multiple elements; first visible one was used. Tighten the selector if this is not the intended target.' };
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Resolve the combined text of the elements referenced by an IDREF attribute
  // (aria-labelledby / aria-describedby). Lets us match an icon control by the text
  // of its associated label/tooltip (e.g. a Material tooltip "送信").
  function refText(el, attr) {
    const ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
    let out = '';
    for (const id of ids) {
      const ref = document.getElementById(id);
      if (ref) out += ' ' + (ref.textContent || '');
    }
    return out.trim();
  }

  // Label-ish text sources of an element, in priority order. `value` (an input's
  // current content) is included as a last resort but flagged so scoring can
  // penalise it — page content is not a label and matching it caused real
  // mis-clicks (e.g. text:"NONAME" landing on a chat input whose value was "noname").
  function textSources(el) {
    const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';
    return [
      { t: el.textContent, src: 'text' },
      { t: attr('aria-label'), src: 'label' },
      { t: el.placeholder, src: 'label' },
      { t: refText(el, 'aria-labelledby'), src: 'label' },
      { t: attr('title'), src: 'label' },
      { t: attr('alt'), src: 'label' },
      { t: refText(el, 'aria-describedby'), src: 'label' },
      { t: typeof el.value === 'string' ? el.value : '', src: 'value' },
    ];
  }

  function isElementVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  // Classify an element into a target kind for the ranking policy (link/button/
  // input/label/text). Mirrors the kinds find_target emits server-side so both
  // callers rank identically via the shared text-rank lib.
  function classifyKind(el) {
    const tag  = (el.tagName || '').toLowerCase();
    const role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
    const type = (typeof el.type === 'string' ? el.type : '').toLowerCase();
    if (tag === 'a' && el.getAttribute && el.getAttribute('href') != null) return 'link';
    if (role === 'link') return 'link';
    if (tag === 'button' || role === 'button' || role === 'tab' || role === 'menuitem' ||
        tag === 'summary' || (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type))) {
      return 'button';
    }
    if (tag === 'textarea' || tag === 'select' || role === 'textbox' || role === 'searchbox' || role === 'combobox' ||
        (tag === 'input' && !['submit', 'button', 'reset', 'image', 'hidden', 'checkbox', 'radio'].includes(type))) {
      return 'input';
    }
    if (tag === 'label' || role === 'option' || role === 'checkbox' || role === 'radio' || role === 'switch') {
      return 'label';
    }
    return 'text';
  }

  // True when the element carries an explicit accessible name (not just text
  // content) — a strong signal it is a deliberate, labelled control.
  function hasAccessibleName(el) {
    const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';
    return !!(attr('aria-label').trim() || refText(el, 'aria-labelledby') ||
              attr('title').trim() || attr('alt').trim());
  }

  // Does the element's box intersect the current viewport?
  function inViewportEl(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }

  // Cheap reachability check: is the element's centre the top-most node at that
  // point? true = reachable, false = obstructed by an overlay, null = its centre
  // is outside the viewport (cannot test without scrolling). Only run on the top
  // few candidates — elementFromPoint forces layout.
  function occlusionClickable(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) return null;
    return hit === el || el.contains(hit) || hit.contains(el);
  }

  // A compact, stable-ish selector string for a candidate (for matchedBy /
  // boost / exclude matching). Best-effort, not guaranteed unique.
  function selectorOf(el) {
    if (el.id) return `#${el.id}`;
    const cls = (typeof el.className === 'string' ? el.className
                 : (el.className && el.className.baseVal) || '');
    if (cls) return '.' + cls.trim().split(/\s+/).slice(0, 2).join('.');
    return (el.tagName || '').toLowerCase();
  }

  // Base text-match score for an element against the lowercased query (exact >
  // prefix > word-boundary > substring), biased toward concise/leaf labels and
  // away from an input's current `value` (page content, not a label). Pure text
  // quality — kind/viewport/reachability live in the shared ranker.
  function textScoreOf(el, lower, query, wordRe) {
    let s = 0;
    for (const cand of textSources(el)) {
      const raw = (typeof cand.t === 'string' ? cand.t : '').trim();
      if (!raw) continue;
      const t = raw.toLowerCase();
      let cs;
      if (t === lower)                   cs = 1.0;
      else if (t.startsWith(lower))      cs = 0.85;
      else if (wordRe && wordRe.test(t)) cs = 0.7;
      else if (t.includes(lower))        cs = 0.55;
      else continue;
      cs += (lower.length / Math.max(t.length, 1)) * 0.2; // mostly-the-query wins
      if (raw === query || raw.includes(query)) cs += 0.15; // case-exact beats case-folded
      if (cand.src === 'value') cs -= 0.3;                  // field content is not a label
      if (cs > s) s = cs;
    }
    if (s <= 0) return 0;
    if (el.children.length === 0) s += 0.05; // concise leaf
    return s;
  }

  /**
   * Locate an element by its visible text, ranked by the shared policy.
   *
   * Two passes gather candidates (best total score wins), then the shared
   * text-rank lib applies kind priority (link/button > input/label > plain
   * text), viewport, accessible-name, and reachability so a real link outranks a
   * ".x.com" breadcrumb of similar raw text:
   *   Pass 1 — explicit interactive elements (links, buttons, form fields, ARIA
   *            widgets, [onclick], focusable nodes).
   *   Pass 2 — text-bearing leaf elements (div/span/li/headings with ≤2 element
   *            children) — the SPA pattern of a clickable <div>/<span>.
   *
   * @param {string} text  the query
   * @param {Object} [textMatch]  per-call overrides { prefer, scope, index, boost, exclude }
   */
  function findByText(text, textMatch) {
    LAST_TEXT_MATCH = null;
    const query = (text || '').trim();
    const lower = query.toLowerCase();
    if (!lower) return null;
    let wordRe = null;
    try { wordRe = new RegExp('\\b' + escapeRegex(lower) + '\\b'); } catch (_) {}

    const seen = new Set();
    const cands = [];
    const consider = (el) => {
      if (seen.has(el)) return;
      const ts = textScoreOf(el, lower, query, wordRe);
      if (ts <= 0) return;
      if (!isElementVisible(el)) return; // invisible cannot be clicked — exclude
      seen.add(el);
      cands.push({
        _el: el,
        textScore: ts,
        kind: classifyKind(el),
        inViewport: inViewportEl(el),
        hasAccessibleName: hasAccessibleName(el),
        selector: selectorOf(el),
        text: (el.textContent || '').trim().slice(0, 80),
      });
    };

    const interactiveSel =
      'button, a, input, textarea, select, label, summary, ' +
      '[role=button], [role=link], [role=tab], [role=menuitem], [role=option], ' +
      '[role=checkbox], [role=radio], [role=switch], [onclick], ' +
      '[tabindex]:not([tabindex="-1"])';
    for (const el of document.querySelectorAll(interactiveSel)) consider(el);
    for (const el of document.querySelectorAll(
      'div, span, li, td, th, p, h1, h2, h3, h4, h5, h6, strong, b, em'
    )) {
      if (el.children.length > 2) continue; // skip large containers
      consider(el);
    }

    if (!cands.length) return null;

    const ranker = (typeof window !== 'undefined' && window.__SI_TEXT_RANK__) || null;
    if (!ranker) {
      // Defensive fallback if the lib failed to load: plain text-score order.
      cands.sort((a, b) => b.textScore - a.textScore);
      LAST_TEXT_MATCH = { kind: cands[0].kind, score: cands[0].textScore, candidates: [], note: 'text-rank lib unavailable' };
      return cands[0]._el;
    }

    // Pass A: rank without reachability (cheap). Then probe occlusion on just the
    // top contenders (bounded layout cost) and re-rank so an obstructed winner
    // yields to a reachable one of similar score.
    let res = ranker.rankCandidates(cands, { textMatch });
    const PROBE = Math.min(res.ranked.length, 8);
    for (let i = 0; i < PROBE; i++) {
      const c = res.ranked[i];
      c.clickable = occlusionClickable(c._el);
    }
    res = ranker.rankCandidates(res.ranked, { textMatch });

    LAST_TEXT_MATCH = ranker.toMatchedBy(res, { limit: 5 });
    return res.best ? res.best._el : null;
  }

  function findByCoords(x, y) {
    return document.elementFromPoint(x - window.scrollX, y - window.scrollY);
  }

  function resolveTarget(action) {
    LAST_TEXT_MATCH = null; // only a text resolution sets this
    if (action.selector) return findBySelector(action.selector);
    if (action.text)     return findByText(action.text, action.textMatch);
    if (action.x != null && action.y != null) return findByCoords(action.x, action.y);
    return null;
  }

  // Spreadable note for action results when the target was resolved by text —
  // surfaces the ranked candidates and why the winner was chosen.
  function textMatchNote(action) {
    if (!(action && action.text && LAST_TEXT_MATCH)) return {};
    return { matchedBy: LAST_TEXT_MATCH };
  }

  function scrollIntoView(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }
    catch (_) {}
  }

  // Resolve the post-type Enter behaviour from an action, honouring the legacy
  // `pressEnter` boolean. Returns: 'none' | 'enter' | 'shift-enter' | 'ctrl-enter' | 'cmd-enter'.
  function resolveSubmit(action) {
    const allowed = ['none', 'enter', 'shift-enter', 'ctrl-enter', 'cmd-enter', 'auto'];
    if (typeof action.submit === 'string' && allowed.includes(action.submit)) return action.submit;
    return action.pressEnter ? 'enter' : 'none';
  }

  // Best-effort inference of which Enter gesture submits THIS field. We cannot read a
  // page's JS keydown handlers from a content script (getEventListeners is DevTools-only),
  // so this reads only observable signals and returns { key:null } honestly when unknown —
  // it never guesses. key ∈ {'enter','ctrl-enter','cmd-enter', null}.
  function inferSubmitKey(el) {
    const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';

    // 1. enterkeyhint — purpose-built hint for the Enter key's action.
    // aria-keyshortcuts — an authoritative declared shortcut (e.g. "Control+Enter").
    const aks = attr('aria-keyshortcuts').toLowerCase();
    if (aks) {
      if (/(control|ctrl)\s*\+\s*(enter|return)/.test(aks)) return { key: 'ctrl-enter', confidence: 'aria', evidence: `aria-keyshortcuts=${aks}` };
      if (/(meta|cmd|command|⌘)\s*\+\s*(enter|return)/.test(aks)) return { key: 'cmd-enter', confidence: 'aria', evidence: `aria-keyshortcuts=${aks}` };
      if (/\b(enter|return)\b/.test(aks)) return { key: 'enter', confidence: 'aria', evidence: `aria-keyshortcuts=${aks}` };
    }
    // role=searchbox / type=search → Enter submits.
    const role = attr('role').toLowerCase();
    if (role === 'searchbox' || (typeof el.type === 'string' && el.type.toLowerCase() === 'search')) {
      return { key: 'enter', confidence: 'aria', evidence: role === 'searchbox' ? 'role=searchbox' : 'type=search' };
    }
    // role=textbox + aria-multiline disambiguates single-line (submit) vs multiline (newline).
    if (role === 'textbox') {
      const ml = attr('aria-multiline').toLowerCase();
      if (ml === 'false') return { key: 'enter', confidence: 'aria', evidence: 'role=textbox aria-multiline=false' };
      if (ml === 'true')  return { key: null, confidence: 'aria', evidence: 'role=textbox aria-multiline=true (newline)' };
    }
    // Inside a search landmark → Enter submits.
    try { if (el.closest && el.closest('[role="search"]')) return { key: 'enter', confidence: 'aria', evidence: 'inside role=search' }; } catch (_) {}
    const ekh = attr('enterkeyhint').toLowerCase();
    if (['send', 'go', 'search', 'done'].includes(ekh)) {
      return { key: 'enter', confidence: 'attr', evidence: `enterkeyhint=${ekh}` };
    }
    if (ekh === 'enter') {
      return { key: null, confidence: 'attr', evidence: 'enterkeyhint=enter (newline)' };
    }

    // 2. Native form semantics.
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' && el.form) {
      const type = (el.type || 'text').toLowerCase();
      const singleLine = !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image'].includes(type);
      if (singleLine) {
        return { key: 'enter', confidence: 'native', evidence: 'single-line <input> in a <form> (Enter submits natively)' };
      }
    }
    if (tag === 'textarea') {
      return { key: null, confidence: 'native', evidence: '<textarea>: Enter inserts a newline; submit gesture is app-defined' };
    }

    // 3. Textual hints (placeholder / aria-label / aria-describedby tooltip).
    const hint = [attr('placeholder'), attr('aria-label'), refText(el, 'aria-describedby')]
      .filter(Boolean).join(' ').toLowerCase();
    if (/(ctrl|control|⌃)\s*\+?\s*(enter|return|↵|⏎)/.test(hint))   return { key: 'ctrl-enter', confidence: 'hint', evidence: 'hint: Ctrl+Enter' };
    if (/(cmd|command|meta|⌘)\s*\+?\s*(enter|return|↵|⏎)/.test(hint)) return { key: 'cmd-enter', confidence: 'hint', evidence: 'hint: Cmd+Enter' };
    if (/(shift|⇧)\s*\+?\s*(enter|return|↵|⏎)/.test(hint))          return { key: 'enter', confidence: 'hint', evidence: 'hint: Shift+Enter=newline → Enter sends' };
    if (/(送信|そうしん|to send|press (enter|return)|hit (enter|return)|(enter|return)\s*(で|to)\s*(send|送信)|return to send)/.test(hint)) return { key: 'enter', confidence: 'hint', evidence: 'hint: send/送信' };

    // 4. Unknown — be honest, do not guess.
    return { key: null, confidence: 'unknown', evidence: 'no enterkeyhint, native form, or hint text found' };
  }

  // Compact descriptor of where an action landed — lets the agent confirm it typed into
  // the intended element (e.g. when no selector was given and activeElement was used).
  // React redefines `value` on the element INSTANCE to track programmatic writes;
  // only a write through the PROTOTYPE's native setter makes the following input
  // event register as a real change. The setter must come from the element's own
  // interface: calling the HTMLInputElement setter on a <textarea> throws, and the
  // old `el.value =` fallback updated React's tracker directly — the input event
  // then looked like a no-op and onChange never fired (React textareas appeared
  // to accept text while the component state stayed empty).
  function setNativeValue(el, v) {
    const proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
                : (typeof HTMLSelectElement   !== 'undefined' && el instanceof HTMLSelectElement)   ? HTMLSelectElement.prototype
                : (typeof HTMLInputElement    !== 'undefined' && el instanceof HTMLInputElement)    ? HTMLInputElement.prototype
                : null;
    const d = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) { try { d.set.call(el, v); return; } catch (_) {} }
    el.value = v;
  }

  // ── Canvas boundary note ─────────────────────────────────────────────────
  // Declares when an action lands in pixel-land where DOM senses cannot see:
  // hit:'direct'  = the target IS a <canvas> (the click was a coordinate shot
  //                 into pixels; no DOM change is the EXPECTED outcome),
  // hit:'overlay' = the target is stacked on top of one or more canvases
  //                 (checked via elementsFromPoint = true z-order, so an element
  //                 merely near a canvas does not fire).
  // Spreadable like selectorAmbiguity/textMatchNote: {} when there is no signal,
  // so normal pages carry zero noise. Pages can hold several canvases — every
  // canvas in the stack is identified (document-order index + selector + size).
  function canvasIdent(c) {
    const cls = (typeof c.className === 'string' ? c.className : (c.className && c.className.baseVal) || '');
    let index = -1;
    try {
      const all = document.querySelectorAll('canvas');
      for (let i = 0; i < all.length; i++) if (all[i] === c) { index = i; break; }
    } catch (_) {}
    let size = null;
    try { const r = c.getBoundingClientRect(); size = { w: Math.round(r.width), h: Math.round(r.height) }; } catch (_) {}
    return {
      selector: c.id ? `#${c.id}` : (cls ? 'canvas.' + cls.trim().split(/\s+/).slice(0, 2).join('.') : 'canvas'),
      index,
      ...(size ? { size } : {}),
    };
  }

  function canvasNote(el) {
    try {
      if (!el || !el.tagName) return {};
      let total = 0;
      try { total = document.querySelectorAll('canvas').length; } catch (_) {}
      const many = total > 1 ? { totalCanvases: total } : {};
      if (el.tagName.toLowerCase() === 'canvas') {
        return { canvas: { hit: 'direct', ...canvasIdent(el), ...many,
          note: 'Target is a <canvas>: its contents are pixels, not DOM — get_index/get_text_coords cannot see inside, and no DOM change here is normal. Read the app state (get_framework_state) or use ocr_region / capture_element_screenshot.' } };
      }
      if (!total) return {};
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let stack = [];
      try { stack = document.elementsFromPoint(cx, cy) || []; } catch (_) {}
      const under = [];
      for (const c of stack) {
        if (c !== el && c.tagName && c.tagName.toLowerCase() === 'canvas' &&
            !el.contains(c) && !c.contains(el)) under.push(canvasIdent(c));
      }
      if (!under.length) return {};
      return { canvas: { hit: 'overlay', under, ...many,
        note: 'Target sits on top of a canvas: the element itself is DOM, but the pixels around/behind it are not DOM-visible.' } };
    } catch (_) { return {}; }
  }

  function describeTarget(el) {
    if (!el) return null;
    const cls = (typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '');
    const sel = el.id ? `#${el.id}`
      : (cls ? '.' + cls.trim().split(/\s+/).slice(0, 2).join('.') : (el.tagName || '').toLowerCase());
    return {
      tag: (el.tagName || '').toLowerCase(),
      id: el.id || undefined,
      name: el.name || undefined,
      label: ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) ||
              (el.textContent || '').trim().slice(0, 40)) || undefined,
      selector: sel,
    };
  }

  // Dispatch an Enter keystroke (optionally with a modifier) to submit a field or
  // insert a line break. Submit gestures vary by app: plain Enter (most chats),
  // Shift+Enter (newline), Ctrl/Cmd+Enter (Slack/forms/editors). Best-effort —
  // synthetic key events are untrusted, so editors gating on isTrusted may ignore them.
  function pressEnterCombo(el, submit, fireFormSubmit) {
    const mods = {
      'enter':       {},
      'shift-enter': { shiftKey: true },
      'ctrl-enter':  { ctrlKey: true },
      'cmd-enter':   { metaKey: true },
    }[submit];
    if (!mods) return false;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ...mods };
    el.dispatchEvent(new KeyboardEvent('keydown',  opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup',    opts));
    // Plain Enter on a form field also emits a best-effort submit so single-input forms
    // react — matching the legacy pressEnter behaviour.
    if (fireFormSubmit && submit === 'enter') {
      el.dispatchEvent(new Event('submit', { bubbles: true }));
    }
    return true;
  }

  // ── Keyboard fidelity helpers ──────────────────────────────────────────────────
  // The old typing path set only `key` on KeyboardEvents, so pages that gate on
  // `e.code` or `e.keyCode` (shortcut handlers, games, some rich editors) saw empty
  // values and ignored the keystroke. These helpers fill in physical-keyboard fields
  // (code/keyCode/which/location) so synthetic keys look like real ones.
  const NAMED_KEYS = {
    'Enter':      { code: 'Enter',      keyCode: 13 },
    'Tab':        { code: 'Tab',        keyCode: 9  },
    'Backspace':  { code: 'Backspace',  keyCode: 8  },
    'Delete':     { code: 'Delete',     keyCode: 46 },
    'Escape':     { code: 'Escape',     keyCode: 27 },
    'Esc':        { code: 'Escape',     keyCode: 27, key: 'Escape' },
    'Space':      { code: 'Space',      keyCode: 32, key: ' ' },
    ' ':          { code: 'Space',      keyCode: 32 },
    'ArrowUp':    { code: 'ArrowUp',    keyCode: 38 },
    'ArrowDown':  { code: 'ArrowDown',  keyCode: 40 },
    'ArrowLeft':  { code: 'ArrowLeft',  keyCode: 37 },
    'ArrowRight': { code: 'ArrowRight', keyCode: 39 },
    'Home':       { code: 'Home',       keyCode: 36 },
    'End':        { code: 'End',        keyCode: 35 },
    'PageUp':     { code: 'PageUp',     keyCode: 33 },
    'PageDown':   { code: 'PageDown',   keyCode: 34 },
  };
  const PUNCT_CODE = {
    '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
    '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', '`': 'Backquote',
    ',': 'Comma', '.': 'Period', '/': 'Slash',
  };

  // Map a character or named key → KeyboardEvent init fields with physical fidelity.
  function keyInfo(ch) {
    const named = NAMED_KEYS[ch];
    if (named) return { key: named.key || ch, code: named.code, keyCode: named.keyCode, which: named.keyCode, location: 0 };
    let code = '', keyCode = ch ? ch.charCodeAt(0) : 0;
    if (/^[a-zA-Z]$/.test(ch))   { code = 'Key' + ch.toUpperCase(); keyCode = ch.toUpperCase().charCodeAt(0); }
    else if (/^[0-9]$/.test(ch)) { code = 'Digit' + ch;            keyCode = ch.charCodeAt(0); }
    else if (PUNCT_CODE[ch])     { code = PUNCT_CODE[ch]; }
    return { key: ch, code, keyCode, which: keyCode, location: 0 };
  }

  // Dispatch one keyboard event for a character/key, carrying any held modifiers.
  function fireKey(el, type, ch, mods) {
    const m = mods || {};
    return el.dispatchEvent(new KeyboardEvent(type, {
      ...keyInfo(ch), bubbles: true, cancelable: true,
      ctrlKey: !!m.ctrlKey, metaKey: !!m.metaKey, shiftKey: !!m.shiftKey, altKey: !!m.altKey,
    }));
  }

  // Characters an IME typically composes (CJK). When present we wrap typing in a
  // composition sequence so IME-aware editors (CJK input fields, ProseMirror, Gemini)
  // register the text instead of dropping keystrokes they expect to arrive via IME.
  const CJK_RE = /[　-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]/;

  // ── Action handlers ──────────────────────────────────────────────────────────

  const handlers = {

    async click(action) {
      const el = resolveTarget(action);
      if (!el) return { ok: false, error: `Element not found: ${JSON.stringify({ selector: action.selector, text: action.text })}` };

      const analyzer = window.__SI_CLICKABILITY__;
      if (analyzer) {
        let report = analyzer.analyzeClickability(el);
        if (!report.exists) return { ok: false, error: 'Element not found', clickability: analyzer.cleanReport(report) };
        if (report.disabled) return { ok: false, error: 'Element is disabled', clickability: analyzer.cleanReport(report) };

        if (report.obstructed && report.canAutoFix) {
          report = await analyzer.autoUnblockPipeline(report);
        }
        if (report.obstructed && !report.canAutoFix) {
          return { ok: false, error: 'Element is obstructed', clickability: analyzer.cleanReport(report) };
        }

        if (!report.inViewport) {
          scrollIntoView(el);
          const vp = analyzer._internal.checkViewport(el);
          report.inViewport = vp.inViewport;
          report.rect = vp.rect;
        } else {
          scrollIntoView(el);
        }

        report.recommendedStrategy = analyzer._internal.selectStrategy(report);
        report.strategyUsed = report.recommendedStrategy;

        if (report.strategyUsed === 'none') {
          return { ok: false, error: 'No valid click strategy available', clickability: analyzer.cleanReport(report) };
        }

        const fp = analyzer.capturePreClickFingerprint(el);

        if (report.strategyUsed === 'direct') {
          try { el.click(); } catch (e) { return { ok: false, error: e.message, clickability: analyzer.cleanReport(report) }; }
        } else if (report.strategyUsed === 'programmatic') {
          // Programmatic click: invoke React Fiber onClick or Vue instance handler directly.
          // This bypasses pointer-events:none and works even when the element is obscured.
          // NOTE: browser native defaults (form submit, link nav) are NOT triggered.
          let handled = false;

          // ── React Fiber path ──────────────────────────────────────────────
          try {
            const fiberKey = Object.keys(el).find(k =>
              k.startsWith('__reactFiber$') || k.startsWith('__reactInternals$')
            );
            if (fiberKey) {
              let fiber = el[fiberKey];
              // Walk up to find the nearest fiber with an onClick prop
              let cur = fiber;
              while (cur) {
                const props = cur.memoizedProps;
                if (props) {
                  const handler = props.onClick || props.onPointerUp || props.onMouseUp;
                  if (typeof handler === 'function') {
                    // Synthesise a minimal SyntheticEvent-compatible object
                    const rect = el.getBoundingClientRect();
                    const synthEvent = {
                      type: 'click',
                      target: el,
                      currentTarget: el,
                      bubbles: true,
                      cancelable: true,
                      defaultPrevented: false,
                      preventDefault() { this.defaultPrevented = true; },
                      stopPropagation() {},
                      stopImmediatePropagation() {},
                      nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true }),
                      clientX: rect.left + rect.width  / 2,
                      clientY: rect.top  + rect.height / 2,
                      pageX:   rect.left + rect.width  / 2 + window.scrollX,
                      pageY:   rect.top  + rect.height / 2 + window.scrollY,
                      button: 0,
                      buttons: 1,
                      persist() {},
                    };
                    handler(synthEvent);
                    handled = true;
                    break;
                  }
                }
                cur = cur.return;
              }
            }
          } catch (_) { /* React not present or error traversing fiber */ }

          // ── Vue 3 path ────────────────────────────────────────────────────
          if (!handled) {
            try {
              const vueKey = Object.keys(el).find(k => k.startsWith('__vueParentComponent'));
              if (vueKey) {
                const instance = el[vueKey];
                if (instance) {
                  // Walk up vnode tree looking for onClick
                  let vnode = instance.vnode || instance.subTree;
                  let attempts = 0;
                  while (vnode && attempts++ < 10) {
                    const props = vnode.props;
                    if (props) {
                      const handler = props.onClick || props.onPointerUp || props.onMouseUp;
                      if (typeof handler === 'function') {
                        handler(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        handled = true;
                        break;
                      }
                    }
                    vnode = vnode.component?.vnode || vnode.parent;
                  }
                }
              }
            } catch (_) { /* Vue not present or error */ }
          }

          // ── Fallback: direct el.click() ───────────────────────────────────
          if (!handled) {
            try { el.click(); handled = true; }
            catch (e) { return { ok: false, error: e.message, clickability: analyzer.cleanReport(report) }; }
          }
        } else {
          const btn = action.button === 'right' ? 2 : action.button === 'middle' ? 1 : 0;
          const evOpts = { bubbles: true, cancelable: true, view: window, button: btn };
          const dispatch = (type) => el.dispatchEvent(new MouseEvent(type, evOpts));
          if (action.double) {
            dispatch('mouseover'); dispatch('mouseenter'); dispatch('mousemove');
            dispatch('mousedown'); dispatch('mouseup'); dispatch('click');
            dispatch('mousedown'); dispatch('mouseup'); dispatch('click');
            dispatch('dblclick');
          } else {
            dispatch('mouseover'); dispatch('mouseenter'); dispatch('mousemove');
            dispatch('mousedown'); dispatch('mouseup'); dispatch('click');
          }
        }

        // Framework re-render と SPA/Turbo の非同期遷移の解決をイベント駆動で待つ
        await waitForClickSettle(fp, el);
        const diagnosis = analyzer.diagnoseClickResult(el, fp);
        report.diagnosis = diagnosis;

        return {
          ok: true,
          tagName: el.tagName,
          text: el.textContent?.trim().slice(0, 50),
          ...selectorAmbiguity(action),
          ...textMatchNote(action),
          ...canvasNote(el),
          clickability: analyzer.cleanReport(report),
          diagnosis
        };
      }

      // Fallback: Analyzer is disabled
      scrollIntoView(el);
      const btn = action.button === 'right' ? 2 : action.button === 'middle' ? 1 : 0;
      const evOpts = { bubbles: true, cancelable: true, view: window, button: btn };
      const dispatch = (type) => el.dispatchEvent(new MouseEvent(type, evOpts));

      if (action.double) {
        dispatch('mouseover'); dispatch('mouseenter'); dispatch('mousemove');
        dispatch('mousedown'); dispatch('mouseup'); dispatch('click');
        dispatch('mousedown'); dispatch('mouseup'); dispatch('click');
        dispatch('dblclick');
      } else {
        dispatch('mouseover'); dispatch('mouseenter'); dispatch('mousemove');
        dispatch('mousedown'); dispatch('mouseup'); dispatch('click');
      }

      return { ok: true, tagName: el.tagName, text: el.textContent?.trim().slice(0, 50), ...selectorAmbiguity(action), ...textMatchNote(action), ...canvasNote(el) };
    },

    type(action) {
      let el = action.selector ? findBySelector(action.selector) : document.activeElement;
      if (!el || el === document.body) {
        return { ok: false, error: action.selector
          ? `No target element for type: selector "${action.selector}" did not match`
          : 'No target element for type: no selector given and nothing is focused. Pass a selector (type focuses it automatically) or focus/click a field first.' };
      }
      if (action.selector) scrollIntoView(el);

      el.focus();

      const text = action.text == null ? '' : String(action.text);
      const submit = resolveSubmit(action);

      // submit:'auto' → infer the submit key from observable signals (honest null on
      // unknown). onFail='abort' returns without typing; 'type-only' (default) types
      // the text and just skips the submit, reporting submitInference either way.
      let effectiveSubmit = submit;
      let submitInference = null;
      if (submit === 'auto') {
        submitInference = inferSubmitKey(el);
        effectiveSubmit = submitInference.key || 'none';
        if (!submitInference.key && (action.submitOnFail || 'type-only') === 'abort') {
          return { ok: true, typedLength: 0, submitted: null, submitInference,
                   note: 'Submit key could not be inferred (onFail=abort): nothing typed. Specify submit explicitly or click the send control.' };
        }
      }

      // Empty text with no effective submit key is a focus-only no-op (already focused).
      if (text === '' && effectiveSubmit === 'none') {
        return { ok: true, typedLength: 0, ...(submitInference ? { submitInference } : {}),
                 note: 'Nothing to type and no submit key — element focused only.' };
      }

      // contenteditable / rich-text editors (Gemini, Notion, ProseMirror, …) have no
      // `.value`; the <input>/<textarea> path below would throw on `el.value.length`.
      // Drive them via execCommand('insertText') so the editor's own beforeinput/input
      // pipeline fires and the framework state updates.
      const isContentEditable = el.isContentEditable === true ||
        (typeof el.value === 'undefined' && el.getAttribute && el.getAttribute('contenteditable') != null);

      if (isContentEditable) {
        if (action.clear) {
          try { el.textContent = ''; } catch (_) {}
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Wrap CJK (or explicit action.composition) in an IME composition sequence so
        // editors that only commit text on compositionend register the input.
        const useComposition = action.composition === true ||
          (action.composition !== false && CJK_RE.test(text));
        if (useComposition && text) {
          el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        }
        let composed = '';
        for (const char of text) {
          fireKey(el, 'keydown', char);
          if (useComposition) {
            composed += char;
            el.dispatchEvent(new CompositionEvent('compositionupdate', { data: composed, bubbles: true }));
          }
          let inserted = false;
          try { inserted = document.execCommand('insertText', false, char); } catch (_) {}
          if (!inserted) {
            // Fallback for editors that ignore execCommand: emit beforeinput, then append.
            try {
              el.dispatchEvent(new InputEvent('beforeinput', {
                inputType: useComposition ? 'insertCompositionText' : 'insertText',
                data: useComposition ? composed : char, bubbles: true, cancelable: true,
              }));
              el.textContent = (el.textContent || '') + char;
            } catch (_) {}
          }
          el.dispatchEvent(new InputEvent('input', {
            inputType: useComposition ? 'insertCompositionText' : 'insertText',
            data: useComposition ? composed : char, bubbles: true,
          }));
          fireKey(el, 'keyup', char);
        }
        if (useComposition && text) {
          el.dispatchEvent(new CompositionEvent('compositionend', { data: composed, bubbles: true }));
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: composed, bubbles: true }));
        }
        if (effectiveSubmit !== 'none') pressEnterCombo(el, effectiveSubmit, false);
        return { ok: true, typedLength: text.length, submitted: effectiveSubmit !== 'none' ? effectiveSubmit : undefined,
                 ...(submitInference ? { submitInference } : {}), ...(useComposition ? { composition: true } : {}),
                 ...selectorAmbiguity(action), target: describeTarget(el), currentValue: el.textContent };
      }

      if (action.clear) {
        setNativeValue(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Type character by character for React synthetic event compatibility.
      // setNativeValue writes through the element's own prototype setter so React's
      // onChange sees the update (see the helper for why the interface must match),
      // and emit beforeinput/input (InputEvent with inputType+data) like a real keypress.
      for (const char of text) {
        fireKey(el, 'keydown',  char);
        fireKey(el, 'keypress', char);
        const start = el.selectionStart ?? el.value.length;
        const end   = el.selectionEnd ?? start;
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true, cancelable: true }));
        const next = el.value.slice(0, start) + char + el.value.slice(end);
        setNativeValue(el, next);
        try { el.selectionStart = el.selectionEnd = start + char.length; } catch (_) {}
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
        fireKey(el, 'keyup', char);
      }

      if (effectiveSubmit !== 'none') pressEnterCombo(el, effectiveSubmit, true);

      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, typedLength: text.length, submitted: effectiveSubmit !== 'none' ? effectiveSubmit : undefined,
               ...(submitInference ? { submitInference } : {}), ...selectorAmbiguity(action),
               target: describeTarget(el), currentValue: el.value };
    },

    async press_key(action) {
      // Optional element targeting: selector/text (same resolution as click) focuses
      // the element first, so keys land where the agent intends instead of wherever
      // focus happens to be. Without a target, legacy behaviour: the focused element.
      let focused;
      if (action.selector || action.text) {
        const el = resolveTarget(action);
        if (!el) return { ok: false, error: `Element not found for press_key: ${JSON.stringify({ selector: action.selector, text: action.text })}` };
        scrollIntoView(el);
        try { el.focus(); } catch (_) {}
        // Dispatch on the focused element when focus() took; otherwise on the element
        // itself — many key handlers live on non-focusable nodes.
        focused = (document.activeElement && (document.activeElement === el || el.contains(document.activeElement)))
          ? document.activeElement : el;
      } else {
        focused = document.activeElement || document.body || document.documentElement || document;
      }
      // Modifier names set modifier flags; every other part is a real key. More
      // than one real key is a chord ("w+d"): all go down in order, then come up
      // in reverse — previously the extra keys were silently dropped.
      const MODS = { Control: 'ctrl', Ctrl: 'ctrl', Meta: 'meta', Command: 'meta', Cmd: 'meta', Shift: 'shift', Alt: 'alt', Option: 'alt' };
      const rawParts = action.key === '+' ? ['+'] : action.key.split('+').filter(p => p !== '');
      const flags = { ctrl: false, meta: false, shift: false, alt: false };
      const keys = [];
      for (const p of rawParts) {
        if (MODS[p]) flags[MODS[p]] = true;
        else keys.push(p);
      }
      if (action.key.length > 1 && action.key.endsWith('++')) keys.push('+'); // "Ctrl++" = Ctrl + literal plus
      if (!keys.length && rawParts.length) keys.push(rawParts[rawParts.length - 1]); // modifier alone, e.g. "Shift"
      if (!keys.length) return { ok: false, error: `press_key: no key in "${action.key}"` };

      const evOpts = (key) => ({ ...keyInfo(key), key, bubbles: true, cancelable: true,
        ctrlKey: flags.ctrl, metaKey: flags.meta, shiftKey: flags.shift, altKey: flags.alt });
      for (const k of keys) focused.dispatchEvent(new KeyboardEvent('keydown',  evOpts(k)));
      for (const k of keys) focused.dispatchEvent(new KeyboardEvent('keypress', evOpts(k)));
      // holdMs: keep the chord held before release (games / long-press UIs). Capped at 5s.
      if (action.holdMs > 0) await new Promise(r => setTimeout(r, Math.min(action.holdMs, 5000)));
      for (const k of [...keys].reverse()) focused.dispatchEvent(new KeyboardEvent('keyup', evOpts(k)));
      return { ok: true, key: action.key, ...(keys.length > 1 ? { chord: keys } : {}), target: focused.tagName,
               ...((action.selector || action.text) ? { targetInfo: describeTarget(focused.tagName ? focused : null) } : {}),
               ...selectorAmbiguity(action), ...textMatchNote(action) };
    },

    hover(action) {
      const el = resolveTarget(action);
      if (!el) return { ok: false, error: 'Element not found for hover' };
      scrollIntoView(el);
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new MouseEvent('mouseover',  opts));
      el.dispatchEvent(new MouseEvent('mouseenter', opts));
      el.dispatchEvent(new MouseEvent('mousemove',  opts));
      return { ok: true, tagName: el.tagName, ...textMatchNote(action), ...canvasNote(el) };
    },

    async mouse_scroll(action) {
      const x = action.x != null ? action.x - window.scrollX : (action.selector ? (() => { const el = findBySelector(action.selector); const r = el.getBoundingClientRect(); return r.left + r.width/2; })() : window.innerWidth / 2);
      const y = action.y != null ? action.y - window.scrollY : (action.selector ? (() => { const el = findBySelector(action.selector); const r = el.getBoundingClientRect(); return r.top + r.height/2; })() : window.innerHeight / 2);
      const deltaX = action.deltaX || 0;
      const deltaY = action.deltaY != null ? action.deltaY : (action.lines ? action.lines * 100 : 0);

      const el = document.elementFromPoint(x, y) || document.body;
      const evOpts = {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, deltaX, deltaY, deltaMode: 0,
      };

      // Synthetic wheel events are untrusted: the browser performs NO default
      // scrolling for them — only page wheel handlers can react. The old code
      // returned ok:true unconditionally, so on native scrollers this was a
      // silent no-op. Now: measure what actually moved (nearest scrollable
      // ancestor + window), and when no handler consumed the event and nothing
      // moved, fall back to scrolling the container directly — reported as
      // via:'scroll_fallback' so the agent knows which mechanism worked.
      const scrollable = (() => {
        let n = el;
        while (n && n !== document.body && n !== document.documentElement) {
          try {
            const s = getComputedStyle(n);
            if (/(auto|scroll|overlay)/.test(s.overflowY + s.overflowX) &&
                (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) return n;
          } catch (_) {}
          n = n.parentElement;
        }
        return null;
      })();
      const read = () => ({
        win: { x: window.scrollX, y: window.scrollY },
        container: scrollable ? { x: scrollable.scrollLeft, y: scrollable.scrollTop } : null,
      });
      const movedSince = (a, b) =>
        a.win.x !== b.win.x || a.win.y !== b.win.y ||
        (a.container && b.container && (a.container.x !== b.container.x || a.container.y !== b.container.y));

      const before = read();
      const consumed = !el.dispatchEvent(new WheelEvent('wheel', evOpts)); // preventDefault() → page handled it
      // Wheel handlers often apply the scroll asynchronously (rAF) — give them a beat.
      await new Promise(r => setTimeout(r, 120));
      let after = read();
      let scrolled = movedSince(after, before);
      let via = scrolled ? 'wheel_handler' : null;

      if (!scrolled && !consumed && (deltaX || deltaY)) {
        const t = scrollable || window;
        if (t === window) window.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
        else { t.scrollLeft += deltaX; t.scrollTop += deltaY; }
        after = read();
        scrolled = movedSince(after, before);
        if (scrolled) via = 'scroll_fallback';
      }

      return {
        ok: true, at: { x: x + window.scrollX, y: y + window.scrollY }, delta: { deltaX, deltaY },
        scrolled, ...(via ? { via } : {}), ...(consumed ? { handledByPage: true } : {}),
        before, after,
        ...(scrolled ? {} : { _hint: consumed
          ? 'A wheel handler consumed the event (preventDefault) but no scroll position changed — the page may track scroll state internally (canvas/virtual view); verify visually or via capture.'
          : 'Nothing moved: synthetic wheel is untrusted (no native scroll), no wheel handler reacted, and the direct-scroll fallback found no room to move. The area may already be at its boundary, or the scrollable element may be elsewhere — try scroll_page with the container selector.' }),
      };
    },

    async right_click(action) {
      const el = resolveTarget(action);
      if (!el) return { ok: false, error: `Element not found: ${JSON.stringify({ selector: action.selector, text: action.text, x: action.x, y: action.y })}` };

      const analyzer = window.__SI_CLICKABILITY__;
      if (analyzer) {
        let report = analyzer.analyzeClickability(el);
        if (!report.exists) return { ok: false, error: 'Element not found', clickability: analyzer.cleanReport(report) };
        if (report.disabled) return { ok: false, error: 'Element is disabled', clickability: analyzer.cleanReport(report) };

        if (report.obstructed && report.canAutoFix) {
          report = await analyzer.autoUnblockPipeline(report);
        }
        if (report.obstructed && !report.canAutoFix) {
          return { ok: false, error: 'Element is obstructed', clickability: analyzer.cleanReport(report) };
        }

        scrollIntoView(el);
        report.strategyUsed = 'native'; // Context menu は常に native
        const fp = analyzer.capturePreClickFingerprint(el);

        const evOpts = { bubbles: true, cancelable: true, view: window, button: 2 };
        el.dispatchEvent(new MouseEvent('contextmenu', evOpts));

        // 右クリックは通常ネイティブメニューでDOM/URLが変わらないため待機は短め。
        // カスタムメニュー(role=menu等)が出る場合はその mutation で早期確定する。
        await waitForClickSettle(fp, el, 300);
        const diagnosis = analyzer.diagnoseClickResult(el, fp);
        report.diagnosis = diagnosis;

        return {
          ok: true,
          tagName: el.tagName,
          text: el.textContent?.trim().slice(0, 50),
          ...selectorAmbiguity(action),
          ...textMatchNote(action),
          ...canvasNote(el),
          clickability: analyzer.cleanReport(report),
          diagnosis
        };
      }

      // Fallback
      scrollIntoView(el);
      const evOpts = { bubbles: true, cancelable: true, view: window, button: 2 };
      el.dispatchEvent(new MouseEvent('contextmenu', evOpts));
      return { ok: true, tagName: el.tagName, text: el.textContent?.trim().slice(0, 50), ...selectorAmbiguity(action), ...textMatchNote(action), ...canvasNote(el) };
    },

    analyze_click(action) {
      const el = resolveTarget(action);
      if (!el) return { ok: false, error: `Element not found: ${JSON.stringify({ selector: action.selector, text: action.text })}` };
      const analyzer = window.__SI_CLICKABILITY__;
      if (!analyzer) return { ok: false, error: 'Clickability analyzer not loaded' };
      const report = analyzer.analyzeClickability(el);
      return { ok: true, clickability: analyzer.cleanReport(report) };
    },

    drag(action) {
      const fromX = action.fromX != null ? action.fromX : (action.fromSelector ? (() => { const el = findBySelector(action.fromSelector); const r = el.getBoundingClientRect(); return r.left + window.scrollX + r.width/2; })() : null);
      const fromY = action.fromY != null ? action.fromY : (action.fromSelector ? (() => { const el = findBySelector(action.fromSelector); const r = el.getBoundingClientRect(); return r.top + window.scrollY + r.height/2; })() : null);
      const toX   = action.toX;
      const toY   = action.toY;

      if (fromX == null || fromY == null || toX == null || toY == null) {
        return { ok: false, error: 'drag requires fromX/fromY and toX/toY (or fromSelector)' };
      }

      const clientFromX = fromX - window.scrollX;
      const clientFromY = fromY - window.scrollY;
      const clientToX   = toX - window.scrollX;
      const clientToY   = toY - window.scrollY;

      const el = document.elementFromPoint(clientFromX, clientFromY);
      if (!el) return { ok: false, error: `No element at drag start (${fromX},${fromY})` };

      const evOpts = (cx, cy) => ({
        bubbles: true, cancelable: true, view: window,
        clientX: cx, clientY: cy, screenX: cx, screenY: cy,
      });

      el.dispatchEvent(new MouseEvent('mousedown', evOpts(clientFromX, clientFromY)));
      document.dispatchEvent(new MouseEvent('mousemove', evOpts(clientFromX, clientFromY)));
      document.dispatchEvent(new MouseEvent('mousemove', evOpts(clientToX, clientToY)));
      const targetEl = document.elementFromPoint(clientToX, clientToY);
      if (targetEl && targetEl !== el) {
        targetEl.dispatchEvent(new MouseEvent('dragenter', evOpts(clientToX, clientToY)));
        targetEl.dispatchEvent(new MouseEvent('dragover', evOpts(clientToX, clientToY)));
      }
      document.dispatchEvent(new MouseEvent('mouseup', evOpts(clientToX, clientToY)));
      if (targetEl && targetEl !== el) {
        targetEl.dispatchEvent(new MouseEvent('drop', evOpts(clientToX, clientToY)));
      }

      return { ok: true, from: { x: fromX, y: fromY }, to: { x: toX, y: toY }, targetTag: targetEl?.tagName };
    },

    async scroll(action) {
      // Truthful return contract: report the TARGET's own before/after position
      // (container scrollLeft/Top, or window scrollX/Y), the distance actually
      // moved, and whether an edge was hit. Previously the window position was
      // returned even when scrolling an inner container — it never appeared to
      // move and a boundary was indistinguishable from a successful scroll.
      const readPos = (t) => t === window
        ? { x: window.scrollX, y: window.scrollY,
            maxX: Math.max(0, (document.documentElement.scrollWidth  || 0) - window.innerWidth),
            maxY: Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight) }
        : { x: t.scrollLeft, y: t.scrollTop,
            maxX: Math.max(0, t.scrollWidth  - t.clientWidth),
            maxY: Math.max(0, t.scrollHeight - t.clientHeight) };
      // behavior:'smooth' animates past our return — wait until the position
      // stops moving (or ~600ms) so `after` is where the page actually ended up.
      const settle = async (t) => {
        let last = readPos(t);
        const t0 = Date.now();
        while (Date.now() - t0 < 600) {
          await new Promise(r => setTimeout(r, 80));
          const cur = readPos(t);
          if (cur.x === last.x && cur.y === last.y) return cur;
          last = cur;
        }
        return last;
      };
      const summarize = (t, before, after, extra) => {
        const out = {
          ok: true,
          target: t === window ? 'window' : (action.selector || action.toElement),
          before: { x: before.x, y: before.y },
          after:  { x: after.x,  y: after.y },
          moved:  { dx: after.x - before.x, dy: after.y - before.y },
          atBoundary: { top: after.y <= 0, bottom: after.y >= after.maxY,
                        left: after.x <= 0, right: after.x >= after.maxX },
          // Back-compat: scrollX/scrollY stay the window position as before.
          scrollX: window.scrollX, scrollY: window.scrollY,
          ...extra,
        };
        if (out.moved.dx === 0 && out.moved.dy === 0 && !action.toElement) {
          out._hint = 'Position did not change. Check atBoundary — the target may already be at its edge — or the scrollable container may be a different element (pass its selector).';
        }
        return out;
      };

      if (action.toElement) {
        const el = findBySelector(action.toElement);
        if (!el) return { ok: false, error: `Scroll target not found: ${action.toElement}` };
        const before = readPos(window);
        scrollIntoView(el);
        const after = await settle(window);
        const r = el.getBoundingClientRect();
        return summarize(window, before, after, {
          scrolledTo: action.toElement,
          elementInViewport: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
        });
      }

      const target = action.selector ? findBySelector(action.selector) : window;
      if (!target) return { ok: false, error: `Scroll container not found: ${action.selector}` };
      const behavior = action.behavior || 'instant';
      const before = readPos(target);

      if (action.x != null || action.y != null) {
        (target === window ? window : target).scrollTo({ left: action.x, top: action.y, behavior });
      } else {
        const dx = action.deltaX || 0;
        const dy = action.deltaY || 0;
        if (target === window) {
          window.scrollBy({ left: dx, top: dy, behavior });
        } else if (typeof target.scrollBy === 'function') {
          target.scrollBy({ left: dx, top: dy, behavior });
        } else {
          target.scrollLeft += dx;
          target.scrollTop  += dy;
        }
      }
      const after = behavior === 'smooth' ? await settle(target) : readPos(target);
      return summarize(target, before, after);
    },

    select_option(action) {
      const el = findBySelector(action.selector);
      if (!el || el.tagName !== 'SELECT') return { ok: false, error: `SELECT not found: ${action.selector}` };

      if (action.value) {
        setNativeValue(el, action.value);
      } else if (action.label) {
        const lower = action.label.toLowerCase();
        const opt = [...el.options].find(o => o.text.toLowerCase().includes(lower) || o.value.toLowerCase().includes(lower));
        if (!opt) return { ok: false, error: `Option not found: ${action.label}` };
        setNativeValue(el, opt.value);
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      return { ok: true, selectedValue: el.value, selectedText: el.options[el.selectedIndex]?.text };
    },

    check(action) {
      const el = findBySelector(action.selector);
      if (!el) return { ok: false, error: `Checkbox not found: ${action.selector}` };
      const target = action.checked !== false;
      if (el.checked !== target) {
        el.checked = target;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('click',  { bubbles: true }));
      }
      return { ok: true, checked: el.checked };
    },

    focus(action) {
      // resolveTarget (not bare findBySelector) so text targeting works — the CDP
      // press_key/type paths pre-focus through this action with selector OR text.
      const el = resolveTarget(action);
      if (!el) return { ok: false, error: `Element not found: ${JSON.stringify({ selector: action.selector, text: action.text })}` };
      scrollIntoView(el);
      el.focus();
      return { ok: true, focused: document.activeElement === el, ...textMatchNote(action) };
    },

    clear_input(action) {
      const el = findBySelector(action.selector);
      if (!el) return { ok: false, error: `Element not found: ${action.selector}` };
      setNativeValue(el, ''); // prototype setter — a bare el.value='' is invisible to React
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    },

    navigate(action) {
      window.location.href = action.url;
      return { ok: true, url: action.url };
    },

    go_back()    { history.back();    return { ok: true }; },
    go_forward() { history.forward(); return { ok: true }; },
    reload(action) { location.reload(!!action.hard); return { ok: true }; },

    wait_for_element(action) {
      const timeout = action.timeoutMs || 10000;
      const start   = Date.now();
      return new Promise((resolve) => {
        const check = () => {
          let found = null;
          if (action.selector) {
            found = document.querySelector(action.selector);
            if (found && action.visible) {
              const r = found.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) found = null;
            }
          } else if (action.text) {
            found = [...document.querySelectorAll('*')].find(el => el.textContent?.includes(action.text) && !el.children.length);
          }
          if (found) {
            resolve({ ok: true, found: true, tagName: found.tagName, durationMs: Date.now() - start });
          } else if (Date.now() - start > timeout) {
            resolve({ ok: false, found: false, error: 'Timeout waiting for element', durationMs: Date.now() - start });
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    },

    execute_js(action) {
      // Optionally capture console output during execution
      const captureConsole = action.captureConsole !== false; // default: true
      const consoleLogs = [];

      let originals = {};
      if (captureConsole) {
        for (const lvl of ['log', 'warn', 'error', 'info', 'debug']) {
          originals[lvl] = console[lvl];
          console[lvl] = (...args) => {
            originals[lvl](...args); // pass through
            consoleLogs.push({
              level: lvl,
              ts: Date.now(),
              args: args.map(a => {
                try { return typeof a === 'object' ? JSON.parse(JSON.stringify(a)) : String(a); }
                catch { return String(a); }
              }),
            });
          };
        }
      }

      const restore = () => {
        if (captureConsole) {
          for (const lvl of Object.keys(originals)) console[lvl] = originals[lvl];
        }
      };

      try {
        console.warn('[SECURITY] execute_js: running arbitrary JS in page context — code length:', action.code?.length);
        // eslint-disable-next-line no-new-func
        const result = new Function(`return (${action.code})`)();
        if (result instanceof Promise) {
          return result
            .then(v  => { restore(); return { ok: true,  result: v,         consoleLogs }; })
            .catch(e => { restore(); return { ok: false, error: e.message,  consoleLogs }; });
        }
        restore();
        return { ok: true, result, consoleLogs };
      } catch (e) {
        restore();
        return { ok: false, error: e.message, consoleLogs };
      }
    },

    // ── dev-exec: execute_module (blob backend) ────────────────────────────────
    // Run a self-contained ES module (dependencies already bundled) in the MAIN
    // world, on the real page runtime. Distinct from execute_js (a single
    // expression). Gated server-side by dev mode; injected here as a blob URL +
    // dynamic import so it touches real framework state — the reason dev-exec
    // exists. See docs/vision/whiskor-for-dev/dev-exec.md SECTION 3 (D-6, I-5, I-8).
    async execute_module(action) {
      const code = action.code;
      if (typeof code !== 'string' || !code) {
        return { ok: false, error: 'execute_module requires string `code`.' };
      }

      // I-5: the authoritative origin check is HERE — measured in the very context
      // that will run the code, so there is no request→inject TOCTOU window. An
      // allowed entry is a "proto://host" prefix and matches any port (dev servers
      // pick arbitrary ports).
      const allowed = Array.isArray(action.allowedOrigins) ? action.allowedOrigins : null;
      const originParts = (s) => { try { const u = new URL(s); return u.protocol.replace(/:$/, '') + '//' + u.hostname; } catch { return null; } };
      if (allowed) {
        const here = location.origin;
        const hp = originParts(here);
        const ok = allowed.some(a => { const w = originParts(a); return w && hp && w === hp; });
        if (!ok) {
          // ok:true envelope so the structured `blocked`/`origin` survive transport
          // (ACTION_COMPLETE drops all but `error` when the envelope is ok:false).
          return { ok: true, outcome: 'blocked', blocked: 'origin_not_allowed', origin: here,
            error: `execute_module refused: origin ${here} is not in the dev allow-list.` };
        }
      }

      const mode = action.mode === 'harness' ? 'harness' : 'probe';
      const timeoutMs = Number.isFinite(action.timeoutMs) ? action.timeoutMs : 10000;
      const maxConsole = Number.isFinite(action.maxConsoleEntries) ? action.maxConsoleEntries : 200;

      // Console capture (bounded — the artifact could log in a loop).
      const consoleLogs = [];
      const originals = {};
      for (const lvl of ['log', 'warn', 'error', 'info', 'debug']) {
        originals[lvl] = console[lvl];
        console[lvl] = (...cargs) => {
          originals[lvl](...cargs);
          if (consoleLogs.length < maxConsole) {
            consoleLogs.push({ level: lvl, ts: Date.now(), args: cargs.map(a => {
              try { return typeof a === 'object' ? JSON.parse(JSON.stringify(a)) : String(a); }
              catch { return String(a); }
            }) });
          }
        };
      }
      const restore = () => { for (const lvl of Object.keys(originals)) console[lvl] = originals[lvl]; };

      // Serialize a return value for transport. Not-JSON-able values (functions,
      // DOM nodes, cyclic objects) return a non-leaky marker instead of throwing.
      const serializeValue = (v) => {
        if (v === undefined) return undefined;
        try { return JSON.parse(JSON.stringify(v)); }
        catch {
          let preview;
          try { preview = String(v).slice(0, 200); } catch { preview = '(unprintable)'; }
          return { unserializable: true, type: typeof v, preview };
        }
      };

      const withTimeout = (p, ms) => new Promise((resolve, reject) => {
        const t = setTimeout(() => { const e = new Error('timeout'); e.__whiskorTimeout = true; reject(e); }, ms);
        Promise.resolve(p).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
      });

      // ── baseline (verdict engine 5.1) ─────────────────────────────────────────
      // Captured in the very context that runs the code, right before injection.
      // compositeHash comes from the collector's live global (state-reporter reads
      // the same one); null when React/DOM hashing hasn't populated it yet.
      const readHash = () => {
        try { return (window.__SI_CURRENT_HASH__ && window.__SI_CURRENT_HASH__.compositeHash) || null; }
        catch { return null; }
      };
      const baseline = { stateHash: readHash(), url: location.href, title: document.title };

      // Uncaught error/rejection watermark: fresh listeners for THIS window, so
      // anything they catch is by definition new since baseline (5.1).
      const uncaughtErrors = [];
      const onErr = (ev) => { if (uncaughtErrors.length < 50) uncaughtErrors.push({ kind: 'error',
        message: String((ev && (ev.message || (ev.error && ev.error.message))) || 'error').slice(0, 300) }); };
      const onRej = (ev) => { if (uncaughtErrors.length < 50) uncaughtErrors.push({ kind: 'unhandledrejection',
        message: String((ev && ev.reason && (ev.reason.message || ev.reason)) || 'rejection').slice(0, 300) }); };
      window.addEventListener('error', onErr, true);
      window.addEventListener('unhandledrejection', onRej);

      // ── settle (verdict engine 5.2) ───────────────────────────────────────────
      // Event-driven, not a fixed sleep: resolve once the page is quiet for
      // settleQuietMs (no DOM mutation ∧ no in-flight fetch/XHR), capped at
      // settleMaxMs. Reuses the same MutationObserver idea as post-click settle.
      const settleQuietMs = Number.isFinite(action.settleQuietMs) ? action.settleQuietMs : 500;
      const settleMaxMs   = Number.isFinite(action.settleMaxMs)   ? action.settleMaxMs   : 8000;

      // Start watching DOM mutations + in-flight fetch/XHR RIGHT NOW — before the
      // module evaluates — so a module's OWN (often synchronous) mutations count as
      // an effect, not just async after-effects a post-eval observer would catch.
      // Wrapping over any existing wrapper (network analyzer) is safe: each calls
      // the prior. (verdict engine 5.2/5.3)
      const monitor = (() => {
        let mutations = 0, inFlight = 0, mo = null, onActivity = () => {};
        const origFetch = window.fetch;
        const OrigSend = XMLHttpRequest && XMLHttpRequest.prototype && XMLHttpRequest.prototype.send;
        try {
          mo = new MutationObserver((recs) => { mutations += recs.length; onActivity(); });
          mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        } catch (_) {}
        try {
          if (typeof origFetch === 'function') {
            window.fetch = function (...a) { inFlight++;
              return origFetch.apply(this, a).finally(() => { inFlight = Math.max(0, inFlight - 1); onActivity(); }); };
          }
        } catch (_) {}
        try {
          if (OrigSend) {
            XMLHttpRequest.prototype.send = function (...a) { inFlight++;
              try { this.addEventListener('loadend', () => { inFlight = Math.max(0, inFlight - 1); onActivity(); }); } catch (_) {}
              return OrigSend.apply(this, a); };
          }
        } catch (_) {}
        return {
          get mutations() { return mutations; },
          get inFlight()  { return inFlight; },
          onActivity(fn)  { onActivity = fn; },
          stop() {
            try { mo && mo.disconnect(); } catch (_) {}
            try { if (typeof origFetch === 'function') window.fetch = origFetch; } catch (_) {}
            try { if (OrigSend) XMLHttpRequest.prototype.send = OrigSend; } catch (_) {}
          },
        };
      })();

      // Wait (event-driven) for the page to go quiet — no mutation ∧ no in-flight
      // fetch/XHR for settleQuietMs — capped at settleMaxMs. Uses the monitor that
      // has been running since baseline, so mutations during eval are already counted.
      const settle = () => new Promise((resolve) => {
        let done = false, quietT = null, capT = null;
        const finish = (atCap) => {
          if (done) return; done = true;
          if (quietT) clearTimeout(quietT);
          if (capT) clearTimeout(capT);
          resolve({ settledAtCap: !!atCap });
        };
        const arm = () => { if (quietT) clearTimeout(quietT);
          quietT = setTimeout(() => { if (monitor.inFlight <= 0) finish(false); }, settleQuietMs); };
        monitor.onActivity(arm);
        capT = setTimeout(() => finish(true), settleMaxMs);
        arm(); // start the quiet clock even if nothing ever happens (no-op → ~quietMs)
      });

      // Observed snapshot after settle (5.3). Safe to call from any exit path.
      const observe = (settleRes) => {
        monitor.stop();
        window.removeEventListener('error', onErr, true);
        window.removeEventListener('unhandledrejection', onRej);
        return {
          stateHash: readHash(),
          url: location.href,
          title: document.title,
          mutations: monitor.mutations,
          settledAtCap: settleRes ? settleRes.settledAtCap : false,
          navigated: location.href !== baseline.url,
          uncaughtErrors,
        };
      };

      const injectedAt = Date.now();
      let url = null;
      try {
        const blob = new Blob([code], { type: 'text/javascript' });
        url = URL.createObjectURL(blob);
        const mod = await withTimeout(import(url), timeoutMs);
        const evaluatedMs = Date.now() - injectedAt;

        let value;
        if (mode === 'harness') {
          // harness = convention, not a framework (D-4). Run each named fn in
          // `export const __whiskor_tests__ = { name: fn }`; throw = fail.
          const tests = mod && mod.__whiskor_tests__;
          const cases = [];
          let passed = 0, failed = 0;
          if (tests && typeof tests === 'object') {
            for (const name of Object.keys(tests)) {
              const fn = tests[name];
              if (typeof fn !== 'function') continue;
              const t0 = Date.now();
              try { await withTimeout(fn(), timeoutMs); cases.push({ name, ok: true, ms: Date.now() - t0 }); passed++; }
              catch (err) { cases.push({ name, ok: false, error: String(err && err.message || err), ms: Date.now() - t0 }); failed++; }
            }
          }
          value = { total: cases.length, passed, failed, cases };
        } else {
          let out = mod ? mod.default : undefined;
          if (out instanceof Promise) out = await withTimeout(out, timeoutMs);
          value = serializeValue(out);
        }
        // Let async side effects (fetch → DOM swap) play out, then snapshot.
        const settleRes = await settle();
        const observed = observe(settleRes);
        const settledMs = Date.now() - injectedAt;
        return { ok: true, outcome: 'ok', backend: 'blob', mode, value, consoleLogs,
          baseline, observed, timings: { evaluatedMs, settledMs } };
      } catch (e) {
        // All post-injection outcomes ride an ok:true envelope with a structured
        // `outcome`, so blocked/error/timeout detail survives transport (see above).
        const observed = observe(null); // no settle window on the failure paths
        const msg = String(e && e.message || e);
        if (e && e.__whiskorTimeout) {
          return { ok: true, outcome: 'timeout', backend: 'blob', mode,
            error: `execute_module timed out after ${timeoutMs}ms.`, consoleLogs, baseline, observed };
        }
        // blob: import blocked by the page's CSP script-src (the honest blob-backend
        // limit; Chrome can fall back to the CDP backend in a later slice).
        if (/content security policy|refused to (load|execute|import)|violat/i.test(msg)) {
          return { ok: true, outcome: 'blocked', blocked: 'csp_blocked', backend: 'blob',
            error: `blob injection blocked by page CSP: ${msg}`,
            hint: 'Allow blob: in the dev server CSP script-src, or use Chrome (CDP backend).', consoleLogs, baseline, observed };
        }
        // Uncaught exception during evaluation → executed-but-threw.
        return { ok: true, outcome: 'error', backend: 'blob', mode, error: msg,
          stack: e && e.stack ? String(e.stack).slice(0, 2000) : undefined, consoleLogs, baseline, observed };
      } finally {
        restore();
        if (url) { try { URL.revokeObjectURL(url); } catch (_) {} }
      }
    },
  };

  // ── Action-type namespace bridge ─────────────────────────────────────────────
  // MCP exposes write tools under names like `type_text` / `navigate_to`, but the
  // executor's handlers use the bare verbs (`type` / `navigate`). The MCP layer
  // translates (see write.js), but an agent hitting POST /api/action directly never
  // gets that translation. Accept the MCP names as aliases so the two surfaces
  // converge, and on a genuine miss return the valid set + nearest match instead of
  // a dead-end string. This file is the single source of truth for action types.
  const ACTION_ALIASES = {
    type_text:   'type',
    navigate_to: 'navigate',
    scroll_page: 'scroll',
    check_box:   'check',
    reload_page: 'reload',
  };

  // Read/query tools live on the server, not in this executor. Agents sometimes POST
  // them to /api/action by mistake — point them at the right surface rather than
  // just saying "unknown".
  const READ_ONLY_TOOLS = new Set([
    'find_target', 'get_ui_catalog', 'get_text_coords', 'get_sessions', 'get_index',
    'get_network', 'get_framework_state', 'get_viewport', 'get_console_logs',
    'get_storage', 'get_dom_snapshot', 'get_accessibility', 'capture_screenshot',
    'capture_packed_som', 'get_element_thumbnail',
  ]);

  function _levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      prev = cur;
    }
    return prev[n];
  }

  // Build a helpful result for an unrecognised action type: list the valid types,
  // route read-tool names to the correct surface, and suggest the nearest verb.
  function _unknownActionResult(type) {
    const validTypes = Object.keys(handlers).sort();
    // On failure the transport (postMessage below) forwards only `error` as a string —
    // structured fields are dropped. So everything useful must live in the string. We
    // keep the structured fields too, for any in-process caller that sees the object.
    if (READ_ONLY_TOOLS.has(type)) {
      const hint = `"${type}" is a read/query tool, not a page action — call it as an MCP tool (or its GET endpoint), do not POST it to /api/action.`;
      return { ok: false, error: `Unknown action type: "${type}". ${hint}`, validTypes, hint, isReadTool: true };
    }
    const candidates = validTypes.concat(Object.keys(ACTION_ALIASES));
    let best = null, bestD = Infinity;
    const needle = String(type).toLowerCase();
    for (const c of candidates) {
      const d = _levenshtein(needle, c.toLowerCase());
      if (d < bestD) { bestD = d; best = c; }
    }
    const didYouMean = (best && bestD <= Math.max(2, Math.ceil(best.length / 3)))
      ? (ACTION_ALIASES[best] || best)
      : null;
    const error = `Unknown action type: "${type}".`
      + (didYouMean ? ` Did you mean "${didYouMean}"?` : '')
      + ` Valid action types: ${validTypes.join(', ')}.`;
    return { ok: false, error, validTypes, ...(didYouMean ? { didYouMean } : {}) };
  }

  // ── Message listener ─────────────────────────────────────────────────────────

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data?.__BROWSER_WHISKOR__) return;
    if (event.data.type !== 'EXECUTE_ACTION_IN_PAGE') return;

    const { payload: act, listenerId } = event.data;
    // Resolve MCP write-tool aliases (type_text → type, …) to the dispatched verb.
    const resolvedType = ACTION_ALIASES[act.type] || act.type;
    const handler = handlers[resolvedType];

    // Scope native dialogs to this action (direct causality) and honour a per-call
    // dialog policy override: act.dialog = { confirm: boolean, prompt: string|null }.
    const prevPolicy = { confirm: DIALOG_POLICY.confirm, prompt: DIALOG_POLICY.prompt };
    if (act.dialog && typeof act.dialog === 'object') {
      if ('confirm' in act.dialog) DIALOG_POLICY.confirm = act.dialog.confirm;
      if ('prompt' in act.dialog)  DIALOG_POLICY.prompt  = act.dialog.prompt;
    }
    const dialogStart = DIALOG_LOG.length;
    ACTION_CTX = { id: listenerId, label: resolvedType, startedAt: Date.now() };

    let result;
    if (!handler) {
      result = _unknownActionResult(act.type);
    } else {
      try {
        result = await handler(act);
        // Teach the canonical name back when an alias was used, so the agent converges.
        if (result && typeof result === 'object' && resolvedType !== act.type) {
          result._aliasedFrom = act.type;
          result._canonicalType = resolvedType;
        }
      } catch (e) {
        result = { ok: false, error: e.message };
      }
    }

    // Detach dialog scope and attach any dialogs that fired during this action so the
    // agent sees what its action triggered (auto-handled — no page block / timeout).
    const firedDialogs = DIALOG_LOG.slice(dialogStart);
    ACTION_CTX = null;
    _lastAction = { id: listenerId, label: act.type, endedAt: Date.now() };
    DIALOG_POLICY.confirm = prevPolicy.confirm;
    DIALOG_POLICY.prompt  = prevPolicy.prompt;
    if (result && typeof result === 'object' && firedDialogs.length) {
      result.dialogs = firedDialogs;
    }

    // Send result back to SW via bridge (ISOLATED world)
    // NOTE: bridge.js forwards event.data.payload through chrome.runtime.sendMessage,
    // so we must nest listenerId/ok/result/error inside payload.
    window.postMessage({
      __BROWSER_WHISKOR__: true,
      type: 'ACTION_COMPLETE',
      payload: {
        listenerId,
        ok: result.ok !== false,
        result: result.ok !== false ? result : undefined,
        error: result.ok === false ? result.error : undefined,
        ...(firedDialogs.length ? { dialogs: firedDialogs } : {}),
      },
    }, '*');
  });

})();
