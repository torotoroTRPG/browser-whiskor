'use strict';

/**
 * AppRegistry — optional multi-app isolation layer.
 *
 * When appIsolation.enabled is false (default) the registry is a no-op and
 * every caller gets full access — existing behaviour is preserved.
 *
 * When enabled:
 *   • Each registered app has an id, optional token, and access level.
 *   • "public"  apps share data with other public apps (default level).
 *   • "private" apps can only see tabs that were reported by their own extension.
 *
 * Apps identify themselves:
 *   • Extension (WS)  → query param  ?appId=xxx&token=yyy on the WS URL
 *   • HTTP clients    → headers       x-whiskor-app-id / x-whiskor-app-token
 */
class AppRegistry {
  constructor(cfg = {}) {
    this._enabled = cfg.enabled === true;
    this._apps = new Map();
    for (const app of (cfg.apps || [])) {
      if (app.id) {
        this._apps.set(String(app.id), {
          token:  app.token  || '',
          access: app.access === 'private' ? 'private' : 'public',
        });
      }
    }
  }

  get enabled() { return this._enabled; }

  /**
   * Validate an (appId, token) pair.
   * Returns null if valid / isolation disabled, error string if rejected.
   */
  validate(appId, token = '') {
    if (!this._enabled) return null;
    if (!appId)         return null; // no appId = public (unregistered) access
    const app = this._apps.get(String(appId));
    if (!app) return `Unknown appId: "${appId}"`;
    if (app.token && app.token !== token) return `Invalid token for appId: "${appId}"`;
    return null;
  }

  /** Returns true if the given appId is registered as private. */
  isPrivate(appId) {
    if (!this._enabled || !appId) return false;
    return this._apps.get(String(appId))?.access === 'private';
  }

  /**
   * Can the requester (requestAppId) see data belonging to tabAppId?
   *
   * Rules (when isolation is enabled):
   *   • No appId (public/unregistered) → can see public tabs only
   *   • Private app → can only see its own tabs
   *   • Public registered app → can see all public tabs + its own private tabs
   */
  canAccess(requestAppId, tabAppId) {
    if (!this._enabled) return true;
    const reqIsPrivate = this.isPrivate(requestAppId);
    const tabIsPrivate = this.isPrivate(tabAppId);

    if (reqIsPrivate) {
      // Private apps are fully isolated
      return String(requestAppId) === String(tabAppId);
    }
    if (tabIsPrivate) {
      // Private tabs are hidden from everyone except their owner
      return String(requestAppId) === String(tabAppId);
    }
    return true; // both public
  }
}

module.exports = AppRegistry;
