/**
 * plugin-system.js  –  MAIN world
 * Core PluginRegistry. Loaded first; all adapters/analyzers call
 * window.__SI_REGISTRY__.register(plugin) immediately after this.
 */
'use strict';

(function () {
  if (window.__SI_REGISTRY__) return; // idempotent

  // ─── PluginAPI (passed into each plugin) ──────────────────────────────────
  function makeAPI(registry) {
    return {
      emit(type, payload, realtime = false) {
        window.postMessage({
          __BROWSER_WHISKOR__: true,
          type,
          payload,
          realtime: !!realtime,
          siteVersion: window.__SI_VERSION__?.id
        }, '*');
      },
      getConfig() { return registry._config; },
      getLastInteraction() { return registry._lastInteraction; },
      log(level, ...args) {
        const entry = { ts: Date.now(), level, args: args.map(String) };
        registry._logs.push(entry);
        if (registry._logs.length > 200) registry._logs.shift();
        if (level === 'error') console.error('[SI]', ...args);
        else if (level === 'warn') console.warn('[SI]', ...args);
        // else: silent in production
      },
      onActivationChange(cb) {
        registry._activationListeners.push(cb);
      },
    };
  }

  // ─── PluginRegistry ───────────────────────────────────────────────────────
  class PluginRegistry {
    constructor() {
      this._plugins = new Map();         // id → plugin
      this._installed = new Set();       // installed ids
      this._config = {
        mode: 'always_on',
        plugins: {},
        options: {
          textCoords: { level: 'word', includeHidden: false, includeOffscreen: false, maxWords: 5000 },
          network:    { captureBody: true, bodyMaxLength: 500, captureTokens: true },
          react:      { maxDepth: 60, maxProps: 30, maxHooks: 20 },
        },
      };
      this._logs = [];
      this._activationListeners = [];
      this._api = makeAPI(this);
      this._lastInteraction = null;

      this._initInteractionTracker();
    }

    _initInteractionTracker() {
      const handler = (e) => {
        this._lastInteraction = {
          type: e.type,
          target: e.target?.tagName,
          id: e.target?.id,
          text: e.target?.innerText?.slice(0, 50),
          ts: Date.now()
        };
      };
      window.addEventListener('click', handler, true);
      window.addEventListener('keydown', handler, true);
    }

    // Register a plugin (called immediately by each adapter/analyzer file)
    register(plugin) {
      if (this._plugins.has(plugin.id)) return;
      this._plugins.set(plugin.id, plugin);
    }

    // Called once in collector.js — installs all enabled plugins
    installAll() {
      this._loadStoredConfig().then(() => {
        for (const plugin of this._plugins.values()) {
          if (this._isEnabled(plugin.id)) {
            this._safeInstall(plugin);
          }
        }
      });
    }

    // Called at DOMContentLoaded / load events
    runAt(event) {
      const eligible = [...this._plugins.values()]
        .filter(p => p.runAt === event && this._isEnabled(p.id))
        .sort((a, b) => (a.priority || 50) - (b.priority || 50));
      for (const plugin of eligible) {
        this._safeCollect(plugin);
      }
    }

    // External: toggle a plugin on/off
    enable(id)  { this._config.plugins[id] = true;  this._notifyActivation(id, true); }
    disable(id) { this._config.plugins[id] = false; this._notifyActivation(id, false); }

    // Force-run a specific plugin now (manual mode)
    runPlugin(id) {
      const plugin = this._plugins.get(id);
      if (plugin) this._safeCollect(plugin);
    }

    // Called when CONFIG_UPDATE arrives from bridge
    updateConfig(newConfig) {
      const prevMode = this._config.mode;
      this._config = { ...this._config, ...newConfig,
        options: { ...this._config.options, ...(newConfig.options || {}) },
        plugins: { ...this._config.plugins, ...(newConfig.plugins || {}) },
      };
      // Install any newly-enabled plugins (regardless of runAt)
      for (const plugin of this._plugins.values()) {
        if (this._isEnabled(plugin.id)) {
          this._safeInstall(plugin);
        }
      }
      if (newConfig.mode !== prevMode) {
        for (const cb of this._activationListeners) {
          try { cb(newConfig.mode !== 'off'); } catch (_) {}
        }
      }
    }

    // Debug helper: call window.__SI_REGISTRY__.debug() in DevTools
    debug() {
      return {
        installedPlugins: [...this._installed],
        registeredPlugins: [...this._plugins.keys()],
        config: this._config,
        lastLog: this._logs.slice(-5),
      };
    }

    // ── Private ───────────────────────────────────────────────────────────
    _isEnabled(id) {
      if (this._config.mode === 'off') return false;
      if (this._config.mode === 'always_on') return true;
      // manual / api / selective: per-plugin flag (default true)
      return this._config.plugins[id] !== false;
    }

    _safeInstall(plugin) {
      if (this._installed.has(plugin.id)) return;
      try {
        plugin.install?.(this._api);
        this._installed.add(plugin.id);
      } catch (err) {
        this._api.log('error', `Plugin ${plugin.id} install failed:`, err);
      }
    }

    _safeCollect(plugin) {
      try {
        const result = plugin.collect(this._api);
        if (result instanceof Promise) {
          result
            .then(data => { if (data != null) this._api.emit(plugin.emitType, data, plugin.realtime); })
            .catch(err => this._api.log('error', `Plugin ${plugin.id} collect async failed:`, err));
        } else if (result != null) {
          this._api.emit(plugin.emitType, result, plugin.realtime);
        }
      } catch (err) {
        this._api.log('error', `Plugin ${plugin.id} collect failed:`, err);
      }
    }

    async _loadStoredConfig() {
      // bridge.js relays storage to MAIN world via postMessage;
      // on first load, we also try reading from sessionStorage as a fast path
      try {
        const raw = window.sessionStorage?.getItem('__SI_CONFIG__');
        if (raw) this.updateConfig(JSON.parse(raw));
      } catch (_) {
        console.warn('[SI] sessionStorage not available, using default config');
      }
      return Promise.resolve();
    }

    _notifyActivation(id, enabled) {
      // no-op for now; individual plugins may listen via onActivationChange
    }
  }

  window.__SI_REGISTRY__ = new PluginRegistry();
  window.__SI_LOGS__ = window.__SI_REGISTRY__._logs; // shortcut for devtools
})();
