/**
 * extension/injected/lib/intent-classifier.js
 * Lightweight intent classifier for browser extension (MAIN world).
 * Port of server-side classifyIntent for offline use.
 */
(function () {
  if (window.__SI_CLASSIFY_INTENT__) return;

  // ?? Intent anchors (copied from server/configs/intent-anchors.json) ?????????????
  const INTENT_ANCHORS = {
    DISMISS: [
      "close", "dismiss", "quit", "exit",
      "???", "???", "??", "??",
      "??", "??",
      "??", "??",
      "fermer", "cerrar", "schlie?en"
    ],
    CONFIRM: [
      "ok", "okay", "yes", "confirm", "agree", "accept",
      "??", "??", "??", "????", "????",
      "??", "??", "?",
      "??", "??"
    ],
    CANCEL: [
      "cancel", "no", "abort", "nope",
      "?????", "???", "??",
      "??", "???",
      "??"
    ],
    COMPLETE: [
      "done", "finish", "complete", "submit", "send", "apply",
      "??", "???", "??", "??", "??",
      "??", "??",
      "??", "??"
    ],
    DECLINE: [
      "no thanks", "nothanks", "skip for now", "not interested",
      "????", "??", "????",
      "????", "???",
      "???"
    ],
    SKIP: [
      "skip", "later", "not now", "remind me later", "maybe later",
      "????", "???", "??", "????",
      "????", "???",
      "??"
    ],
    BACK: [
      "back", "return", "previous", "go back",
      "??", "??", "????", "????",
      "??", "??",
      "??"
    ],
    NAVIGATE: [
      "next", "continue", "proceed", "forward",
      "??", "??", "???",
      "??", "??",
      "???", "??"
    ]
  };

  // ?? Helper functions ???????????????????????????????????????????????????????????
  function normalizeLabel(str) {
    return (str || '').normalize('NFC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, '')
      .trim();
  }

  function bigramSet(str) {
    const s = str.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
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

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
    }
    return dp[m][n];
  }

  function intentFuzzyScore(q, t) {
    if (t === q) return 1.0;
    if (t.includes(q) || q.includes(t)) return 0.95;
    const qBi = bigramSet(q);
    const tBi = bigramSet(t);
    const bSim = jaccard(qBi, tBi);
    const maxLen = Math.max(q.length, t.length) || 1;
    const eSim = 1 - levenshtein(q, t) / maxLen;
    return Math.round((bSim * 0.6 + eSim * 0.4) * 1000) / 1000;
  }

  // ?? Main classifier ???????????????????????????????????????????????????????????
  function classifyIntent(label, threshold = 0.35) {
    const normalized = normalizeLabel(label);
    if (!normalized) return null;

    let best = { intent: 'UNKNOWN', score: 0, anchor: '' };

    for (const [intent, words] of Object.entries(INTENT_ANCHORS)) {
      for (const anchor of words) {
        const score = intentFuzzyScore(normalized, anchor);
        if (score > best.score) {
          best = { intent, score, anchor };
        }
        if (score >= 1.0) break;
      }
    }

    if (best.score < threshold) return null;
    return { intent: best.intent, confidence: best.score, topAnchor: best.anchor };
  }

  // Export to window
  window.__SI_CLASSIFY_INTENT__ = classifyIntent;
})();