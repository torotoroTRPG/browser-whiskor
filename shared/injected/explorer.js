/**
 * explorer.js  –  MAIN world
 * Autonomous navigation engine.
 *
 * Improvements over v1:
 *   - Fuzzy element matching (token overlap + bigram similarity)
 *   - Loop detection via state hash cycle tracking
 *   - Depth limiting with configurable max depth
 *   - Multi-attribute element search (text, aria-label, title, placeholder, data-*)
 *   - Configurable action delay
 *   - Framework-agnostic state hashing (DOM structure + URL)
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  // ── Fuzzy Matching ────────────────────────────────────────────────────────

  function tokenize(str) {
    return (str || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  }

  function bigramSet(str) {
    const s = str.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
    return set;
  }

  function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) { if (b.has(x)) inter++; }
    return inter / (a.size + b.size - inter);
  }

  function fuzzyScore(query, target) {
    const q = query.toLowerCase().trim();
    const t = target.toLowerCase().trim();
    if (t.includes(q)) return 1.0;
    const qTok = new Set(tokenize(q));
    const tTok = new Set(tokenize(t));
    const tokenSim = jaccard(qTok, tTok);
    const qBi = bigramSet(q);
    const tBi = bigramSet(t);
    const bigramSim = jaccard(qBi, tBi);
    const bw = q.length < 5 ? 0.6 : 0.3;
    return Math.round((tokenSim * (1 - bw) + bigramSim * bw) * 1000) / 1000;
  }

  // ── State Hashing ─────────────────────────────────────────────────────────
  // The canonical engine lives in state-reporter.js (always on, loaded before
  // this file). Delegating keeps node identity single-sourced — a local copy
  // here once drifted into an explorer-only hash and left graphs nodeless.

  function computeDomHash() {
    return window.__SI_HASH_ENGINE__.domHash();
  }

  function computeCompositeHash() {
    return window.__SI_HASH_ENGINE__.compute().compositeHash;
  }

  // ── Element Finder ────────────────────────────────────────────────────────

  function findElement(target) {
    const query = target.text || '';
    const minScore = target.minScore || 0.5;
    const candidates = document.querySelectorAll(
      'button, a, [role=button], [role=link], input, select, textarea, [aria-label], [title]'
    );

    let bestMatch = null;
    let bestScore = 0;

    for (const el of candidates) {
      const texts = [
        el.textContent?.trim() || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.getAttribute('placeholder') || '',
        el.getAttribute('data-label') || '',
        el.getAttribute('alt') || '',
        el.value || '',
      ].filter(Boolean);

      for (const t of texts) {
        const score = fuzzyScore(query, t);
        if (score >= minScore && score > bestScore) {
          bestScore = score;
          bestMatch = el;
        }
      }
    }

    return bestMatch ? { element: bestMatch, score: bestScore } : null;
  }

  // ── Explorer ───────────────────────────────────────────────────────────────

  class AutonomousExplorer {
    constructor() {
      this.active = false;
      this.lastActionAt = 0;
      this.visitedStates = new Map(); // hash → { depth, timestamp }
      this.currentDepth = 0;
      this.maxDepth = 20;
      this.actionHistory = [];
      this.loopThreshold = 3; // revisit same state N times → backtrack
      // Set when an action is dispatched; on the next loop tick, if the state
      // hash changed, an EXPLORER_TRANSITION edge (from → to) is reported. The
      // server's getUnvisitedActions filters candidates by recorded edge
      // triggers, so without these edges it would keep proposing the same
      // element and exploration could never advance.
      this.pendingTransition = null; // { from, trigger, at }
    }

    start(opts = {}) {
      this.active = true;
      this.maxDepth = opts.maxDepth || 20;
      this.visitedStates.clear();
      this.currentDepth = 0;
      this.actionHistory = [];
      console.log('[SI Explorer] Started (maxDepth=' + this.maxDepth + ')');
      this.loop();
    }

    stop() {
      this.active = false;
      console.log('[SI Explorer] Stopped');
    }

    async loop() {
      while (this.active) {
        const delay = 1000 + Math.random() * 2000; // 1-3s (faster than before)
        await new Promise(r => setTimeout(r, delay));
        if (!this.active) break;

        const uiCatalog = window.__SI_REGISTRY__._plugins.get('ui-catalog')?.collect(window.__SI_REGISTRY__._api);
        const stateHash = computeCompositeHash();
        var currentHashInfo = window.__SI_CURRENT_HASH__ || { compositeHash: stateHash, reactHash: null, domHash: stateHash };

        if (!uiCatalog || !stateHash) continue;

        // Report the edge for the action dispatched last tick (state changed →
        // the click led somewhere). Stale entries (>15s) are dropped: the page
        // may have navigated or the action may simply have done nothing.
        if (this.pendingTransition) {
          const pt = this.pendingTransition;
          this.pendingTransition = null;
          if (stateHash !== pt.from && Date.now() - pt.at < 15000) {
            window.postMessage({
              __BROWSER_WHISKOR__: true,
              type: 'EXPLORER_TRANSITION',
              siteVersion: window.__SI_VERSION__?.id,
              payload: {
                siteVersion: window.__SI_VERSION__?.id,
                from: pt.from,
                to: stateHash,
                action: 'click',
                trigger: pt.trigger,
              }
            }, '*');
          }
        }

        // Loop detection
        const prev = this.visitedStates.get(stateHash);
        if (prev) {
          var revisitCount = (prev.count || 0) + 1;
          this.visitedStates.set(stateHash, { depth: this.currentDepth, timestamp: Date.now(), count: revisitCount });

          if (revisitCount >= this.loopThreshold) {
            console.warn('[SI Explorer] Loop detected at state ' + stateHash + ' (revisited ' + revisitCount + ' times). Backtracking.');
            window.postMessage({
              __BROWSER_WHISKOR__: true,
              type: 'EXPLORER_LOOP_DETECTED',
              payload: { stateHash: stateHash, reactHash: currentHashInfo.reactHash, domHash: currentHashInfo.domHash, revisitCount: revisitCount, depth: this.currentDepth }
            }, '*');
            continue;
          }
        } else {
          this.visitedStates.set(stateHash, { depth: this.currentDepth, timestamp: Date.now(), count: 1 });
        }

        // Depth limit
        if (this.currentDepth >= this.maxDepth) {
          console.warn('[SI Explorer] Max depth reached (' + this.maxDepth + '). Stopping.');
          this.stop();
          break;
        }

        // Ask server for next action
        window.postMessage({
          __BROWSER_WHISKOR__: true,
          type: 'EXPLORER_GET_NEXT_ACTION',
          siteVersion: window.__SI_VERSION__?.id,
          payload: {
            uiCatalog,
            stateHash: currentHashInfo.compositeHash,
            reactHash: currentHashInfo.reactHash,
            domHash: currentHashInfo.domHash,
            depth: this.currentDepth,
            maxDepth: this.maxDepth,
            visitedCount: this.visitedStates.size,
            actionHistory: this.actionHistory.slice(-10),
          }
        }, '*');
      }
    }

    handleNextAction(action) {
      if (!this.active || !action.target) return;
      const target = action.target;
      console.log('[SI Explorer] Searching for element:', target.text);

      const result = findElement(target);

      if (result) {
        console.log('[SI Explorer] Found match (score: ' + result.score.toFixed(2) + '):', result.element.tagName, result.element.textContent?.trim().slice(0, 30));
        this.currentDepth++;
        this.actionHistory.push({ type: action.type || 'click', target: target.text, depth: this.currentDepth });
        this.pendingTransition = {
          from: (window.__SI_CURRENT_HASH__ && window.__SI_CURRENT_HASH__.compositeHash) || computeCompositeHash(),
          trigger: target.text,
          at: Date.now(),
        };
        this.simulateHumanClick(result.element);
      } else {
        console.warn('[SI Explorer] Element not found:', target.text);
        // Try next available element as fallback
        this.tryFallback();
      }
    }

    tryFallback() {
      // Click the first unvisited interactive element
      const candidates = document.querySelectorAll('a, button, [role=button]');
      for (const el of candidates) {
        const text = el.textContent?.trim() || '';
        if (text && text.length > 0 && text.length < 100) {
          console.log('[SI Explorer] Fallback: clicking', el.tagName, text.slice(0, 30));
          this.currentDepth++;
          this.actionHistory.push({ type: 'fallback-click', target: text, depth: this.currentDepth });
          this.pendingTransition = {
            from: (window.__SI_CURRENT_HASH__ && window.__SI_CURRENT_HASH__.compositeHash) || computeCompositeHash(),
            trigger: text,
            at: Date.now(),
          };
          this.simulateHumanClick(el);
          return;
        }
      }
      console.warn('[SI Explorer] No fallback candidates available.');
    }

    simulateHumanClick(el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        const evt = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window
        });
        el.dispatchEvent(evt);
      }, 500); // Reduced from 1000ms
    }
  }

  window.__SI_EXPLORER__ = new AutonomousExplorer();

    // Listen for actions from server (via bridge -> postMessage)
    window.addEventListener('message', function(event) {
      if (event.source !== window) return;
      if (event.data?.__BROWSER_WHISKOR__ && event.data.type === 'EXPLORER_NEXT_ACTION') {
        window.__SI_EXPLORER__.handleNextAction(event.data.payload);
      }
      if (event.data?.__BROWSER_WHISKOR__ && event.data.type === 'MANUAL_COLLECT' && event.data.payload?.explorer) {
        if (event.data.payload.explorer === 'start') {
          var opts = event.data.payload.options || {};
          window.__SI_EXPLORER__.start(opts);
        }
        if (event.data.payload.explorer === 'stop') window.__SI_EXPLORER__.stop();
      }
      // Handle REQUEST_STATE_HASH from server
      if (event.data?.__BROWSER_WHISKOR__ && event.data.type === 'REQUEST_STATE_HASH') {
        var hashInfo = window.__SI_CURRENT_HASH__ || {
          compositeHash: computeCompositeHash(),
          reactHash: window.__SI_REACT_HASH__ || null,
          domHash: computeDomHash(),
        };
        window.postMessage({
          __BROWSER_WHISKOR__: true,
          type: 'STATE_HASH_REPORT',
          requestId: event.data.requestId,
          payload: {
            compositeHash: hashInfo.compositeHash,
            reactHash: hashInfo.reactHash,
            domHash: hashInfo.domHash,
            source: hashInfo.reactHash ? 'react' : 'dom',
            capturedAt: Date.now()
          }
        }, '*');
      }
    });
})();
