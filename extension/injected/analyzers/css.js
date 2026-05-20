/**
 * analyzers/css.js  –  MAIN world
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  registry.register({
    id: 'css-analysis', name: 'CSS Analyzer', version: '1.0.0',
    runAt: 'load', realtime: false, priority: 20,
    emitType: 'CSS_ANALYSIS', cacheTarget: 'css/',

    install(api) {},

    collect(api) {
      const customProps = {};
      const colors = new Set(), spacing = new Set(), radii = new Set(),
            fonts  = new Set(), shadows = new Set();
      const bySheet = [];
      const fwSignals = {};

      for (const sheet of document.styleSheets) {
        const entry = { href: sheet.href || 'inline', rules: 0, blocked: false };
        try {
          const rules = sheet.cssRules || [];
          entry.rules = rules.length;
          for (const rule of rules) {
            if (rule.type === CSSRule.STYLE_RULE) {
              const style = rule.style;
              for (let i = 0; i < style.length; i++) {
                const prop = style[i];
                const val  = style.getPropertyValue(prop).trim();
                if (prop.startsWith('--')) customProps[prop] = val;
              }
            }
          }
        } catch (_) { entry.blocked = true; }
        bySheet.push(entry);
      }

      // Extract from computed style of :root
      try {
        const root = document.documentElement;
        const cs   = getComputedStyle(root);
        // Some frameworks expose tokens on :root
        for (let i = 0; i < cs.length; i++) {
          const p = cs[i];
          if (p.startsWith('--')) customProps[p] = cs.getPropertyValue(p).trim();
        }
      } catch (_) {}

      // Classify tokens
      for (const [k, v] of Object.entries(customProps)) {
        if (/color|bg|background|fill|stroke/i.test(k) || /^#|^rgb|^hsl/.test(v)) colors.add(k);
        else if (/spacing|gap|padding|margin|size/i.test(k)) spacing.add(k);
        else if (/radius|rounded/i.test(k)) radii.add(k);
        else if (/font|family|text/i.test(k)) fonts.add(k);
        else if (/shadow/i.test(k)) shadows.add(k);
      }

      // Framework detection from class names / files
      const classNames = new Set([...document.querySelectorAll('[class]')]
        .flatMap(el => [...el.classList]).slice(0, 2000));
      if (classNames.has('tw') || [...classNames].some(c => /^(flex|grid|text-|bg-|p-|m-|w-|h-)/.test(c)))
        fwSignals.tailwind = true;
      if ([...document.styleSheets].some(s => s.href?.includes('bootstrap'))) fwSignals.bootstrap = true;
      if (classNames.has('MuiBox-root') || [...classNames].some(c => c.startsWith('Mui'))) fwSignals.mui = true;
      if (classNames.has('ant-')) fwSignals.antd = true;
      if ([...document.styleSheets].some(s => s.href?.includes('bulma'))) fwSignals.bulma = true;
      if (customProps['--chakra-colors-blue-500']) fwSignals.chakra = true;

      return {
        capturedAt: Date.now(),
        frameworks: fwSignals,
        customProps,
        tokens: {
          colors:   [...colors].map(k => ({ prop: k, value: customProps[k] })),
          spacing:  [...spacing].map(k => ({ prop: k, value: customProps[k] })),
          radii:    [...radii].map(k => ({ prop: k, value: customProps[k] })),
          fonts:    [...fonts].map(k => ({ prop: k, value: customProps[k] })),
          shadows:  [...shadows].map(k => ({ prop: k, value: customProps[k] })),
        },
        bySheet,
      };
    },
  });
})();
