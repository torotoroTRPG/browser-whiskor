/**
 * server/tool-manager.js
 *
 * Dynamic Tool Profile Manager.
 *
 * Manages tool visibility based on context, auto-detection, and AI requests.
 * Core tools are always available. Other profiles load on demand or auto-trigger.
 * Auto-unloads idle profiles to keep AI context lean.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROFILES_FILE = path.join(__dirname, 'configs', 'tool-profiles.json');
const MAX_IDLE_TURNS_DEFAULT = 8;
const WARNING_TURN_THRESHOLD = 5;

// ── Meta tools (profile discovery / management) ──────────────────────────────
// These tools are always visible regardless of the active profiles so that an
// agent connecting for the first time can self-discover and bootstrap the rest
// of the toolset (search → load → status → unload). They are intentionally kept
// out of the `core` profile in tool-profiles.json so that the profile config
// reflects only domain tools while meta tools are owned by the manager itself.
//
// analyze_click is also always visible: it is a pre-action dry-run utility
// (clickability report before committing a click) that is useful in any context
// and carries no side effects, making it appropriate alongside meta tools.
const ALWAYS_VISIBLE_TOOLS = Object.freeze([
  'search_tools',
  'load_profile',
  'unload_profile',
  'profile_status',
  'analyze_click',
]);

// Allowed characters for an externally supplied session id (env var).
// Keeps logs, file paths and broadcast keys safe.
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Validate a session id string. Returns the id if acceptable, otherwise null.
 */
function sanitizeSessionId(id) {
  if (typeof id !== 'string') return null;
  return SESSION_ID_RE.test(id) ? id : null;
}

// ── State ─────────────────────────────────────────────────────────────────────
// sessionId -> { activeProfiles: Set, turnCount: number, lastUsed: Map<profile, turn>, toolHistory: Array }
const sessions = new Map();

// Static tools mode (mcpServer.staticTools / --static-tools): every profile is
// permanently visible, nothing loads or unloads. For MCP clients that fetch
// tools/list once and never follow tools/list_changed. requiresConfig gates
// (allowExecuteJs / allowAgentConfig) and the mcp-tools.json enabled flags are
// still honored — static widens visibility, never permissions.
let _staticMode = false;

function setStaticMode(enabled) {
  _staticMode = enabled === true;
}

function isStaticMode() {
  return _staticMode;
}

// ── dev mode absence principle (dev-exec.md 7.3 / I-1) ────────────────────────
// A profile flagged `"devMode": true` in tool-profiles.json is invisible unless
// dev mode is ACTIVE. Its visibility is NOT driven by the load/unload machinery
// (it can't be load_profile'd or auto-triggered) — it is driven purely by this
// checker, so activation/expiry flips the whole profile in and out of tools/list.
// The tool's mere presence announces the capability, so dev profiles are the one
// documented exception to static-tools mode too. Default: inactive.
let _devModeChecker = () => false;
function setDevModeChecker(fn) { _devModeChecker = typeof fn === 'function' ? fn : (() => false); }
function devModeActive() { try { return _devModeChecker() === true; } catch { return false; } }
function isDevProfile(profile) { return !!(profile && profile.devMode === true); }

// ── Duplicate Detection Settings ─────────────────────────────────────────────
const DUPLICATE_THRESHOLD = 3; // Same tool+args repeated this many times
const DUPLICATE_WINDOW = 10;   // Look back this many turns

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadProfiles() {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function ensureSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      activeProfiles: new Set(['core']),
      turnCount: 0,
      lastUsed: new Map([['core', 0]]),
      warnings: new Map(),
      toolHistory: [],
      // ── minScoreOverride state ──────────────────
      minScoreOverride: null,
      minScoreSetAtTurn: null,
      lastSearchToolTurn: null,
      _pendingMinScoreResetNotice: null,
    });
  }
  return sessions.get(sessionId);
}

/**
 * Get session state (for use by tools).
 */
function getSessionState(sessionId) {
  return sessions.get(sessionId);
}

// ── Duplicate Detection ───────────────────────────────────────────────────────
/**
 * Record a tool call in history and detect duplicates.
 * Returns warning object if duplicate detected, null otherwise.
 */
