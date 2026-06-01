/**
 * injected/executor.js  –  MAIN world
 * Handles EXECUTE_ACTION_IN_PAGE commands from the SW.
 * Performs DOM manipulations: click, type, scroll, hover, etc.
 */
'use strict';

(function () {
  if (window.__SI_EXECUTOR_INIT__) return;
  window.__SI_EXECUTOR_INIT__ = true;

  // ── Element finders ──────────────────────────────────────────────────────────

  function findBySelector(selector) {
    try { return document.querySelector(selector); }
    catch { return null; }
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

  function elementText(el) {
    return (el.textContent || el.value || el.placeholder ||
            el.getAttribute('aria-label') || refText(el, 'aria-labelledby') ||
            el.getAttribute('title') || el.getAttribute('alt') ||
            refText(el, 'aria-describedby') || '')
      .trim().toLowerCase();
  }

  function isElementVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  /**
   * Locate an element by its visible text.
   *
   * Two-pass strategy:
   *   Pass 1 — explicit interactive elements (links, buttons, form fields, ARIA
   *            widgets, [onclick], focusable nodes). These are the most likely
   *            click targets, so a strong match here wins immediately.
   *   Pass 2 — text-bearing leaf elements (div/span/li/headings with ≤2 element
   *            children). Covers the common SPA pattern of a <div>/<span> carrying
   *            a click handler, which Pass 1's selector list cannot express.
   *
   * Candidates are scored (exact > prefix > word-boundary > substring) and biased
   * toward concise, visible, leaf-like elements so the label itself is preferred
   * over a large wrapping container that merely contains the text.
   */
  function findByText(text) {
    const lower = (text || '').toLowerCase().trim();
    if (!lower) return null;
    let wordRe = null;
    try { wordRe = new RegExp('\\b' + escapeRegex(lower) + '\\b'); } catch (_) {}

    function score(el) {
      const t = elementText(el);
      if (!t) return 0;
      let s;
      if (t === lower)                 s = 1.0;
      else if (t.startsWith(lower))    s = 0.85;
      else if (wordRe && wordRe.test(t)) s = 0.7;
      else if (t.includes(lower))      s = 0.55;
      else return 0;
      // Prefer elements whose text is mostly the query (the label, not a wrapper).
      s += (lower.length / Math.max(t.length, 1)) * 0.2;
      if (isElementVisible(el)) s += 0.1;
      if (el.children.length === 0) s += 0.05;
      return s;
    }

    let best = null, bestScore = 0;

    // Pass 1: explicit interactive elements.
    const interactiveSel =
      'button, a, input, textarea, select, label, summary, ' +
      '[role=button], [role=link], [role=tab], [role=menuitem], [role=option], ' +
      '[role=checkbox], [role=radio], [role=switch], [onclick], ' +
      '[tabindex]:not([tabindex="-1"])';
    for (const el of document.querySelectorAll(interactiveSel)) {
      const sc = score(el);
      if (sc > bestScore) { bestScore = sc; best = el; }
    }
    if (best && bestScore >= 0.7) return best;

    // Pass 2: text-bearing leaf elements (covers clickable div/span/li/etc.).
    for (const el of document.querySelectorAll(
      'div, span, li, td, th, p, h1, h2, h3, h4, h5, h6, strong, b, em'
    )) {
      if (el.children.length > 2) continue; // skip large containers
      const sc = score(el);
      if (sc > bestScore) { bestScore = sc; best = el; }
    }

    return bestScore > 0 ? best : null;
  }

  function findByCoords(x, y) {
    return document.elementFromPoint(x - window.scrollX, y - window.scrollY);
  }

  function resolveTarget(action) {
    if (action.selector) return findBySelector(action.selector);
    if (action.text)     return findByText(action.text);
    if (action.x != null && action.y != null) return findByCoords(action.x, action.y);
    return null;
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
    if (/\bctrl\s*\+?\s*enter\b/.test(hint))       return { key: 'ctrl-enter', confidence: 'hint', evidence: 'hint text mentions Ctrl+Enter' };
    if (/\b(cmd|meta|⌘)\s*\+?\s*enter\b/.test(hint)) return { key: 'cmd-enter', confidence: 'hint', evidence: 'hint text mentions Cmd+Enter' };
    if (/\bshift\s*\+?\s*enter\b/.test(hint))       return { key: 'enter', confidence: 'hint', evidence: 'hint implies Shift+Enter=newline, Enter=send' };
    if (/(送信|to send|press enter|enterで送信)/.test(hint)) return { key: 'enter', confidence: 'hint', evidence: 'hint text mentions send/送信' };

    // 4. Unknown — be honest, do not guess.
    return { key: null, confidence: 'unknown', evidence: 'no enterkeyhint, native form, or hint text found' };
  }

  // Compact descriptor of where an action landed — lets the agent confirm it typed into
  // the intended element (e.g. when no selector was given and activeElement was used).
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

        // Framework re-renders の解決を待つ
        await new Promise(r => setTimeout(r, 100));
        const diagnosis = analyzer.diagnoseClickResult(el, fp);
        report.diagnosis = diagnosis;

        return {
          ok: true,
          tagName: el.tagName,
          text: el.textContent?.trim().slice(0, 50),
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

      return { ok: true, tagName: el.tagName, text: el.textContent?.trim().slice(0, 50) };
    },

    type(action) {
      let el = action.selector ? findBySelector(action.selector) : document.activeElement;
      if (!el || el === document.body) return { ok: false, error: 'No target element for type' };
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
        for (const char of text) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
          let inserted = false;
          try { inserted = document.execCommand('insertText', false, char); } catch (_) {}
          if (!inserted) {
            // Fallback for editors that ignore execCommand: emit beforeinput, then append.
            try {
              el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true, cancelable: true }));
              el.textContent = (el.textContent || '') + char;
            } catch (_) {}
          }
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        }
        if (effectiveSubmit !== 'none') pressEnterCombo(el, effectiveSubmit, false);
        return { ok: true, typedLength: text.length, submitted: effectiveSubmit !== 'none' ? effectiveSubmit : undefined,
                 ...(submitInference ? { submitInference } : {}), target: describeTarget(el), currentValue: el.textContent };
      }

      if (action.clear) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Type character by character for React synthetic event compatibility
      for (const char of text) {
        el.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
        const start = el.selectionStart ?? el.value.length;
        el.value = el.value.slice(0, start) + char + el.value.slice(el.selectionEnd ?? start);
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
                                       Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          try { nativeInputValueSetter.call(el, el.value); } catch (_) {}
        }
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      }

      if (effectiveSubmit !== 'none') pressEnterCombo(el, effectiveSubmit, true);

      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, typedLength: text.length, submitted: effectiveSubmit !== 'none' ? effectiveSubmit : undefined,
               ...(submitInference ? { submitInference } : {}), target: describeTarget(el), currentValue: el.value };
    },

    press_key(action) {
      const focused = document.activeElement || document.body || document.documentElement || document;
      const parts = action.key.split('+');
      const key   = parts.pop();
      const ctrl  = parts.includes('Control') || parts.includes('Ctrl');
      const meta  = parts.includes('Meta') || parts.includes('Command');
      const shift = parts.includes('Shift');
      const alt   = parts.includes('Alt');
      const opts  = { key, bubbles: true, cancelable: true, ctrlKey: ctrl, metaKey: meta, shiftKey: shift, altKey: alt };
      focused.dispatchEvent(new KeyboardEvent('keydown',  opts));
      focused.dispatchEvent(new KeyboardEvent('keypress', opts));
      focused.dispatchEvent(new KeyboardEvent('keyup',    opts));
      return { ok: true, key: action.key, target: focused.tagName };
    },

    hover(action) {
      const el = resolveTarget(action);
      if (!el) return { ok: false, error: 'Element not found for hover' };
      scrollIntoView(el);
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new MouseEvent('mouseover',  opts));
      el.dispatchEvent(new MouseEvent('mouseenter', opts));
      el.dispatchEvent(new MouseEvent('mousemove',  opts));
      return { ok: true, tagName: el.tagName };
    },

    mouse_scroll(action) {
      const x = action.x != null ? action.x - window.scrollX : (action.selector ? (() => { const el = findBySelector(action.selector); const r = el.getBoundingClientRect(); return r.left + r.width/2; })() : window.innerWidth / 2);
      const y = action.y != null ? action.y - window.scrollY : (action.selector ? (() => { const el = findBySelector(action.selector); const r = el.getBoundingClientRect(); return r.top + r.height/2; })() : window.innerHeight / 2);
      const deltaX = action.deltaX || 0;
      const deltaY = action.deltaY != null ? action.deltaY : (action.lines ? action.lines * 100 : 0);

      const el = document.elementFromPoint(x, y) || document.body;
      const evOpts = {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, deltaX, deltaY, deltaMode: 0,
      };

      el.dispatchEvent(new WheelEvent('wheel', evOpts));
      return { ok: true, at: { x: x + window.scrollX, y: y + window.scrollY }, delta: { deltaX, deltaY } };
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

        await new Promise(r => setTimeout(r, 100));
        const diagnosis = analyzer.diagnoseClickResult(el, fp);
        report.diagnosis = diagnosis;

        return {
          ok: true,
          tagName: el.tagName,
          text: el.textContent?.trim().slice(0, 50),
          clickability: analyzer.cleanReport(report),
          diagnosis
        };
      }

      // Fallback
      scrollIntoView(el);
      const evOpts = { bubbles: true, cancelable: true, view: window, button: 2 };
      el.dispatchEvent(new MouseEvent('contextmenu', evOpts));
      return { ok: true, tagName: el.tagName, text: el.textContent?.trim().slice(0, 50) };
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

    scroll(action) {
      if (action.toElement) {
        const el = findBySelector(action.toElement);
        if (el) { scrollIntoView(el); return { ok: true, scrolledTo: action.toElement }; }
        return { ok: false, error: `Scroll target not found: ${action.toElement}` };
      }

      const target = action.selector ? findBySelector(action.selector) : window;
      const behavior = action.behavior || 'instant';

      if (action.x != null || action.y != null) {
        (target === window ? window : target).scrollTo({ left: action.x, top: action.y, behavior });
      } else {
        const dx = action.deltaX || 0;
        const dy = action.deltaY || 0;
        if (target === window) {
          window.scrollBy({ left: dx, top: dy, behavior });
        } else {
          target.scrollLeft += dx;
          target.scrollTop  += dy;
        }
      }
      return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY };
    },

    select_option(action) {
      const el = findBySelector(action.selector);
      if (!el || el.tagName !== 'SELECT') return { ok: false, error: `SELECT not found: ${action.selector}` };

      if (action.value) {
        el.value = action.value;
      } else if (action.label) {
        const lower = action.label.toLowerCase();
        const opt = [...el.options].find(o => o.text.toLowerCase().includes(lower) || o.value.toLowerCase().includes(lower));
        if (!opt) return { ok: false, error: `Option not found: ${action.label}` };
        el.value = opt.value;
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
      const el = findBySelector(action.selector);
      if (!el) return { ok: false, error: `Element not found: ${action.selector}` };
      scrollIntoView(el);
      el.focus();
      return { ok: true, focused: document.activeElement === el };
    },

    clear_input(action) {
      const el = findBySelector(action.selector);
      if (!el) return { ok: false, error: `Element not found: ${action.selector}` };
      el.value = '';
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
  };

  // ── Message listener ─────────────────────────────────────────────────────────

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data?.__BROWSER_WHISKOR__) return;
    if (event.data.type !== 'EXECUTE_ACTION_IN_PAGE') return;

    const { payload: act, listenerId } = event.data;
    const handler = handlers[act.type];

    let result;
    if (!handler) {
      result = { ok: false, error: `Unknown action type: ${act.type}` };
    } else {
      try {
        result = await handler(act);
      } catch (e) {
        result = { ok: false, error: e.message };
      }
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
      },
    }, '*');
  });

})();
