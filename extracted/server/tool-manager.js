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

// ── State ─────────────────────────────────────────────────────────────────────
// sessionId -> { activeProfiles: Set, turnCount: number, lastUsed: Map<profile, turn> }
const sessions = new Map();

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
    });
  }
  return sessions.get(sessionId);
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

  for (const name of session.activeProfiles) {
    status[name] = {
      active: true,
      idleTurns: session.turnCount - (session.lastUsed.get(name) || 0),
      description: profiles[name]?.description || '',
    };
  }

  return { turnCount: session.turnCount, profiles: status };
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
  cleanupSession,
  resetAll,
};