function recordToolCall(session, toolName, args, config) {
  // Check if duplicate detection is enabled
  const dupConfig = config?.agentControl?.duplicateDetection;
  if (dupConfig?.enabled === false) return null;

  const threshold = dupConfig?.threshold ?? DUPLICATE_THRESHOLD;
  const window = dupConfig?.window ?? DUPLICATE_WINDOW;

  const callKey = `${toolName}:${JSON.stringify(args || {})}`;
  session.toolHistory.push({
    tool: toolName,
    args,
    key: callKey,
  });

  // Keep only recent history
  if (session.toolHistory.length > window * 2) {
    session.toolHistory = session.toolHistory.slice(-window * 2);
  }

  // Check for duplicates in the window
  const recent = session.toolHistory.slice(-window);
  const matches = recent.filter(h => h.key === callKey);

  if (matches.length >= threshold) {
    return {
      code: 'DUPLICATE_OPERATION',
      level: matches.length > threshold + 1 ? 'strong' : 'info',
      message: `Tool '${toolName}' called ${matches.length} times with same arguments in last ${window} turns. This may indicate a loop.`,
      tool: toolName,
      count: matches.length,
      action: dupConfig?.action || 'warn',
    };
  }
  return null;
}

// ── Trigger Detection ─────────────────────────────────────────────────────────

/**
 * Build the text a tool call is matched against for profile auto-triggering.
 * Combines the tool name with its primitive (string/number/boolean) argument
 * values, so an intent expressed in arguments — e.g. get_text_coords({match:
 * "console error"}) while debugging — can surface the relevant profile even when
 * the tool name itself carries no trigger keyword. Capped to keep matching cheap.
 */
function buildTriggerText(toolCall) {
  const name = (toolCall.name || '').toLowerCase();
  const args = toolCall.args;
  if (!args || typeof args !== 'object') return { name, argsText: '' };

  const parts = [];
  for (const v of Object.values(args)) {
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(String(v));
  }
  return { name, argsText: parts.join(' ').toLowerCase().slice(0, 500) };
}

/**
 * Decide whether a profile trigger keyword matches a tool call.
 *   - Tool name: substring match (names are structured identifiers, e.g.
 *     get_css_analysis contains "css").
 *   - Argument text: whole-word / phrase match, so "error" matches "console
 *     error" but not "errorBoundary" or "terror" — avoiding spurious loads from
 *     arbitrary page data the agent happens to be searching for.
 */
