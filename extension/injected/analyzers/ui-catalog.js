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
      const buttons = [...document.querySelectorAll('button,[role=button],[type=button],[type=submit]')]
        .slice(0, 200).map(el => ({
          text: el.textContent.trim().slice(0, 60),
          type: el.getAttribute('type') || null,
          disabled: el.disabled || null,
          rect: getRect(el),
          classes: el.className?.slice(0, 80),
        }));

      const inputs = [...document.querySelectorAll('input,textarea,select')]
        .slice(0, 100).map(el => ({
          type: el.tagName.toLowerCase() === 'input' ? (el.type || 'text') : el.tagName.toLowerCase(),
          name: el.name || null, id: el.id || null,
          placeholder: el.placeholder || null,
          required: el.required || null,
          rect: getRect(el),
        }));

      const links = [...document.querySelectorAll('a[href]')]
        .slice(0, 200).map(el => ({
          text: el.textContent.trim().slice(0, 60),
          href: el.href,
          target: el.target || null,
          rect: getRect(el),
        }));

      const images = [...document.querySelectorAll('img[src]')]
        .slice(0, 100).map(el => ({
          src: el.src, alt: el.alt || null,
          naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight,
          rect: getRect(el),
        }));

      const hidden = [...document.querySelectorAll('[hidden],[style*="display:none"],[style*="display: none"]')]
        .slice(0, 50).map(el => ({
          tag: el.tagName.toLowerCase(), id: el.id || null,
          classes: el.className?.slice(0, 60),
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
