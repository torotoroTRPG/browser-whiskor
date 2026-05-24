/**
 * server/state-visualizer.js
 * 
 * Extended Proposal C: State Graph Visualizer
 * エージェントが辿ったナビゲーション経路や現在のサイト状態を
 * 直感的なASCIIツリーで可視化するためのサーバーモジュール。
 */
'use strict';

const stateStore = require('./state-store');

function generateAsciiGraph(siteVersion, maxNodes = 40) {
  const g = stateStore.getGraph(siteVersion);
  if (!g || !g.nodes || Object.keys(g.nodes).length === 0) {
    return `No state graph found for siteVersion: ${siteVersion}`;
  }

  // Find root (smallest firstSeen)
  let rootNode = null;
  let minFirstSeen = Infinity;
  for (const hash of Object.keys(g.nodes)) {
    const n = g.nodes[hash];
    if (n.firstSeen < minFirstSeen) {
      minFirstSeen = n.firstSeen;
      rootNode = n;
    }
  }

  if (!rootNode) return 'Graph is empty.';

  const visited = new Set();
  const lines = [];
  let nodeCount = 0;

  function truncate(str, maxLen) {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
  }

  function formatNode(node, isRoot = false) {
    const icon = node.pinned ? '◎' : (isRoot ? '●' : '○');
    const label = node.pinnedLabel || node.label || node.title || node.pathname || node.hash.substring(0, 8);
    const tags = node.tags && node.tags.length > 0 ? ` [${node.tags.join(', ')}]` : '';
    return `${icon} ${truncate(label, 40)}${tags}  (${node.pathname})`;
  }

  function renderTree(node, prefix = '', isTail = true, isRoot = false, edgeLabel = null) {
    if (nodeCount >= maxNodes) return;
    
    const hasVisited = visited.has(node.hash);
    visited.add(node.hash);
    nodeCount++;

    let line = prefix;
    if (!isRoot) {
      line += isTail ? '└─ ' : '├─ ';
    }
    
    if (edgeLabel) {
      line += `[${truncate(edgeLabel, 20)}] ──> `;
    }

    if (hasVisited) {
      line += `${formatNode(node)} (already visited)`;
      lines.push(line);
      return; // Stop recursing if already visited (prevent cycle)
    }

    line += formatNode(node, isRoot);
    lines.push(line);

    if (nodeCount >= maxNodes) return;

    // Outgoing edges
    const edgesObj = g.edges[node.hash] || {};
    // Sort edges by confidence or count to show most reliable paths first
    const edges = Object.values(edgesObj).sort((a, b) => b.confidence - a.confidence);

    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (!edge.to || !g.nodes[edge.to]) continue; // Incomplete edge
      
      const childNode = g.nodes[edge.to];
      const isLast = (i === edges.length - 1);
      const childPrefix = prefix + (isRoot ? '' : (isTail ? '   ' : '│  '));
      
      let triggerLabel = edge.trigger || edge.action;
      if (edge.selector) triggerLabel += ` (${edge.selector})`;
      
      renderTree(childNode, childPrefix, isLast, false, triggerLabel);
    }
  }

  lines.push(`State Graph Topology for [${siteVersion}]:\n`);
  renderTree(rootNode, '', true, true, null);

  if (nodeCount >= maxNodes) {
    lines.push(`\n... Graph truncated at ${maxNodes} nodes.`);
  }

  lines.push('\nLegend: ● Root  ○ Visited  ◎ Pinned  (already visited) -> cycle break');

  return lines.join('\n');
}

module.exports = {
  generateAsciiGraph
};
