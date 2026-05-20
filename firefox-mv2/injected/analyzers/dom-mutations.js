/**
 * analyzers/dom-mutations.js  –  MAIN world
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  registry.register({
    id: 'dom-mutations', name: 'DOM Mutation Observer', version: '1.0.0',
    runAt: 'document_start', realtime: true, priority: 4,
    emitType: 'DOM_MUTATIONS', cacheTarget: null, // stream only

    _batch: [],
    _timer: null,
    _observer: null,

    install(api) {
      const self = this;
      const flush = () => {
        if (!self._batch.length) return;
        api.emit('DOM_MUTATIONS', { mutations: self._batch.splice(0), ts: Date.now() }, true);
      };

      self._observer = new MutationObserver(mutations => {
        for (const m of mutations) {
          self._batch.push({
            type:     m.type,
            target:   m.target.tagName?.toLowerCase(),
            targetId: m.target.id || null,
            added:    m.addedNodes.length,
            removed:  m.removedNodes.length,
            attr:     m.attributeName || null,
          });
        }
        clearTimeout(self._timer);
        self._timer = setTimeout(flush, 100);
      });

      // Start observing once body exists
      const observe = () => {
        if (document.body) {
          self._observer.observe(document.body, {
            childList: true, subtree: true, attributes: true, characterData: false,
          });
        }
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observe, { once: true });
      } else {
        observe();
      }
    },

    collect(api) { return null; }, // realtime only
  });
})();
