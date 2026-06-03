/**
 * server/config-change-log.js
 *
 * Tracks agent-initiated config changes with validation and auto-revert.
 * - Logs every change with timestamp, agent context, severity
 * - Validates against "non-recommended" rules
 * - Auto-reverts non-recommended changes on startup (if enabled)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'cache', 'config-changes.json');

// ── Non-recommended config changes ───────────────────────────────────────────
// Each rule defines a path pattern and why it's non-recommended.
const NON_RECOMMENDED_RULES = [
  {
    path: 'plugins',
    severity: 'warning',
    message: 'Disabling plugins reduces agent perception. Re-enable when needed.',
    check: (key, val) => val === false,
  },
  {
    path: 'security.allowExecuteJs',
    severity: 'danger',
    message: 'Disabling JS execution removes the most powerful tool. Only do this temporarily.',
    check: (key, val) => val === false,
  },
  {
    path: 'security.allowActions',
    severity: 'danger',
    message: 'Disabling actions removes browser control capability.',
    check: (key, val) => val === false,
  },
  {
    path: 'security.allowScreenshots',
    severity: 'warning',
    message: 'Disabling screenshots removes visual perception.',
    check: (key, val) => val === false,
  },
  {
    path: 'react.maxDepth',
    severity: 'info',
    message: 'Changing React tree depth may cause incomplete data or performance issues.',
    check: (key, val) => val > 100 || val < 10,
  },
  {
    path: 'textCoords.maxWords',
    severity: 'info',
    message: 'Very high maxWords may cause memory issues. Recommended: 5000-15000.',
    check: (key, val) => val > 20000,
  },
];

// ── In-memory log ────────────────────────────────────────────────────────────
let changes = [];
let _allowAgentConfig = false;

function setAllowAgentConfig(val) {
  _allowAgentConfig = val;
}

function load() {
  try {
    if (fs.existsSync(LOG_PATH)) {
      const raw = fs.readFileSync(LOG_PATH, 'utf8');
      changes = JSON.parse(raw);
      // Only keep changes from the last 7 days
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      changes = changes.filter(c => c.timestamp > weekAgo);
    }
  } catch (_) {
    changes = [];
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, JSON.stringify(changes, null, 2));
  } catch (_) {}
}

function addChange(entry) {
  changes.push({
    id: changes.length + 1,
    timestamp: Date.now(),
    reverted: false,
    ...entry,
  });
  save();
}

function getActiveChanges() {
  return changes.filter(c => !c.reverted);
}

function markReverted(id) {
  const c = changes.find(x => x.id === id);
  if (c) { c.reverted = true; save(); }
}

function markAllReverted() {
  for (const c of changes) { c.reverted = true; }
  save();
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateChange(patch) {
  const warnings = [];

  function walk(obj, prefix) {
    for (const [key, val] of Object.entries(obj)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;

      for (const rule of NON_RECOMMENDED_RULES) {
        if (fullPath === rule.path || fullPath.startsWith(rule.path + '.')) {
          if (rule.check(key, val)) {
            warnings.push({
              code: 'NON_RECOMMENDED_CHANGE',
              severity: rule.severity,
              path: fullPath,
              value: val,
              message: rule.message,
            });
          }
        }
      }

      // Recurse into nested config sections. pushConfig() sends nested patches
      // (e.g. { security: { allowExecuteJs: false } }), while the rules above are
      // keyed by dotted paths — so without this descent no rule would ever match.
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        walk(val, fullPath);
      }
    }
  }

  walk(patch, '');
  return warnings;
}

// ── Auto-revert ──────────────────────────────────────────────────────────────

/**
 * Called on server startup. If autoRevertConfig is enabled,
 * reverts all non-recommended changes and returns a report.
 */
function autoRevertIfNeeded(config, pushConfig) {
  if (!config.agentControl?.autoRevertConfig) return null;

  const active = getActiveChanges();
  const nonRecommended = active.filter(c =>
    c.warnings && c.warnings.some(w => w.severity === 'danger' || w.severity === 'warning')
  );

  if (!nonRecommended.length) return null;

  const reverted = [];
  for (const change of nonRecommended) {
    // Build a revert patch (flip booleans, restore defaults for numbers)
    const revertPatch = {};
    function buildRevert(obj, prefix) {
      for (const [key, val] of Object.entries(obj)) {
        const fullPath = prefix ? `${prefix}.${key}` : key;
        if (typeof val === 'boolean') {
          // Flip back
          const parts = fullPath.split('.');
          let target = revertPatch;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!target[parts[i]]) target[parts[i]] = {};
            target = target[parts[i]];
          }
          target[parts[parts.length - 1]] = !val;
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
          // Descend into nested patches so flips on e.g. security.allowActions
          // are actually emitted (the patches pushConfig records are nested).
          buildRevert(val, fullPath);
        }
      }
    }
    buildRevert(change.patch, '');

    if (Object.keys(revertPatch).length) {
      pushConfig(revertPatch);
      markReverted(change.id);
      reverted.push({
        changeId: change.id,
        originalPatch: change.patch,
        revertPatch,
        reason: change.warnings.map(w => w.message).join('; '),
      });
    }
  }

  if (reverted.length) {
    markAllReverted();
  }

  return reverted.length ? {
    reverted,
    count: reverted.length,
    message: `Auto-reverted ${reverted.length} non-recommended config change(s) from previous session.`,
  } : null;
}

load();

module.exports = {
  setAllowAgentConfig,
  addChange,
  getActiveChanges,
  _getAll: () => changes,
  markReverted,
  markAllReverted,
  validateChange,
  autoRevertIfNeeded,
  NON_RECOMMENDED_RULES,
  _allowAgentConfig: false,
  get allowAgentConfig() { return _allowAgentConfig; },
};
