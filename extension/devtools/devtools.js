'use strict';
chrome.devtools.panels.create('browser-whiskor', '', '../panel/panel.html');

// ── Level 1 CSS Origin Bridge ──────────────────────────────────────────────────
// Periodically collects full CSS text via inspectedWindow.eval() (bypasses CORS)
// and stores it in the page context for css-origin.js to consume.

const CSS_CACHE_VAR = '__SI_DEVTOOLS_CSS_CACHE__';
let l1PollTimer = null;
const L1_POLL_MS = 5000;

async function collectLevel1Css() {
  try {
    const result = await new Promise((resolve) => {
      chrome.devtools.inspectedWindow.eval(
        `(function() {
          const cache = [];
          for (let i = 0; i < document.styleSheets.length; i++) {
            try {
              const sheet = document.styleSheets[i];
              const rules = sheet.cssRules;
              if (!rules) continue;
              const texts = [];
              for (let j = 0; j < rules.length; j++) {
                texts.push(rules[j].cssText);
              }
              cache.push({
                href: sheet.href || 'inline',
                rules: texts,
                count: texts.length,
              });
            } catch (_) {}
          }
          window['${CSS_CACHE_VAR}'] = cache;
          return cache.length;
        })()`,
        { useContentScriptContext: false },
        (result) => resolve(result)
      );
    });
    if (result !== undefined) {
      // Signal css-origin that Level 1 data is available
      chrome.devtools.inspectedWindow.eval(
        `(function() {
          if (window.__SI_REGISTRY__) {
            window.__SI_REGISTRY__._devtoolsL1Ready = true;
          }
        })()`
      );
    }
  } catch (_) {}
}

function startL1Polling() {
  collectLevel1Css();
  l1PollTimer = setInterval(collectLevel1Css, L1_POLL_MS);
}

function stopL1Polling() {
  if (l1PollTimer) {
    clearInterval(l1PollTimer);
    l1PollTimer = null;
  }
}

chrome.devtools.network.onNavigated.addListener(() => {
  stopL1Polling();
  startL1Polling();
});

startL1Polling();

// Cleanup on panel hide
window.addEventListener('beforeunload', stopL1Polling);
