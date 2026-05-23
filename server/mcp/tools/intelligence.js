/**
 * server/mcp/tools/intelligence.js
 * INTELLIGENCEカテゴリのMCPツール定義とハンドラ。
 */
'use strict';

module.exports = function registerIntelligenceTools(registry) {
  const tools = [];

  // analyze_click
  tools.push({
    definition: {
      name: 'analyze_click',
      description: 'Dry-run clickability analysis. Returns ClickabilityReport without executing the click.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID' },
          selector: { type: 'string', description: 'CSS selector' },
          text:     { type: 'string', description: 'Visible text of element (partial match, case-insensitive)' },
          x:        { type: 'number', description: 'Absolute X coordinate' },
          y:        { type: 'number', description: 'Absolute Y coordinate' },
          timeoutMs: { type: 'number', description: 'Action timeout in milliseconds' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, {
        type: 'analyze_click',
        selector: args.selector,
        text: args.text,
        x: args.x,
        y: args.y,
      }, args.timeoutMs || 10000);
    },
  });

  // TODO: [リトルエージェント用] 以下のMCPツールの実装と追加をお願いします。
  // 各ツールはARCHITECTURE_INTELLIGENCE_LAYER.mdの仕様に準拠してください。
  // - explain_element: CSS origin + component + causal chain for a selector. Triggers on-demand collection if stale.
  // - why_did_this_change: Causal chains for a selector within a time window.
  // - get_source_file: Returns text content of a CSS or JS file by URL. Uses Source Layer cache; fetches on miss.
  // - detect_site_updates: Returns SOURCE_CHANGED events detected since last session.

  registry.registerTools(tools);
};
