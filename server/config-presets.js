/**
 * server/config-presets.js
 *
 * Named config presets applied to config.local.json by `whk config preset`.
 *
 * Design constraints (why this is a command, not a master flag):
 *   - Every key a preset touches is ENUMERATED and printed when applied —
 *     nothing implicit, no "consent to future capabilities". New keys added
 *     to a preset are only adopted when the operator re-runs the command.
 *   - Presets only fill keys the operator hasn't set (their values win);
 *     --force overrides explicitly.
 *   - Presets never touch protection settings (privacy.*) and never widen
 *     network exposure. Enabling dev.exec.enabled opens the POLICY only —
 *     dev MODE still requires the separate explicit `whk dev on` (TTL,
 *     badge, restart-clears), unchanged.
 */
'use strict';

const PRESETS = {
  // Everything a whiskor developer typically wants ON in their own
  // environment. Capability unlocks only — not preferences, not protections.
  dev: [
    { path: 'security.allowExecuteJs', value: true,
      why: 'execute_js tool (arbitrary JS in the page)' },
    { path: 'agentControl.allowAgentConfig', value: true,
      why: 'set_config tool (agent-driven config changes, audited + revertible)' },
    { path: 'dev.exec.enabled', value: true,
      why: 'dev-exec policy — exec_module still needs explicit `whk dev on`' },
    { path: 'agentControl.input.highFidelity', value: 'fallback',
      why: 'CDP trusted-input retry when a synthetic click changes nothing (Chrome only)' },
    { path: 'agentControl.console.captureAllWorlds', value: true,
      why: 'console/errors from ALL extension worlds via CDP (persistent debug banner, Chrome only)' },
    { path: 'agentControl.actionDiff.auto', value: true,
      why: '_diff on every page action (element-level change report)' },
    { path: 'agentControl.packedSom.prefetchOnNavigate', value: true,
      why: 'packed SoM pre-captured after navigation' },
    { path: 'agentControl.packedSom.prefetchThumbs', value: true,
      why: 'per-element thumbnails pre-warmed during packed capture' },
  ],
};

function getPath(obj, dotted) {
  let cur = obj;
  for (const key of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * Apply a named preset to a config object (the parsed config.local.json).
 * Mutates nothing; returns { config, actions } where each action is
 * { path, value, action: 'set' | 'kept', current? }. Keys the operator
 * already set are kept unless `force`.
 */
function applyPreset(existing, presetName, { force = false } = {}) {
  const preset = PRESETS[presetName];
  if (!preset) {
    const known = Object.keys(PRESETS).join(', ');
    throw new Error(`unknown preset "${presetName}" (known: ${known})`);
  }
  const config = JSON.parse(JSON.stringify(existing || {}));
  const actions = [];
  for (const { path, value, why } of preset) {
    const current = getPath(config, path);
    if (current !== undefined && !force) {
      actions.push({ path, value, why, action: 'kept', current });
      continue;
    }
    setPath(config, path, value);
    actions.push({ path, value, why, action: 'set', ...(current !== undefined ? { current } : {}) });
  }
  return { config, actions };
}

module.exports = { PRESETS, applyPreset, getPath, setPath };
