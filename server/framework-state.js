/**
 * server/framework-state.js
 * Framework-state read: pick the detected framework's snapshot file for a tab
 * and return it with freshness + source-recovery annotations.
 *
 * Shared by the MCP `get_framework_state` tool and the HTTP endpoint
 * GET /api/sessions/:tabId/framework-state — one implementation so the two
 * surfaces can never drift (HTTP-only agents previously had NO way to read
 * framework state at all; the React/Redux snapshot sat in the cache unread).
 */
'use strict';

const { withFreshness, sourceRecoveryHint } = require('./mcp/tools/read-helpers');

const FW_PLUGIN_MAP = {
  react: 'react-fiber', vue3: 'vue3', vue2: 'vue2',
  angular: 'angular', svelte: 'svelte', alpine: 'alpine',
  preact: 'preact', solid: 'solid', dom: 'dom-generic',
};

// Detection priority for framework='auto' — a real framework beats the
// generic DOM snapshot, and React is by far the most common.
const FW_PRIORITY = ['react', 'vue3', 'vue2', 'angular', 'svelte', 'alpine', 'preact', 'solid', 'dom'];

function fwFileMap(index) {
  const files = (index && index.files && index.files.raw) || {};
  return {
    react:   files.react_snapshot,
    vue3:    files.vue_snapshot,
    vue2:    files.vue2_snapshot,
    angular: files.angular_snapshot,
    svelte:  files.svelte_snapshot,
    alpine:  files.alpine_snapshot,
    preact:  files.preact_snapshot,
    solid:   files.solid_snapshot,
    dom:     files.dom_generic,
  };
}

/**
 * Read the framework state for a tab.
 * @param cache      worker-side cache (getSessionData / readSessionFile / freshnessInfo)
 * @param tabId      numeric tab id
 * @param framework  'auto' (default) or a specific framework key
 * @returns result object, or { error } when unavailable
 */
async function readFrameworkState(cache, tabId, framework) {
  const index = await cache.getSessionData(tabId);
  if (!index) return { error: `No session for tabId ${tabId}` };

  const fw = framework || 'auto';
  const map = fwFileMap(index);

  let targetFw = null;
  let targetFile = null;
  if (fw === 'auto') {
    for (const key of FW_PRIORITY) {
      if (map[key]) { targetFw = key; targetFile = map[key]; break; }
    }
  } else {
    targetFw = fw;
    targetFile = map[fw];
  }

  if (!targetFile) {
    return { error: `Framework '${fw}' not detected. Available: ${Object.keys(map).filter(k => map[k]).join(', ') || 'none'}` };
  }
  const data = await cache.readSessionFile(tabId, targetFile);
  if (!data) return { error: `File ${targetFile} not readable.` };

  const plugin = FW_PLUGIN_MAP[targetFw] || targetFw;
  const result = withFreshness(tabId, plugin, data, cache);

  // Minified/production build → component names, files, lines are stripped
  // from the Fiber/DOM but recoverable via capture_sources. Surface that so
  // agents don't conclude "impossible" (same shape MCP/HTTP/CLI all see).
  const hint = sourceRecoveryHint(plugin, data);
  if (hint && result) {
    result._warnings = [...(result._warnings || []), hint];
  }
  return result;
}

module.exports = { readFrameworkState, FW_PRIORITY, FW_PLUGIN_MAP };
