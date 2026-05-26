/**
 * adapters/dom-generic.js  –  MAIN world
 * Framework-agnostic fallback. Always runs, always useful.
 * Produces: ARIA tree, global state scan, custom elements, meta tags.
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  const IMPLICIT_ROLES = {
    BUTTON:'button', A:'link', INPUT:'textbox', SELECT:'listbox',
    TEXTAREA:'textbox', NAV:'navigation', MAIN:'main', HEADER:'banner',
    FOOTER:'contentinfo', SECTION:'region', ASIDE:'complementary',
    ARTICLE:'article', FORM:'form', TABLE:'table', OL:'list', UL:'list',
    LI:'listitem', H1:'heading', H2:'heading', H3:'heading',
    H4:'heading', H5:'heading', H6:'heading',
  };

  const INTERESTING_GLOBALS = [
    '__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__PRELOADED_STATE__',
    '__APP_STATE__', '__STORE__', '__STATE__', 'APP_DATA', 'CONFIG',
    '__webpack_require__', '__vite_plugin_react_preamble_installed__',
    'dataLayer', '__REDUX_DEVTOOLS_EXTENSION__',
  ];

  registry.register({
    id: 'dom-generic', name: 'Generic DOM Analyzer', version: '1.0.0',
    runAt: 'load', realtime: false, priority: 99,
    emitType: 'DOM_GENERIC_SNAPSHOT', cacheTarget: 'dom/',

    detect() { return true; },
    install(api) {},

    collect(api) {
      return {
        capturedAt: Date.now(), framework: 'generic',
        ariaTree:      this._buildAriaTree(document.body, 0),
        globals:       this._scanGlobals(),
        customElements:this._findCustomElements(),
        metaTags:      this._getMeta(),
        docTitle:      document.title,
        lang:          document.documentElement.lang || null,
        baseURI:       document.baseURI,
      };
    },

    _buildAriaTree(el, depth) {
      if (!el || depth > 15) return null;
      const role = el.getAttribute('role') || IMPLICIT_ROLES[el.tagName] || null;
      if (!role && el.children.length === 0 && !el.getAttribute('aria-label')) return null;
      const node = {
        tag:   el.tagName.toLowerCase(),
        role,
        label: el.getAttribute('aria-label') || el.getAttribute('title') || null,
        id:    el.id || null,
        children: [],
      };
      for (const child of el.children) {
        const c = this._buildAriaTree(child, depth + 1);
        if (c) node.children.push(c);
      }
      return node;
    },

    _scanGlobals() {
      const result = {};
      for (const key of INTERESTING_GLOBALS) {
        try {
          if (!(key in window) || window[key] === undefined) continue;
          const v = window[key];
          result[key] = typeof v === 'object' && v !== null
            ? JSON.parse(JSON.stringify(v).slice(0, 500))
            : String(v).slice(0, 200);
        } catch (_) {}
      }
      return result;
    },

    _findCustomElements() {
      return [...new Set(
        [...document.querySelectorAll('*')]
          .map(el => el.tagName.toLowerCase())
          .filter(t => t.includes('-'))
      )].slice(0, 50);
    },

    _getMeta() {
      return [...document.querySelectorAll('meta[name],meta[property]')]
        .map(m => ({
          key:   m.getAttribute('name') || m.getAttribute('property'),
          value: m.getAttribute('content'),
        })).slice(0, 30);
    },
  });
})();
