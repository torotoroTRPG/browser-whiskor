/**
 * server/mcp/prompts.js
 * MCP prompts プリミティブ — 定型ワークフローのプロンプトテンプレート。
 *
 * MCP の prompts は「ユーザーが起動する定型タスク」を宣言するためのもの。
 * browser-whiskor の典型的な使い方（タブ調査・エラー調査・要素操作・変化の
 * 説明・ステートマップ）を、実在するツール名つきの指示文として公開する。
 * これにより MCP クライアント（LobeHub 含む）が prompts capability を
 * 認識でき、エージェントは「何から呼べばいいか」の足場を得られる。
 *
 * データ依存はゼロ（純粋にテンプレート展開のみ）なので proxy / standalone の
 * どちらのモードでも同一に動く。
 */
'use strict';

// 各プロンプト: { name, description, arguments[], build(args) -> messages[] }
// arguments は MCP の prompts/list 用メタ。build は prompts/get で本文を組む。
const PROMPTS = [
  {
    name: 'investigate_tab',
    description: 'Survey a browser tab end to end: framework state, UI catalog, text coordinates and network, then summarize what the page is and its key interactive elements.',
    arguments: [
      { name: 'tabId', description: 'Target tab id. Omit to use the most recent session (call get_sessions first).', required: false },
    ],
    build(args) {
      const tab = args.tabId ? `tab ${args.tabId}` : 'the most recent tab (use get_sessions to find its tabId)';
      return [text(
        `Investigate ${tab} using browser-whiskor. Steps:\n` +
        `1. get_sessions to confirm the target tabId and that it has data.\n` +
        `2. get_index for a high-level map of what was collected.\n` +
        `3. get_framework_state, get_ui_catalog, and get_text_coords to understand the page.\n` +
        `4. get_network for recent requests if behaviour depends on data.\n` +
        `Then summarize: what this page is, its main interactive elements (with how to target them), and anything that looks broken or noteworthy.`
      )];
    },
  },
  {
    name: 'debug_errors',
    description: 'Hunt for errors on a tab: console logs plus failed/slow network requests, and explain the likely cause.',
    arguments: [
      { name: 'tabId', description: 'Target tab id. Omit to use the most recent session.', required: false },
    ],
    build(args) {
      const tab = args.tabId ? `tab ${args.tabId}` : 'the most recent tab (use get_sessions to find its tabId)';
      return [text(
        `Find and explain errors on ${tab}.\n` +
        `1. get_console_logs and look for error/warning entries (this auto-loads the debug profile).\n` +
        `2. get_network and flag any non-2xx responses or unusually slow requests.\n` +
        `3. If a UI change preceded the error, get_delta and why_did_this_change to correlate.\n` +
        `Report the most likely root cause and the evidence behind it — do not guess beyond what the data shows.`
      )];
    },
  },
  {
    name: 'find_and_act',
    description: 'Locate a target by its visible text and act on it (click by default), resolving ambiguity before acting.',
    arguments: [
      { name: 'target', description: 'Visible text or label of the element to act on.', required: true },
      { name: 'action', description: 'What to do: click (default), type, or hover.', required: false },
      { name: 'value', description: 'Text to enter when action is type.', required: false },
    ],
    build(args) {
      const action = (args.action || 'click').toLowerCase();
      const valueLine = action === 'type' && args.value
        ? ` Then type_text with the value ${JSON.stringify(args.value)}.`
        : '';
      return [text(
        `Find the element with text "${args.target}" and ${action} it.\n` +
        `1. find_target with that text to rank candidates (kind, viewport, reachability and text match are weighed for you).\n` +
        `2. If more than one strong candidate exists, disambiguate (capture_screenshot or capture_packed_som) before acting.\n` +
        `3. Perform the ${action}, preferring the highest-ranked target.${valueLine}\n` +
        `Confirm the action by observing the resulting state change rather than assuming it worked.`
      )];
    },
  },
  {
    name: 'explain_change',
    description: 'Explain what changed on the page and why, using the delta and causal-correlation tools.',
    arguments: [
      { name: 'description', description: 'What you observed changing (optional but helps focus the search).', required: false },
    ],
    build(args) {
      const focus = args.description ? ` Focus on: ${args.description}.` : '';
      return [text(
        `Explain the most recent change on the active tab.${focus}\n` +
        `1. get_delta for the aggregated recent changes.\n` +
        `2. why_did_this_change to correlate the UI change with the network/state events that likely caused it.\n` +
        `3. If a specific element is involved, explain_element for its source-level story.\n` +
        `Give a concise cause-and-effect explanation grounded in the observed events.`
      )];
    },
  },
  {
    name: 'map_states',
    description: 'Render the recorded UI state graph for a tab and describe the reachable states and how to navigate between them.',
    arguments: [
      { name: 'tabId', description: 'Target tab id. Omit to use the most recent session.', required: false },
    ],
    build(args) {
      const tab = args.tabId ? `tab ${args.tabId}` : 'the most recent tab (use get_sessions to find its tabId)';
      return [text(
        `Map the UI states recorded for ${tab}.\n` +
        `1. get_state_map (or get_state_map_visual for an ASCII rendering) to see the graph.\n` +
        `2. list_states / search_states to identify the meaningful states by label and tags.\n` +
        `3. For a chosen destination, get_navigation_path to show the action sequence that reaches it.\n` +
        `Summarize the key states and the paths between them.`
      )];
    },
  },
];

function text(body) {
  return { role: 'user', content: { type: 'text', text: body } };
}

// prompts/list payload — definitions only (name/description/arguments).
function listPrompts() {
  return PROMPTS.map(({ name, description, arguments: args }) => ({
    name,
    description,
    arguments: args || [],
  }));
}

// prompts/get payload for one prompt. Throws on unknown name or a missing
// required argument so the transport can surface a JSON-RPC error.
function getPrompt(name, args = {}) {
  const prompt = PROMPTS.find(p => p.name === name);
  if (!prompt) {
    const err = new Error(`Unknown prompt: ${name}. Available: ${PROMPTS.map(p => p.name).join(', ')}`);
    err.code = -32602;
    throw err;
  }
  for (const a of prompt.arguments || []) {
    if (a.required && (args[a.name] === undefined || args[a.name] === '')) {
      const err = new Error(`Prompt "${name}" requires argument "${a.name}".`);
      err.code = -32602;
      throw err;
    }
  }
  return {
    description: prompt.description,
    messages: prompt.build(args || {}),
  };
}

module.exports = { listPrompts, getPrompt, PROMPTS };
