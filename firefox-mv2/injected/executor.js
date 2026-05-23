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

  function findByText(text, tags = ['button', 'a', 'input', 'label', '[role=button]', '[role=link]']) {
    const lower = text.toLowerCase();
    // Try each tag group, prefer exact match, then partial
    const selector = tags.join(',');
    const candidates = [...document.querySelectorAll(selector)];
    const exact = candidates.find(el => {
      const t = (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().toLowerCase();
      return t === lower;
    });
    if (exact) return exact;
    return candidates.find(el => {
      const t = (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().toLowerCase();
      return t.includes(lower);
    }) || null;
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
          // TODO: [リトルエージェント用] ここにReact Fiber/Vueインスタンスからの直接の関数呼び出しロジックを実装してください
          // 現在はフォールバックとして direct click を使用します
          try { el.click(); } catch (e) { return { ok: false, error: e.message, clickability: analyzer.cleanReport(report) }; }
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

      if (action.clear) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Type character by character for React synthetic event compatibility
      for (const char of action.text) {
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

      if (action.pressEnter) {
        el.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Enter', code: 'Enter', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup',    { key: 'Enter', code: 'Enter', bubbles: true }));
        el.dispatchEvent(new Event('submit', { bubbles: true }));
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, typedLength: action.text.length, currentValue: el.value };
    },

    press_key(action) {
      const focused = document.activeElement || document.body;
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

    // Send result back to SW via bridge
    chrome.runtime.sendMessage({
      type: 'ACTION_COMPLETE',
      listenerId,
      ok: result.ok !== false,
      result: result.ok !== false ? result : undefined,
      error: result.ok === false ? result.error : undefined,
    }).catch(() => {});
  });

})();