function triggerMatches(trigger, name, argsText) {
  if (name.includes(trigger)) return true;
  if (!argsText) return false;
  try {
    const re = new RegExp('\\b' + trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    return re.test(argsText);
  } catch (_) {
    return argsText.includes(trigger);
  }
}

function getAllToolsForProfile(profileName, profiles, config) {
  const profile = profiles[profileName];
  if (!profile) return [];

  // Check config requirements
  if (profile.requiresConfig) {
    const val = config.security?.[profile.requiresConfig] || config.agentControl?.[profile.requiresConfig];
    if (!val) return []; // Security gate
  }

  return profile.tools || [];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize session with core tools.
 */
function initSession(sessionId) {
  return ensureSession(sessionId);
}

/**
 * Get currently visible tools for a session.
 */
function getVisibleTools(sessionId, allTools, config) {
  const session = ensureSession(sessionId);
  const profiles = loadProfiles();
  const visible = new Set();

  if (_staticMode) {
    // Every profile, permanently — but getAllToolsForProfile still applies the
    // requiresConfig security gates, so e.g. execute_js stays hidden while
    // allowExecuteJs is false. dev profiles are the exception: static widens
    // visibility, but a dev tool's existence IS the capability announcement, so
    // it stays absent unless dev mode is active (7.3).
    const devOn = devModeActive();
    for (const profileName of Object.keys(profiles)) {
      if (isDevProfile(profiles[profileName]) && !devOn) continue;
      for (const t of getAllToolsForProfile(profileName, profiles, config)) visible.add(t);
    }
    for (const t of ALWAYS_VISIBLE_TOOLS) visible.add(t);
    return allTools.filter(t => visible.has(t.definition.name));
  }

  for (const profileName of session.activeProfiles) {
    // dev profiles are never driven by activeProfiles — see the dev-mode block below.
    if (isDevProfile(profiles[profileName])) continue;
    const tools = getAllToolsForProfile(profileName, profiles, config);
    for (const t of tools) visible.add(t);
  }

  // dev mode absence principle: when (and only when) dev mode is active, every
  // devMode profile's tools appear — no explicit load needed. Flipping dev mode
  // changes this set, which the transport reports via tools/list_changed.
  if (devModeActive()) {
    for (const [name, profile] of Object.entries(profiles)) {
      if (!isDevProfile(profile)) continue;
      for (const t of getAllToolsForProfile(name, profiles, config)) visible.add(t);
    }
  }

  // Meta tools are always visible (profile discovery / lifecycle management).
  for (const t of ALWAYS_VISIBLE_TOOLS) visible.add(t);

  // Filter allTools to only visible ones
  return allTools.filter(t => visible.has(t.definition.name));
}

/**
 * Load a profile explicitly or via auto-trigger.
 * Returns { success, loadedTools, warning? }
 */
function loadProfile(sessionId, profileName, allTools, config, isAuto = false) {
  const session = ensureSession(sessionId);
  const profiles = loadProfiles();

  if (!profiles[profileName]) {
    return { success: false, error: `Unknown profile: ${profileName}` };
  }

  // dev profiles are not loadable — their visibility is owned by dev mode
  // (whk dev on), never by load_profile / auto-trigger (7.3, I-2).
  if (isDevProfile(profiles[profileName])) {
    return { success: false, error: `Profile '${profileName}' is a dev profile — activate it with 'whk dev on' (operator only), not load_profile.` };
  }

  if (_staticMode) {
    return { success: true, loadedTools: [], note: 'Static tools mode — every profile is already permanently visible.' };
  }

  if (session.activeProfiles.has(profileName)) {
    // Already loaded, just reset idle timer
    session.lastUsed.set(profileName, session.turnCount);
    return { success: true, loadedTools: [], note: 'Already active' };
  }

  // Check config requirement
  if (profiles[profileName].requiresConfig) {
    const allowed = config.security?.[profiles[profileName].requiresConfig] || config.agentControl?.[profiles[profileName].requiresConfig];
    if (!allowed) {
      return { success: false, error: `Profile '${profileName}' requires ${profiles[profileName].requiresConfig} to be enabled.` };
    }
  }

  session.activeProfiles.add(profileName);
  session.lastUsed.set(profileName, session.turnCount);

  const loadedTools = getAllToolsForProfile(profileName, profiles, config)
    .map(name => allTools.find(t => t.definition.name === name))
    .filter(Boolean);

  return { success: true, loadedTools, auto: isAuto };
}

/**
 * Unload a profile.
 */
function unloadProfile(sessionId, profileName, allTools) {
  const session = ensureSession(sessionId);

  if (_staticMode) {
    return { success: false, error: 'Static tools mode — profiles cannot be unloaded. Disable mcpServer.staticTools to use dynamic profiles.' };
  }

  if (profileName === 'core') {
    return { success: false, error: 'Cannot unload core profile' };
  }

  if (!session.activeProfiles.has(profileName)) {
    return { success: false, error: `Profile '${profileName}' is not active` };
  }

  session.activeProfiles.delete(profileName);
  session.lastUsed.delete(profileName);
  session.warnings.delete(profileName);

  return { success: true };
}

/**
 * Find which profile(s) declare a given tool. Used to auto-enable the owning
 * profile when an agent calls a tool that exists but isn't currently loaded.
 * Returns [{ profile, requiresConfig }] (usually a single entry).
 */
function findProfilesForTool(toolName) {
  const profiles = loadProfiles();
  const owners = [];
  for (const [name, profile] of Object.entries(profiles)) {
    if (Array.isArray(profile.tools) && profile.tools.includes(toolName)) {
      owners.push({ profile: name, requiresConfig: profile.requiresConfig || null });
    }
  }
  return owners;
}

/**
 * Ensure a tool is visible for a session, auto-loading its owning profile when
 * the tool exists but its profile simply isn't loaded yet. This is the common
 * case that agents previously misread as "tool not implemented".
 *
 * It deliberately distinguishes the two reasons a call can be blocked:
 *   - just-not-loaded  → auto-loads the owning profile, reports { autoLoaded }.
 *   - permission-gated → a profile that requiresConfig (allowExecuteJs /
 *                        allowAgentConfig) is NOT auto-loaded; the caller gets a
 *                        precise reason so it can ask the user instead of retrying.
 *
 * Returns one of:
 *   { visible: true }                                       already visible
 *   { visible: true, autoLoaded: 'profile' }                owning profile loaded now
 *   { visible: false, reason: 'requires_config', profile, requiresConfig }
 *   { visible: false, reason: 'no_profile' }                no profile provides it
 */
function ensureToolVisible(sessionId, toolName, allTools, config) {
  const isVisible = () => getVisibleTools(sessionId, allTools, config)
    .some(t => t.definition.name === toolName);

  if (isVisible()) return { visible: true };

  const owners = findProfilesForTool(toolName);
  if (owners.length === 0) return { visible: false, reason: 'no_profile' };

  // A tool owned only by dev profiles cannot be auto-loaded — dev mode governs
  // it. If dev mode is inactive, say so precisely (not "requires_config").
  const profiles = loadProfiles();
  const allDev = owners.every(o => isDevProfile(profiles[o.profile]));
  if (allDev) {
    return devModeActive()
      ? { visible: true } // dev mode on ⇒ getVisibleTools already exposes it; re-affirm
      : { visible: false, reason: 'dev_mode_inactive', profile: owners[0].profile };
  }

  // Prefer an owner without a config gate so genuinely-open tools auto-load.
  owners.sort((a, b) => (a.requiresConfig ? 1 : 0) - (b.requiresConfig ? 1 : 0));

  for (const owner of owners) {
    const res = loadProfile(sessionId, owner.profile, allTools, config, true);
    if (res.success && isVisible()) return { visible: true, autoLoaded: owner.profile };
  }

  // Every owning profile is permission-gated (requiresConfig not satisfied).
  const gated = owners.find(o => o.requiresConfig) || owners[0];
  return {
    visible: false,
    reason: 'requires_config',
    profile: gated.profile,
    requiresConfig: gated.requiresConfig,
  };
}

/**
 * Process a turn: check idle profiles, auto-detect triggers, issue warnings.
 * Returns { autoLoaded?, warnings?, unloaded? }
 */
function processTurn(sessionId, lastToolCall, allTools, config) {
  const session = ensureSession(sessionId);
  const profiles = loadProfiles();
  const results = { autoLoaded: [], warnings: [], unloaded: [] };

  // 0. Record tool call and check for duplicates (before increment for accurate window)
  if (lastToolCall) {
    const dupWarning = recordToolCall(session, lastToolCall.name, lastToolCall.args, config);
    if (dupWarning) {
      results.warnings.push(dupWarning);
    }
  }

  session.turnCount++;

  // Static mode: nothing loads or unloads, so trigger detection (1), idle decay
  // (2) and long-active warnings (3) are all moot. Duplicate detection (0) and
  // the minScoreOverride reset (4) still apply — they are orthogonal to
  // tool visibility.

  // 1. Auto-detect triggers from the last tool call (name + argument text).
  //    Argument scanning can be disabled via agentControl.argTriggerDetection.
  if (!_staticMode && lastToolCall) {
    const { name: callName, argsText: rawArgsText } = buildTriggerText(lastToolCall);
    const argsEnabled = config?.agentControl?.argTriggerDetection !== false;
    const argsText = argsEnabled ? rawArgsText : '';

    for (const [name, profile] of Object.entries(profiles)) {
      if (session.activeProfiles.has(name) || name === 'core') continue;
      if (!profile.triggers) continue;

      const matched = profile.triggers.some(t => triggerMatches(t, callName, argsText));
      if (matched) {
        const loadResult = loadProfile(sessionId, name, allTools, config, true);
        if (loadResult.success) {
          results.autoLoaded.push(name);
        }
      }
    }
  }

  // 2. Check idle profiles for auto-unload
  for (const profileName of _staticMode ? [] : [...session.activeProfiles]) {
    if (profileName === 'core') continue;
    const profile = profiles[profileName];
    if (!profile || !profile.autoUnload) continue;

    const idleTurns = session.turnCount - (session.lastUsed.get(profileName) || 0);
    const maxIdle = profile.idleTurns || MAX_IDLE_TURNS_DEFAULT;

    if (idleTurns > maxIdle) {
      unloadProfile(sessionId, profileName, allTools);
      results.unloaded.push(profileName);
    }
  }

  // 3. Issue warnings for long-active profiles
   for (const profileName of _staticMode ? [] : session.activeProfiles) {
     if (profileName === 'core') continue;
     const profile = profiles[profileName];
     if (!profile || !profile.autoUnload) continue;

     const activeTurns = session.turnCount - (session.lastUsed.get(profileName) || 0);
     const warningKey = `${profileName}_warn`;

     if (activeTurns >= WARNING_TURN_THRESHOLD && !session.warnings.has(warningKey)) {
       session.warnings.set(warningKey, true);
       results.warnings.push({
         profile: profileName,
         level: activeTurns > WARNING_TURN_THRESHOLD + 3 ? 'strong' : 'info',
         message: activeTurns > WARNING_TURN_THRESHOLD + 3
           ? `Profile '${profileName}' active for ${activeTurns} turns. Consider unloading and reloading if still needed.`
           : `Profile '${profileName}' has been active for ${activeTurns} turns.`,
       });
     }
   }

   // 4. Check minScoreOverride auto-reset
   if (session.minScoreOverride !== null) {
     const isSearchTool = lastToolCall && ['get_text_coords', 'get_ui_catalog', 'get_accessibility'].includes(lastToolCall.name);
     if (isSearchTool) {
       session.lastSearchToolTurn = session.turnCount;
     } else if (session.lastSearchToolTurn !== null) {
       const resetTurns = config?.intelligence?.searchClassifier?.agentOverrideAutoResetTurns ?? 3;
       if (resetTurns > 0) {
         const idle = session.turnCount - session.lastSearchToolTurn;
         if (idle >= resetTurns) {
           const prevValue = session.minScoreOverride;
           const defaultScore = config?.intelligence?.searchClassifier?.defaultMinScore ?? 0.1;
           session.minScoreOverride = null;
           session.minScoreSetAtTurn = null;
           session._pendingMinScoreResetNotice = { from: prevValue, to: defaultScore };
         }
       }
     }
   }

   return results;
 }

/**
 * Search tools without loading them (lazy discovery).
 */
function searchTools(query, allTools) {
  if (!query) return allTools.map(t => ({ name: t.definition.name, description: t.definition.description }));

  const q = query.toLowerCase();
  return allTools
    .filter(t =>
      t.definition.name.toLowerCase().includes(q) ||
      t.definition.description.toLowerCase().includes(q)
    )
    .map(t => ({ name: t.definition.name, description: t.definition.description }));
}

/**
 * Get profile status for a session.
 */
function getProfileStatus(sessionId) {
  const session = ensureSession(sessionId);
  const profiles = loadProfiles();
  const status = {};
  const available = [];

  if (_staticMode) {
    for (const [name, profile] of Object.entries(profiles)) {
      status[name] = { active: true, idleTurns: 0, description: profile.description || '' };
    }
    return {
      staticMode: true,
      note: 'Static tools mode — every profile is permanently visible; load/unload are no-ops.',
      turnCount: session.turnCount,
      profiles: status,
      available,
      alwaysVisible: [...ALWAYS_VISIBLE_TOOLS],
    };
  }

  for (const name of session.activeProfiles) {
    status[name] = {
      active: true,
      idleTurns: session.turnCount - (session.lastUsed.get(name) || 0),
      description: profiles[name]?.description || '',
    };
  }

  // dev profiles surface as active only while dev mode is on; when off they are
  // absent from status entirely (absence principle — don't announce existence).
  if (devModeActive()) {
    for (const [name, profile] of Object.entries(profiles)) {
      if (isDevProfile(profile)) status[name] = { active: true, idleTurns: 0, description: profile.description || '', devMode: true };
    }
  }

  // List inactive profiles so the agent can discover them without an extra call.
  for (const [name, profile] of Object.entries(profiles)) {
    if (session.activeProfiles.has(name)) continue;
    if (isDevProfile(profile)) continue; // never advertised while inactive
    available.push({
      name,
      description: profile.description || '',
      requiresConfig: profile.requiresConfig || null,
      autoUnload: profile.autoUnload !== false,
      toolCount: Array.isArray(profile.tools) ? profile.tools.length : 0,
    });
  }

  return {
    turnCount: session.turnCount,
    profiles: status,
    available,
    alwaysVisible: [...ALWAYS_VISIBLE_TOOLS],
  };
}

/**
 * Clean up session (disconnect).
 */
function cleanupSession(sessionId) {
  sessions.delete(sessionId);
}

/**
 * Reset all sessions (test use).
 */
function resetAll() {
  sessions.clear();
  _staticMode = false;
}

module.exports = {
   initSession,
   setStaticMode,
   isStaticMode,
   setDevModeChecker,
   getVisibleTools,
   loadProfile,
   unloadProfile,
   ensureToolVisible,
   findProfilesForTool,
   processTurn,
   searchTools,
   getProfileStatus,
   getSessionState,
   cleanupSession,
   resetAll,
   sanitizeSessionId,
   ALWAYS_VISIBLE_TOOLS,
 };
