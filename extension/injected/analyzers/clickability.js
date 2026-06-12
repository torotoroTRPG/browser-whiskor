/**
 * analyzers/clickability.js  –  MAIN world
 *
 * Clickability Analyzer — Intelligence Layer, Subsystem 5
 *
 * Determines *why* an element can or cannot be clicked, produces a structured
 * ClickabilityReport, selects the optimal click strategy, and diagnoses what
 * actually happened after the click.
 *
 * Core axiom: the agent receives conclusions, not raw data.
 *
 * Exports (attached to window.__SI_CLICKABILITY__):
 *   analyzeClickability(el)
 *   autoUnblockPipeline(report)
 *   diagnoseClickResult(target, preClickFingerprint)
 *   capturePreClickFingerprint(el)
 */
'use strict';

(function () {
  if (window.__SI_CLICKABILITY__) return;

  // ── Utility: compute a reasonably unique CSS selector for an element ──────

  function computeSelector(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return el?.tagName?.toLowerCase() || 'unknown';
    }
    // Prefer id
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let current = el;
    let depth = 0;
    while (current && current !== document.body && current !== document.documentElement && depth < 5) {
      let segment = current.tagName.toLowerCase();

      // Add distinguishing class if available (first non-generated class)
      const classes = [...(current.classList || [])].filter(
        c => !/^[a-z]{1,3}-[a-zA-Z0-9]{4,8}$/.test(c) && !/^\d/.test(c)
      );
      if (classes.length) {
        segment += '.' + CSS.escape(classes[0]);
      }

      // Add nth-child if siblings share the same tag
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(s => s.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          segment += `:nth-child(${idx})`;
        }
      }

      parts.unshift(segment);
      current = parent;
      depth++;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  // ── Utility: get rect as plain object ─────────────────────────────────────

  function getRect(el) {
    try {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    } catch (_) {
      return null;
    }
  }

  // ── Modal pattern selectors ───────────────────────────────────────────────

  const MODAL_ROLE_SELECTORS = '[role="dialog"], [role="alertdialog"]';
  const MODAL_CLASS_PATTERNS = [
    '.MuiDialog-root', '.MuiBackdrop-root', '.MuiPopover-root',
    '.modal', '.overlay', '.backdrop',
    '[data-modal]', '[aria-modal="true"]',
  ];

  const CLOSE_BUTTON_SELECTORS = [
    '[aria-label*="close" i]', '[aria-label*="閉じる"]',
    '[data-dismiss]',
    'button.close', '.modal-close', '.dialog-close',
    '.MuiDialogTitle button',
  ];

  const BACKDROP_SELECTORS = [
    '.MuiBackdrop-root', '[data-overlay]',
    '.modal-backdrop', '.backdrop', '.overlay',
  ];

  // ── Check 1: Existence ────────────────────────────────────────────────────

  function checkExistence(el) {
    return el !== null && el !== undefined && document.contains(el);
  }

  // ── Check 2: Visibility (ancestor walk, max 32 levels) ────────────────────

  function checkVisibility(el) {
    let current = el;
    let depth = 0;

    while (current && current !== document.documentElement && depth < 32) {
      const cs = window.getComputedStyle(current);

      if (cs.display === 'none') {
        return { visible: false, hiddenBy: { selector: computeSelector(current), property: 'display', value: 'none' } };
      }
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
        return { visible: false, hiddenBy: { selector: computeSelector(current), property: 'visibility', value: cs.visibility } };
      }
      if (parseFloat(cs.opacity) === 0) {
        // opacity:0 might be intentional (animation intermediate state), but we report it
        return { visible: false, hiddenBy: { selector: computeSelector(current), property: 'opacity', value: cs.opacity } };
      }

      current = current.parentElement;
      depth++;
    }

    return { visible: true, hiddenBy: null };
  }

  // ── Check 3: Viewport presence ────────────────────────────────────────────

  function checkViewport(el) {
    const r = el.getBoundingClientRect();
    const rect = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };

    const inViewport =
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < window.innerHeight &&
      r.left < window.innerWidth;

    return { inViewport, rect };
  }

  // ── Check 4: Pointer events (ancestor walk, max 32 levels) ────────────────

  function checkPointerEvents(el) {
    let current = el;
    let depth = 0;

    while (current && current !== document.documentElement && depth < 32) {
      const cs = window.getComputedStyle(current);
      if (cs.pointerEvents === 'none') {
        return {
          pointerEventsEnabled: false,
          pointerEventsBlockedBy: { selector: computeSelector(current) },
        };
      }
      current = current.parentElement;
      depth++;
    }

    return { pointerEventsEnabled: true, pointerEventsBlockedBy: null };
  }

  // ── Check 5: Disabled state ───────────────────────────────────────────────

  function checkDisabled(el) {
    return (
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.hasAttribute('disabled')
    );
  }

  // ── Check 6: Obstruction (hit-test + modal classification) ────────────────

  function classifyObstructor(topEl) {
    // Walk ancestors to find if this is part of a modal/dialog/overlay
    let current = topEl;
    let modalAncestor = null;
    let modalType = null;
    let depth = 0;

    while (current && current !== document.body && depth < 20) {
      const role = current.getAttribute('role');
      if (role === 'dialog') { modalAncestor = current; modalType = 'dialog'; break; }
      if (role === 'alertdialog') { modalAncestor = current; modalType = 'alertdialog'; break; }
      if (current.getAttribute('aria-modal') === 'true') { modalAncestor = current; modalType = 'dialog'; break; }
      if (current.hasAttribute('data-modal')) { modalAncestor = current; modalType = 'custom'; break; }

      // MUI patterns
      if (current.classList.contains('MuiDialog-root')) { modalAncestor = current; modalType = 'dialog'; break; }
      if (current.classList.contains('MuiPopover-root')) { modalAncestor = current; modalType = 'popover'; break; }

      // Generic patterns
      if (current.classList.contains('modal') || current.classList.contains('overlay') || current.classList.contains('backdrop')) {
        modalAncestor = current; modalType = 'custom'; break;
      }

      current = current.parentElement;
      depth++;
    }

    // Also check if topEl itself is a backdrop
    const isBackdrop = topEl.classList.contains('MuiBackdrop-root') ||
      topEl.classList.contains('modal-backdrop') ||
      topEl.classList.contains('backdrop') ||
      topEl.classList.contains('overlay') ||
      topEl.hasAttribute('data-overlay');

    if (isBackdrop && !modalAncestor) {
      modalAncestor = topEl;
      modalType = 'custom';
    }

    const isModal = modalAncestor !== null;
    const searchRoot = modalAncestor || topEl;

    // Close button detection — search within the modal/obstructor
    let closeButtonSelector = null;
    let hasCloseButton = false;
    let closeButtonIntentScore = null;

    // Step 1: CSSセレクタによる探索
    for (const sel of CLOSE_BUTTON_SELECTORS) {
      try {
        const btn = searchRoot.querySelector(sel);
        if (btn) {
          closeButtonSelector = computeSelector(btn);
          hasCloseButton = true;
          break;
        }
      } catch (_) { /* selector parse errors */ }
    }

    // Step 1b: 意図分類によるフォールバック（CSSセレクタが失敗したときのみ）
    if (!hasCloseButton) {
      const autoUnblockIntentThreshold = 0.60;
      const candidates = searchRoot.querySelectorAll('button, [role="button"], a');
      for (const btn of candidates) {
        const labelText = (
          btn.textContent?.trim() ||
          btn.getAttribute('aria-label') ||
          btn.getAttribute('title') ||
          ''
        ).slice(0, 40);

        if (!labelText) continue;

        const result = window.__SI_CLASSIFY_INTENT__?.(labelText, autoUnblockIntentThreshold);
        if (result && (result.intent === 'DISMISS' || result.intent === 'CANCEL')) {
          closeButtonSelector = computeSelector(btn);
          hasCloseButton = true;
          closeButtonIntentScore = result.confidence;
          break;
        }
      }
    }

    // Fallback: last button containing only an SVG (icon-only close button pattern)
    if (!hasCloseButton) {
      try {
        const iconBtns = searchRoot.querySelectorAll('button:has(svg)');
        if (iconBtns.length > 0) {
          const candidate = iconBtns[iconBtns.length - 1];
          // Heuristic: icon buttons with small dimensions are likely close buttons
          const r = candidate.getBoundingClientRect();
          if (r.width <= 60 && r.height <= 60) {
            closeButtonSelector = computeSelector(candidate);
            hasCloseButton = true;
          }
        }
      } catch (_) { /* :has() not supported in all contexts */ }
    }

    // Escape-dismissible heuristic: MUI and Radix dialogs are escape-dismissible by default.
    // Also any element with role="dialog" generally supports Escape.
    const escapeDismissible = isModal && (
      modalType === 'dialog' ||
      modalType === 'alertdialog' ||
      (modalAncestor && (
        modalAncestor.classList.contains('MuiDialog-root') ||
        modalAncestor.classList.contains('MuiPopover-root') ||
        modalAncestor.hasAttribute('data-radix-dialog-content')
      ))
    );

    return {
      topElement: computeSelector(topEl),
      tag: topEl.tagName.toLowerCase(),
      text: (topEl.textContent || '').trim().slice(0, 120),
      rect: getRect(topEl),
      isModal,
      modalType,
      hasCloseButton,
      closeButtonSelector,
      closeButtonIntentScore,
      escapeDismissible: !!escapeDismissible,
    };
  }

  function checkObstruction(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      return { obstructed: false, obstructedBy: null };
    }

    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const topEl = document.elementFromPoint(cx, cy);

    if (!topEl) {
      // elementFromPoint returned null (element completely outside viewport)
      return { obstructed: false, obstructedBy: null };
    }

    // Not obstructed if topEl IS the target or is a descendant of the target
    if (topEl === el || el.contains(topEl)) {
      return { obstructed: false, obstructedBy: null };
    }

    // Not obstructed if the target contains the topEl's ancestor chain
    // (handles cases where the target is a parent of the hit element)
    if (topEl.contains(el)) {
      return { obstructed: false, obstructedBy: null };
    }

    return {
      obstructed: true,
      obstructedBy: classifyObstructor(topEl),
    };
  }

  // ── Strategy selection ────────────────────────────────────────────────────

  function selectStrategy(report) {
    if (!report.exists) return 'none';
    if (report.disabled) return 'none';

    if (report.obstructed) {
      // If it's a modal we can potentially auto-fix
      if (report.obstructedBy?.isModal) return 'native'; // will attempt unblock first
      return 'none'; // non-modal obstruction — report only
    }

    if (!report.pointerEventsEnabled) {
      // Check if target is in Shadow DOM
      try {
        if (report._el && report._el.getRootNode() instanceof ShadowRoot) {
          return 'direct';
        }
      } catch (_) {}
      return 'direct';
    }

    // Shadow DOM check for normal case
    try {
      if (report._el && report._el.getRootNode() instanceof ShadowRoot) {
        return 'direct';
      }
    } catch (_) {}

    return 'native';
  }

  // ── Main analysis function ────────────────────────────────────────────────

  function analyzeClickability(el) {
    // Base report shape — every field present, defaults for non-existence
    const report = {
      exists: false,
      visible: false,
      hiddenBy: null,
      inViewport: false,
      rect: null,
      pointerEventsEnabled: true,
      pointerEventsBlockedBy: null,
      disabled: false,
      obstructed: false,
      obstructedBy: null,
      canAutoFix: false,
      fixAttempted: false,
      fixStepsAttempted: 0,
      fixResult: null,
      recommendedStrategy: 'none',
      strategyUsed: null,
      diagnosis: null,
      relatedInputs: [],
      relatedInputsTip: null,
    };

    // ── Check 1: Existence ──
    if (!checkExistence(el)) {
      report.recommendedStrategy = 'none';
      return report;
    }
    report.exists = true;

    // Keep a reference for Shadow DOM detection (stripped before returning)
    report._el = el;

    // ── Check 2: Visibility ──
    const vis = checkVisibility(el);
    report.visible = vis.visible;
    report.hiddenBy = vis.hiddenBy;
    if (!vis.visible) {
      report.recommendedStrategy = 'none';
      return report;
    }

    // ── Check 3: Viewport ──
    const vp = checkViewport(el);
    report.inViewport = vp.inViewport;
    report.rect = vp.rect;
    // We don't abort here — executor will scrollIntoView

    // ── Check 4: Pointer events ──
    const pe = checkPointerEvents(el);
    report.pointerEventsEnabled = pe.pointerEventsEnabled;
    report.pointerEventsBlockedBy = pe.pointerEventsBlockedBy;

    // ── Check 5: Disabled ──
    report.disabled = checkDisabled(el);

    // ── Check 6: Obstruction ──
    const obs = checkObstruction(el);
    report.obstructed = obs.obstructed;
    report.obstructedBy = obs.obstructedBy;

    // Determine if auto-fix is possible
    if (report.obstructed && report.obstructedBy?.isModal) {
      report.canAutoFix = true;
    }

    // ── Strategy selection ──
    report.recommendedStrategy = selectStrategy(report);

    // ── Related inputs (action that depends on a field being filled first) ──
    const _rel = findRelatedInputs(el);
    if (_rel.length) { report.relatedInputs = _rel; report.relatedInputsTip = relatedInputTip(_rel); }

    return report;
  }

  // ── Auto-unblock pipeline ─────────────────────────────────────────────────
  //
  // Each step: attempt action → wait 300ms with MutationObserver → check if
  // obstructor is gone. Returns the updated report.

  function waitForObstructorRemoval(obstructorSelector, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();

      // Check immediately
      const check = () => {
        try {
          const el = document.querySelector(obstructorSelector);
          if (!el || !document.contains(el)) return true;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return true;
        } catch (_) {
          return true; // element no longer queryable = removed
        }
        return false;
      };

      if (check()) { resolve(true); return; }

      // Set up MutationObserver
      let observer = null;
      const timer = setTimeout(() => {
        if (observer) observer.disconnect();
        resolve(check()); // one final check at timeout
      }, timeoutMs);

      try {
        observer = new MutationObserver(() => {
          if (check()) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(true);
          }
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['style', 'class', 'hidden'],
        });
      } catch (_) {
        // MutationObserver failed, fall through to timeout
      }
    });
  }

  // A fix step only really succeeded if the TARGET is now clear — the tracked
  // obstructor disappearing does not guarantee that (e.g. a popover's paper is
  // removed but its backdrop stays and keeps swallowing clicks). Re-run the
  // obstruction check on the element itself; if something still covers it,
  // point the report at the current obstructor so later steps / the agent see
  // what is actually in the way instead of a false fixResult:"success".
  function verifyTargetClear(report) {
    const el = report._el;
    if (!el || !document.contains(el)) return true; // no live reference — legacy behaviour
    const obs = checkObstruction(el);
    if (!obs.obstructed) return true;
    report.obstructedBy = obs.obstructedBy;
    return false;
  }

  async function autoUnblockPipeline(report) {
    if (!report.obstructed || !report.canAutoFix || !report.obstructedBy) {
      report.fixResult = 'not_attempted';
      return report;
    }

    report.fixAttempted = true;
    const obs = report.obstructedBy;
    const STEP_TIMEOUT = 300;

    // ── Step 1: Click close button ──
    if (obs.hasCloseButton && obs.closeButtonSelector) {
      report.fixStepsAttempted = 1;
      try {
        const closeBtn = document.querySelector(obs.closeButtonSelector);
        if (closeBtn) {
          closeBtn.click();
          const removed = await waitForObstructorRemoval(obs.topElement, STEP_TIMEOUT);
          if (removed && verifyTargetClear(report)) {
            report.fixResult = 'success';
            report.obstructed = false;
            return report;
          }
        }
      } catch (_) {}
    }

    // ── Step 2: Dispatch Escape key ──
    if (obs.escapeDismissible) {
      report.fixStepsAttempted = 2;
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27,
          bubbles: true, cancelable: true,
        }));
        document.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'Escape', code: 'Escape', keyCode: 27,
          bubbles: true, cancelable: true,
        }));
        const removed = await waitForObstructorRemoval(obs.topElement, STEP_TIMEOUT);
        if (removed && verifyTargetClear(report)) {
          report.fixResult = 'success';
          report.obstructed = false;
          return report;
        }
      } catch (_) {}
    }

    // ── Step 3: Click backdrop ──
    report.fixStepsAttempted = 3;
    for (const sel of BACKDROP_SELECTORS) {
      try {
        const backdrop = document.querySelector(sel);
        if (backdrop && document.contains(backdrop)) {
          backdrop.click();
          const removed = await waitForObstructorRemoval(obs.topElement, STEP_TIMEOUT);
          if (removed && verifyTargetClear(report)) {
            report.fixResult = 'success';
            report.obstructed = false;
            return report;
          }
        }
      } catch (_) {}
    }

    // Also try computed backdrop: sibling of the modal ancestor
    try {
      const modalEl = document.querySelector(obs.topElement);
      if (modalEl?.parentElement) {
        const siblings = [...modalEl.parentElement.children];
        for (const sib of siblings) {
          if (sib === modalEl) continue;
          const cs = window.getComputedStyle(sib);
          // Heuristic: a sibling that covers the whole viewport is likely a backdrop
          const r = sib.getBoundingClientRect();
          if (r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9) {
            sib.click();
            const removed = await waitForObstructorRemoval(obs.topElement, STEP_TIMEOUT);
            if (removed && verifyTargetClear(report)) {
              report.fixResult = 'success';
              report.obstructed = false;
              return report;
            }
          }
        }
      }
    } catch (_) {}

    // ── Step 4: All failed ──
    report.fixStepsAttempted = Math.max(report.fixStepsAttempted, 3);
    report.canAutoFix = false;
    report.fixResult = 'all_steps_failed';
    return report;
  }

  // ── Pre-click fingerprint ─────────────────────────────────────────────────

  function capturePreClickFingerprint(el) {
    const rect = el ? getRect(el) : null;
    const dialogCount = document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;

    return {
      url: location.href,
      title: document.title,
      dialogCount,
      targetRect: rect,
      timestamp: Date.now(),
    };
  }

  // ── Post-click diagnosis ──────────────────────────────────────────────────

  function diagnoseClickResult(target, preClickFingerprint) {
    const diagnosis = {
      clickLanded: false,
      whatReceivedClick: { selector: 'unknown', isTarget: false },
      stateChanged: false,
      popupAppeared: false,
      popupInfo: null,
      unexpectedBehavior: null,
    };

    if (!target || !preClickFingerprint) return diagnosis;

    // If the target is gone from the DOM (or collapsed to a zero-size box) after the
    // click, that is almost always the click *working*: a React/SPA re-render replaced
    // or removed the element. Without this guard getBoundingClientRect() collapses to
    // (0,0) and elementFromPoint() hits whatever sits at the top-left (often the header),
    // producing a bogus 'click_intercepted'.
    try {
      const rect = target.getBoundingClientRect();
      const detached = !document.contains(target);
      const collapsed = rect.width === 0 && rect.height === 0;

      if (detached || collapsed) {
        diagnosis.clickLanded = true;
        diagnosis.targetRemoved = true;
        diagnosis.stateChanged = true;
        diagnosis.whatReceivedClick = { selector: detached ? '(removed)' : '(collapsed)', isTarget: true };
      } else {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const currentTop = document.elementFromPoint(cx, cy);

        if (currentTop) {
          const isTarget = currentTop === target || target.contains(currentTop);
          diagnosis.clickLanded = isTarget;
          diagnosis.whatReceivedClick = {
            selector: computeSelector(currentTop),
            isTarget,
          };

          if (!isTarget) {
            diagnosis.unexpectedBehavior = 'click_intercepted';
          }
        }
      }
    } catch (_) {
      // Target was removed from the DOM — treat as a landed click, not interception.
      diagnosis.clickLanded = true;
      diagnosis.targetRemoved = true;
      diagnosis.stateChanged = true;
    }

    // Check for new dialogs
    const currentDialogCount = document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;
    if (currentDialogCount > preClickFingerprint.dialogCount) {
      diagnosis.popupAppeared = true;
      diagnosis.unexpectedBehavior = 'modal_appeared';

      // Find the new dialog and classify it
      try {
        const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
        const newDialog = dialogs[dialogs.length - 1];
        if (newDialog) {
          diagnosis.popupInfo = classifyObstructor(newDialog);
        }
      } catch (_) {}
    }

    // Check for navigation
    if (location.href !== preClickFingerprint.url) {
      diagnosis.stateChanged = true;
      // Only flag as unexpected if the click wasn't on a link
      try {
        if (target.tagName !== 'A' && !target.closest('a')) {
          diagnosis.unexpectedBehavior = 'navigation_triggered';
        }
      } catch (_) {}
    }

    // Check for title change (simple state-change heuristic)
    if (document.title !== preClickFingerprint.title) {
      diagnosis.stateChanged = true;
    }

    // If nothing changed at all and click landed correctly, flag it
    if (diagnosis.clickLanded && !diagnosis.stateChanged && !diagnosis.popupAppeared &&
        location.href === preClickFingerprint.url && document.title === preClickFingerprint.title) {
      // Check for any DOM changes that might indicate state change
      // This is a best-effort heuristic — we can't track all mutations without MutationObserver
      // For now, if the click landed but nothing visibly changed, report it
      diagnosis.unexpectedBehavior = 'no_state_change';
    }

    // A click that demonstrably changed page state was not "intercepted" — clear the
    // false positive that arises when a re-render moves/removes the original target.
    if (diagnosis.unexpectedBehavior === 'click_intercepted' && diagnosis.stateChanged) {
      diagnosis.unexpectedBehavior = null;
    }

    return diagnosis;
  }

  // ── Clean report (strip internal references) ──────────────────────────────

  function cleanReport(report) {
    const clean = { ...report };
    delete clean._el;
    return clean;
  }

  // ── Related-input detection ───────────────────────────────────────────────
  // An action button often fails (validation alert, silent no-op) unless a related
  // input is filled first — e.g. a "join room" button next to a room-code field.
  // Surface those inputs so the agent fills them before clicking. Association is
  // layered, and `confidence` is NOT a fabricated number (a score that isn't itself
  // trustworthy is worse than none) — it is a direct, inspectable function of WHICH
  // evidence matched, and `basis` is exposed so it can be judged:
  //   1. shared <form>                         → basis 'form'      (confidence high)
  //   2. ARIA aria-controls / aria-describedby → basis 'aria'      (confidence high)
  //   3. bounded nearest common container      → basis 'container' (confidence low)
  //      (the "same parent box", depth/size-capped so we don't grab the whole page)
  const INPUT_SEL = 'input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"]';
  const _CONF = { form: 'high', aria: 'high', container: 'low' };

  function _isValueInput(n) {
    const tag = (n.tagName || '').toLowerCase();
    if (tag === 'input') {
      const t = (n.getAttribute('type') || 'text').toLowerCase();
      return !['button', 'submit', 'reset', 'image', 'hidden', 'checkbox', 'radio', 'file'].includes(t);
    }
    return tag === 'textarea' || tag === 'select' || n.isContentEditable ||
           (n.getAttribute && n.getAttribute('role') === 'textbox');
  }

  function _inputState(n, basis) {
    const val = n.isContentEditable ? (n.textContent || '').trim()
              : (n.value != null ? String(n.value).trim() : '');
    const label = (n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('placeholder'))) ||
                  n.name || n.id || (n.getAttribute && n.getAttribute('data-placeholder')) || null;
    return {
      selector: computeSelector(n),
      label: label ? String(label).slice(0, 60) : null,
      required: !!(n.required || (n.getAttribute && n.getAttribute('aria-required') === 'true')) || null,
      empty: val === '',
      basis,
      confidence: _CONF[basis] || 'low',
    };
  }

  function findRelatedInputs(el) {
    if (!el || _isValueInput(el)) return []; // inputs themselves have no "related inputs"
    const seen = new Set();
    const out = [];
    const add = (n, basis) => {
      if (!n || !_isValueInput(n)) return;
      const st = _inputState(n, basis);
      if (seen.has(st.selector)) return;
      seen.add(st.selector);
      out.push(st);
    };

    let form = null;
    try { form = el.form || (el.closest && el.closest('form')); } catch (_) {}
    if (form) { for (const n of form.querySelectorAll(INPUT_SEL)) add(n, 'form'); }

    for (const attr of ['aria-controls', 'aria-describedby']) {
      const ids = ((el.getAttribute && el.getAttribute(attr)) || '').split(/\s+/).filter(Boolean);
      for (const id of ids) { const ref = document.getElementById(id); if (ref) add(ref, 'aria'); }
    }

    if (!out.length) {
      const MAX_LEVELS = 4, MAX_INPUTS = 4, MAX_ELEMENTS = 60;
      let cur = el.parentElement, level = 0;
      while (cur && level++ < MAX_LEVELS) {
        const ins = cur.querySelectorAll(INPUT_SEL);
        if (ins.length) {
          if (ins.length <= MAX_INPUTS && cur.querySelectorAll('*').length <= MAX_ELEMENTS) {
            for (const n of ins) add(n, 'container');
          }
          break; // stop at the first ancestor holding inputs — don't widen further
        }
        cur = cur.parentElement;
      }
    }
    return out.slice(0, 6);
  }

  function relatedInputTip(rels) {
    if (!rels || !rels.length) return null;
    const blockers = rels.filter(r => r.empty || r.required);
    const target = blockers.length ? blockers : rels;
    const allLow = target.every(r => r.confidence === 'low');
    const names = target.slice(0, 3).map(r =>
      r.selector + (r.empty ? ' (empty)' : '') + (r.required && !r.empty ? ' (required)' : ''));
    const plural = target.length > 1;
    const hedge = allLow ? ' [low confidence: inferred only from the same container — verify]' : '';
    return `This action ${allLow ? 'may depend on' : 'likely depends on'} input${plural ? 's' : ''} ` +
           names.join(', ') + (target.length > 3 ? `, +${target.length - 3} more` : '') +
           `. Fill ${plural ? 'them' : 'it'} before clicking, or it may trigger a validation alert / no-op.${hedge}`;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.__SI_CLICKABILITY__ = {
    analyzeClickability,
    autoUnblockPipeline,
    diagnoseClickResult,
    capturePreClickFingerprint,
    findRelatedInputs,
    relatedInputTip,
    cleanReport,
    // Exposed for testing and dry-run tool
    _internal: {
      computeSelector,
      checkExistence,
      checkVisibility,
      checkViewport,
      checkPointerEvents,
      checkDisabled,
      checkObstruction,
      classifyObstructor,
      selectStrategy,
    },
  };
})();
