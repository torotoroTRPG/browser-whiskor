/**
 * analyzers/accessibility.js  –  MAIN world
 * Builds the full ARIA accessibility tree with computed roles, names,
 * descriptions, states, and landmark regions.
 *
 * Emits: ACCESSIBILITY_TREE
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  // ── ARIA role inference ───────────────────────────────────────────────────

  const IMPLICIT_ROLES = {
    A:        (el) => el.href ? 'link' : 'generic',
    AREA:     () => 'link',
    ARTICLE:  () => 'article',
    ASIDE:    () => 'complementary',
    BUTTON:   () => 'button',
    DATALIST: () => 'listbox',
    DETAILS:  () => 'group',
    DIALOG:   () => 'dialog',
    FIELDSET: () => 'group',
    FIGURE:   () => 'figure',
    FOOTER:   () => 'contentinfo',
    FORM:     () => 'form',
    H1:       () => 'heading',
    H2:       () => 'heading',
    H3:       () => 'heading',
    H4:       () => 'heading',
    H5:       () => 'heading',
    H6:       () => 'heading',
    HEADER:   () => 'banner',
    HR:       () => 'separator',
    IMG:      (el) => el.alt === '' ? 'presentation' : 'img',
    INPUT:    (el) => {
      const t = (el.type || 'text').toLowerCase();
      const map = { button:'button', checkbox:'checkbox', color:'input',
        date:'input', email:'textbox', file:'input',
        hidden:'', image:'button', month:'input', number:'spinbutton',
        password:'textbox', radio:'radio', range:'slider', reset:'button',
        search:'searchbox', submit:'button', tel:'textbox', text:'textbox',
        time:'input', url:'textbox', week:'input' };
      return map[t] || 'textbox';
    },
    LI:       () => 'listitem',
    LINK:     () => 'link',
    MAIN:     () => 'main',
    MARK:     () => 'mark',
    MATH:     () => 'math',
    MENU:     () => 'list',
    METER:    () => 'meter',
    NAV:      () => 'navigation',
    OL:       () => 'list',
    OPTGROUP: () => 'group',
    OPTION:   () => 'option',
    OUTPUT:   () => 'status',
    P:        () => 'paragraph',
    PROGRESS: () => 'progressbar',
    SECTION:  () => 'region',
    SELECT:   (el) => el.multiple ? 'listbox' : 'combobox',
    SUMMARY:  () => 'button',
    TABLE:    () => 'table',
    TBODY:    () => 'rowgroup',
    TD:       () => 'cell',
    TEXTAREA: () => 'textbox',
    TFOOT:    () => 'rowgroup',
    TH:       () => 'columnheader',
    THEAD:    () => 'rowgroup',
    TR:       () => 'row',
    UL:       () => 'list',
  };

  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const implicit = IMPLICIT_ROLES[el.tagName];
    return implicit ? implicit(el) : 'generic';
  }

  // ── Accessible name computation (simplified AccName algorithm) ────────────

  function getAccessibleName(el) {
    // aria-labelledby → highest priority
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const names = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (names.length) return names.join(' ');
    }

    // aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    // <label for="...">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // placeholder (inputs)
    if (el.placeholder) return el.placeholder;

    // alt (images)
    if (el.tagName === 'IMG') return el.alt || '';

    // title attribute
    if (el.title) return el.title;

    // Text content for interactive elements
    const role = getRole(el);
    if (['button','link','tab','menuitem','option','checkbox','radio','heading'].includes(role)) {
      return el.textContent?.trim().slice(0, 100) || '';
    }

    return '';
  }

  function getDescription(el) {
    const describedBy = el.getAttribute('aria-describedby');
    if (describedBy) {
      const parts = describedBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    return el.title && el.title !== getAccessibleName(el) ? el.title : null;
  }

  // ── State collection ──────────────────────────────────────────────────────

  function getState(el) {
    const state = {};

    const boolAttrs = ['disabled', 'hidden', 'required', 'readonly'];
    for (const a of boolAttrs) {
      if (el[a] || el.getAttribute('aria-' + a) === 'true') state[a] = true;
    }

    // ARIA states
    const ariaStates = {
      expanded:  'aria-expanded',
      selected:  'aria-selected',
      checked:   'aria-checked',
      pressed:   'aria-pressed',
      current:   'aria-current',
      busy:      'aria-busy',
      live:      'aria-live',
      invalid:   'aria-invalid',
      level:     'aria-level',
      valuetext: 'aria-valuetext',
      valuenow:  'aria-valuenow',
      valuemin:  'aria-valuemin',
      valuemax:  'aria-valuemax',
    };

    for (const [key, attr] of Object.entries(ariaStates)) {
      const val = el.getAttribute(attr);
      if (val != null && val !== 'false') {
        state[key] = val === 'true' ? true : val;
      }
    }

    // Native checked/selected
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      state.checked = el.checked;
      if (el.indeterminate) state.checked = 'mixed';
    }
    if (el.tagName === 'OPTION') state.selected = el.selected;

    return Object.keys(state).length ? state : null;
  }

  // ── Landmark detection ────────────────────────────────────────────────────

  function getLandmark(el) {
    const role = getRole(el);
    const landmarks = ['banner','navigation','main','complementary','contentinfo',
                       'search','form','region','log','status','alert','alertdialog',
                       'dialog','feed','grid','gridcell','listbox','menu','menubar',
                       'option','progressbar','radiogroup','scrollbar','tablist',
                       'tabpanel','timer','toolbar','tree','treegrid'];
    return landmarks.includes(role) ? role : null;
  }

  // ── Tree builder ──────────────────────────────────────────────────────────

  const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','META','LINK','TITLE',
                              'HEAD','TEMPLATE','SLOT']);
  const SKIP_ROLES = new Set(['presentation','none']);

  function buildTree(el, depth = 0, maxDepth = 15) {
    if (!el || depth > maxDepth) return null;
    if (el.nodeType !== 1) return null;
    if (SKIP_TAGS.has(el.tagName)) return null;

    const role = getRole(el);
    if (SKIP_ROLES.has(role) && !el.hasAttribute('aria-label')) return null;

    // Skip invisible elements that have no aria role
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      if (!el.hasAttribute('role')) return null;
    }

    const name  = getAccessibleName(el);
    const desc  = getDescription(el);
    const state = getState(el);
    const landmark = getLandmark(el);

    // Bounding rect (for click targeting)
    let rect = null;
    try {
      const r = el.getBoundingClientRect();
      if (r.width || r.height) {
        rect = {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top  + window.scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }
    } catch (_) {}

    // Build node
    const node = {
      role,
      tag:  el.tagName.toLowerCase(),
      name: name || undefined,
    };

    if (desc)     node.description = desc;
    if (state)    node.state = state;
    if (landmark) node.landmark = landmark;
    if (rect)     node.rect = rect;
    if (el.id)    node.id = el.id;

    // Heading level
    const hMatch = el.tagName.match(/^H([1-6])$/);
    if (hMatch) node.level = parseInt(hMatch[1]);

    // Selector for targeting
    if (el.id) {
      node.selector = `#${el.id}`;
    } else if (el.tagName === 'INPUT' && el.name) {
      node.selector = `input[name="${el.name}"]`;
    }

    // Recurse children
    const children = [];
    for (const child of el.children) {
      const childNode = buildTree(child, depth + 1, maxDepth);
      if (childNode) children.push(childNode);
    }
    if (children.length) node.children = children;

    return node;
  }

  // ── Landmark summary ──────────────────────────────────────────────────────

  function collectLandmarks() {
    const landmarks = [];
    const query = [
      '[role="banner"]', '[role="navigation"]', '[role="main"]',
      '[role="complementary"]', '[role="contentinfo"]', '[role="search"]',
      '[role="form"]', '[role="region"]', '[role="dialog"]', '[role="alertdialog"]',
      'header', 'nav', 'main', 'aside', 'footer',
    ].join(',');

    try {
      document.querySelectorAll(query).forEach(el => {
        landmarks.push({
          role: getRole(el),
          name: getAccessibleName(el) || undefined,
          tag:  el.tagName.toLowerCase(),
          id:   el.id || undefined,
        });
      });
    } catch (_) {}

    return landmarks;
  }

  // ── Focus order (first 30 focusable elements) ─────────────────────────────

  function getFocusOrder() {
    const focusable = [];
    try {
      const q = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[role="menuitem"],[role="tab"]';
      document.querySelectorAll(q).forEach((el, i) => {
        if (i >= 30) return;
        focusable.push({
          role: getRole(el),
          name: getAccessibleName(el) || undefined,
          tag:  el.tagName.toLowerCase(),
          selector: el.id ? `#${el.id}` : undefined,
        });
      });
    } catch (_) {}
    return focusable;
  }

  // ── Plugin registration ───────────────────────────────────────────────────

  registry.register({
    id: 'accessibility', name: 'Accessibility Tree', version: '1.0.0',
    runAt: 'load', realtime: false, priority: 20,
    emitType: 'ACCESSIBILITY_TREE',

    install(api) {
      window.addEventListener('message', (e) => {
        if (!e.data?.__BROWSER_WHISKOR__) return;
        if (e.data.type === 'MANUAL_COLLECT') {
          const plugins = e.data.payload?.plugins;
          if (!plugins || plugins.includes('accessibility')) {
            const data = this.collect(api);
            if (data) api.emit(this.emitType, data, false);
          }
        }
      });
    },

    collect(api) {
      try {
        const tree = buildTree(document.body || document.documentElement, 0, 12);
        return {
          capturedAt:  Date.now(),
          pageUrl:     location.href,
          title:       document.title,
          lang:        document.documentElement.lang || undefined,
          tree,
          landmarks:   collectLandmarks(),
          focusOrder:  getFocusOrder(),
        };
      } catch (e) {
        return { capturedAt: Date.now(), error: e.message };
      }
    },
  });
})();
