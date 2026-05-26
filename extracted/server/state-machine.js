/**
 * server/state-machine.js
 *
 * Backward-compatible wrapper for state-store.js.
 * All existing callers (index.js, mcp-server.js) continue to work.
 */
'use strict';

const store = require('./state-store');

module.exports = {
  addNode: function(siteVersion, data) {
    return store.addNode(siteVersion, data);
  },
  addEdge: function(siteVersion, data) {
    return store.addEdge(siteVersion, data);
  },
  getGraph: function(siteVersion) {
    return store.getGraph(siteVersion);
  },
  getAllGraphs: function() {
    return store.getAllGraphs();
  },
  getUnvisitedActions: function(siteVersion, fromHash, uiCatalog) {
    return store.getUnvisitedActions(siteVersion, fromHash, uiCatalog);
  },
  // Expose new store for direct access
  store: store,
};
