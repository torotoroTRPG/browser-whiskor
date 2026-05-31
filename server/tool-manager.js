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

  for (const profileName of session.activeProfiles) {
    const tools = getAllToolsForProfile(profileName, profiles, config);
    for (const t of tools) visible.add(t);
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

  // 1. Auto-detect triggers from last tool call or arguments
  if (lastToolCall) {
    const triggerText = `${lastToolCall.name} ${JSON.stringify(lastToolCall.args || '')}`.toLowerCase();
    for (const [name, profile] of Object.entries(profiles)) {
      if (session.activeProfiles.has(name) || name === 'core') continue;
      if (!profile.triggers) continue;

      const matched = profile.triggers.some(t => triggerText.includes(t));
      if (matched) {
        const loadResult = loadProfile(sessionId, name, allTools, config, true);
        if (loadResult.success) {
          results.autoLoaded.push(name);
        }
      }
    }
  }

  // 2. Check idle profiles for auto-unload
  for (const profileName of [...session.activeProfiles]) {
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
   for (const profileName of session.activeProfiles) {
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

  for (const name of session.activeProfiles) {
    status[name] = {
      active: true,
      idleTurns: session.turnCount - (session.lastUsed.get(name) || 0),
      description: profiles[name]?.description || '',
    };
  }

  // List inactive profiles so the agent can discover them without an extra call.
  for (const [name, profile] of Object.entries(profiles)) {
    if (session.activeProfiles.has(name)) continue;
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
}

module.exports = {
   initSession,
   getVisibleTools,
   loadProfile,
   unloadProfile,
   processTurn,
   searchTools,
   getProfileStatus,
   getSessionState,
   cleanupSession,
   resetAll,
   sanitizeSessionId,
   ALWAYS_VISIBLE_TOOLS,
 };
