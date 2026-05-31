// ==========================================================================
// browser-whiskor MCP Cheat Sheet
// ==========================================================================
// TypeScript で書かれた MCP ツールのリファレンス兼コピペシート。
// VSCode で開くと型定義による補完が効くので、
// 実際の値を埋めて JSON-RPC 文字列をコピーして使ってください。
//
// 使い方:
//   1. このファイルを VSCode で開く
//   2. 下の CONSTANTS に実際の値を入れる
//   3. 使いたいツールの行にカーソルを合わせて値を編集
//   4. 右側に表示される JSON-RPC 文字列をコピー
//   5. ターミナルに貼り付けて実行 (mcp.ps1 -raw または mcp-shell.py MT モード)
// ==========================================================================

// ── MCP Protocol Types ─────────────────────────────────────────────────────

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
};

type ToolCallArgs = {
  name: string;
  arguments: Record<string, unknown>;
};

// ── Tool Argument Types ────────────────────────────────────────────────────

type TabId = number;
type ProfileName = "debug" | "state-nav" | "delta" | "advanced-actions" | "admin" | "power";

interface GetIndexArgs {
  tabId: TabId;
}

interface GetTextCoordsArgs {
  tabId: TabId;
  search?: string;
  match?: string;
  level?: "words" | "lines" | "blocks" | "all";
  maxResults?: number;
  minScore?: number;
  inViewport?: boolean;
  focusScope?: string;
  includeSuggestions?: boolean;
}

interface GetViewportArgs {
  tabId: TabId;
}

interface GetFrameworkStateArgs {
  tabId: TabId;
  framework?: "auto" | "react" | "vue3" | "vue2" | "angular" | "svelte" | "alpine" | "preact" | "solid" | "dom";
}

interface GetNetworkArgs {
  tabId: TabId;
  filterUrl?: string;
  filterType?: string;
  filterStatus?: number;
  limit?: number;
}

interface GetUiCatalogArgs {
  tabId: TabId;
  search?: string;
  type?: "button" | "link" | "input" | "image";
  disabled?: boolean;
  required?: boolean;
  selector?: string;
  inViewport?: boolean;
  focusScope?: string;
  includeSuggestions?: boolean;
}

interface NavigateToArgs {
  tabId: TabId;
  url: string;
}

interface ClickArgs {
  tabId: TabId;
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  double?: boolean;
  button?: "left" | "right" | "middle";
  timeoutMs?: number;
}

interface TypeTextArgs {
  tabId: TabId;
  text: string;
  selector?: string;
  clear?: boolean;
  pressEnter?: boolean;
  timeoutMs?: number;
}

interface CaptureScreenshotArgs {
  tabId: TabId;
  returnImage?: boolean;
  marks?: boolean;
}

interface RefreshDataArgs {
  tabId: TabId;
  plugins?: string[];
  waitMs?: number;
}

interface LoadProfileArgs {
  profile: ProfileName;
}

interface UnloadProfileArgs {
  profile: ProfileName;
}

interface SearchToolsArgs {
  query?: string;
}

// ── Placeholder Values (ここを実際の値に書き換える) ──────────────────────

const TAB_ID: TabId = 0; // ← get_sessions で取得した値に書き換え
const SEARCH_TEXT = "";  // 例: "ログイン", "送信", "次へ"
const NAV_URL = "";      // 例: "https://example.com/page"
const INPUT_TEXT = "";   // 例: "test@example.com"
const PROFILE: ProfileName = "debug";

// ── Helper: MCP Tool Call Builder ──────────────────────────────────────────

let _callId = 1;
function toolCall(name: string, args: Record<string, unknown>): string {
  const id = _callId++;
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
  return JSON.stringify(req, null, 2);
}

// ── Tool Functions ─────────────────────────────────────────────────────────
// 各関数の戻り値がコピペ可能な JSON-RPC 文字列。
// 型定義により VSCode の補完が効く。

// 1. get_sessions — セッション一覧 (引数不要)
function getSessions() {
  return toolCall("get_sessions", {});
}
// → {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_sessions","arguments":{}}}

// 2. get_index
function getIndex(args: GetIndexArgs) {
  return toolCall("get_index", args);
}
// → getIndex({ tabId: TAB_ID })

// 3. get_text_coords — テキスト座標取得
function getTextCoords(args: GetTextCoordsArgs) {
  return toolCall("get_text_coords", args);
}
// → getTextCoords({ tabId: TAB_ID, search: SEARCH_TEXT })

// 4. get_viewport
function getViewport(args: GetViewportArgs) {
  return toolCall("get_viewport", args);
}

// 5. get_framework_state — フレームワーク状態
function getFrameworkState(args: GetFrameworkStateArgs) {
  return toolCall("get_framework_state", args);
}

// 6. get_network — ネットワーク通信
function getNetwork(args: GetNetworkArgs) {
  return toolCall("get_network", args);
}

// 7. get_ui_catalog — UI 要素一覧
function getUiCatalog(args: GetUiCatalogArgs) {
  return toolCall("get_ui_catalog", args);
}

// 8. navigate_to — ページ移動
function navigateTo(args: NavigateToArgs) {
  return toolCall("navigate_to", args);
}
// → navigateTo({ tabId: TAB_ID, url: NAV_URL })

// 9. click — クリック
function click(args: ClickArgs) {
  return toolCall("click", args);
}
// → click({ tabId: TAB_ID, text: SEARCH_TEXT })
// → click({ tabId: TAB_ID, selector: "#submit-btn" })
// → click({ tabId: TAB_ID, x: 100, y: 200 })

// 10. type_text — テキスト入力
function typeText(args: TypeTextArgs) {
  return toolCall("type_text", args);
}
// → typeText({ tabId: TAB_ID, text: INPUT_TEXT, clear: true })
// → typeText({ tabId: TAB_ID, text: INPUT_TEXT, pressEnter: true })

// 11. capture_screenshot — スクリーンショット
function captureScreenshot(args: CaptureScreenshotArgs) {
  return toolCall("capture_screenshot", args);
}
// → captureScreenshot({ tabId: TAB_ID })
// → captureScreenshot({ tabId: TAB_ID, marks: true })

// 12. refresh_data — データ更新
function refreshData(args: RefreshDataArgs) {
  return toolCall("refresh_data", args);
}
// → refreshData({ tabId: TAB_ID })

// 13. load_profile — プロファイル動的ロード
function loadProfile(args: LoadProfileArgs) {
  return toolCall("load_profile", args);
}
// → loadProfile({ profile: "debug" })

// 14. unload_profile — プロファイルアンロード
function unloadProfile(args: UnloadProfileArgs) {
  return toolCall("unload_profile", args);
}

// 15. search_tools — MCP ツール検索
function searchTools(args: SearchToolsArgs) {
  return toolCall("search_tools", args);
}

// 16. profile_status — プロファイル状態
function profileStatus() {
  return toolCall("profile_status", {});
}

// ── Usage Examples (全パラメーター網羅) ─────────────────────────────────────
// 下の行をコピーしてターミナルに貼り付けて使う。
// 各ツールの全パラメーターを確認したいときは Generate All を参照。

/*
// ── 1. get_sessions (引数なし) ──────────────────────────────────────────────
getSessions()


// ── 2. get_index ────────────────────────────────────────────────────────────
getIndex({ tabId: TAB_ID })


// ── 3. get_text_coords ─────────────────────────────────────────────────────
// 最小:
getTextCoords({ tabId: TAB_ID })

// 全パラメーター:
getTextCoords({
  tabId: TAB_ID,
  search: SEARCH_TEXT,          // 完全一致 (case-insensitive)
  match: "",                    // ファジー検索 (score 0.0-1.0 でソート)
  level: "words",               // "words" | "lines" | "blocks" | "all"
  maxResults: 50,               // 最大件数 (default: 50)
  minScore: 0.1,                // 最小スコア (default: 0.1)
  inViewport: true,             // 表示領域のみ
  focusScope: "[role='dialog']",// CSS セレクタで範囲指定
  includeSuggestions: true,     // 一致なし時の候補表示
})


// ── 4. get_viewport ─────────────────────────────────────────────────────────
getViewport({ tabId: TAB_ID })


// ── 5. get_framework_state ──────────────────────────────────────────────────
// 最小:
getFrameworkState({ tabId: TAB_ID })

// フレームワーク指定:
getFrameworkState({
  tabId: TAB_ID,
  framework: "auto",            // "auto" | "react" | "vue3" | "vue2" | "angular" | "svelte" | "alpine" | "preact" | "solid" | "dom"
})


// ── 6. get_network ─────────────────────────────────────────────────────────
// 最小:
getNetwork({ tabId: TAB_ID })

// 全パラメーター:
getNetwork({
  tabId: TAB_ID,
  filterUrl: "/api/",           // URL 部分一致
  filterType: "fetch",          // "fetch" | "xhr" | "script" | "img" | ...
  filterStatus: 200,            // HTTP ステータスコード
  limit: 100,                   // 最大取得件数 (default: 100)
})


// ── 7. get_ui_catalog ──────────────────────────────────────────────────────
// 最小:
getUiCatalog({ tabId: TAB_ID })

// 全パラメーター:
getUiCatalog({
  tabId: TAB_ID,
  search: "ログイン",            // テキスト/ラベル/プレースホルダ検索
  type: "button",               // "button" | "link" | "input" | "image"
  disabled: false,              // disabled 要素のみ抽出
  required: false,              // required 入力のみ抽出
  selector: ".btn-primary",     // CSS セレクタ部分一致
  inViewport: true,             // 表示領域のみ
  focusScope: "[role='dialog']",// 範囲指定
  includeSuggestions: true,     // 一致なし時の候補表示
})


// ── 8. navigate_to ─────────────────────────────────────────────────────────
navigateTo({
  tabId: TAB_ID,
  url: "https://example.com",   // 完全な URL (プロトコル含む)
})


// ── 9. click ───────────────────────────────────────────────────────────────
// テキスト指定:
click({ tabId: TAB_ID, text: "ログイン" })

// CSS セレクタ指定:
click({ tabId: TAB_ID, selector: "#submit-btn" })

// 座標指定:
click({ tabId: TAB_ID, x: 100, y: 200 })

// 全パラメーター:
click({
  tabId: TAB_ID,
  selector: ".nav-item:first-child",  // CSS セレクタ
  text: "送信",                         // 表示テキスト (部分一致)
  x: 100,                              // 絶対 X 座標
  y: 200,                              // 絶対 Y 座標
  double: false,                        // ダブルクリック
  button: "left",                       // "left" | "right" | "middle"
  timeoutMs: 15000,                     // タイムアウト (default: 15000)
})


// ── 10. type_text ──────────────────────────────────────────────────────────
// 最小:
typeText({ tabId: TAB_ID, text: "user@example.com" })

// 全パラメーター:
typeText({
  tabId: TAB_ID,
  text: "user@example.com",     // 入力するテキスト
  selector: "#email-input",     // ターゲット入力欄 (省略時は現在フォーカス)
  clear: true,                  // 既存内容を消去
  pressEnter: true,             // 入力後に Enter
  timeoutMs: 15000,             // タイムアウト (default: 15000)
})


// ── 11. capture_screenshot ─────────────────────────────────────────────────
// 最小:
captureScreenshot({ tabId: TAB_ID })

// マーク付き:
captureScreenshot({
  tabId: TAB_ID,
  returnImage: true,            // base64 画像データを含める (default: true)
  marks: true,                  // インタラクティブ要素に番号マーカー
})


// ── 12. refresh_data ───────────────────────────────────────────────────────
// 最小:
refreshData({ tabId: TAB_ID })

// プラグイン指定:
refreshData({
  tabId: TAB_ID,
  plugins: ["text-coords", "ui-catalog", "react-fiber"],  // 特定プラグインのみ
  waitMs: 3000,                 // 待機時間 (default: 3000)
})


// ── 13. load_profile ───────────────────────────────────────────────────────
loadProfile({ profile: "debug" })
loadProfile({ profile: "state-nav" })
loadProfile({ profile: "delta" })
loadProfile({ profile: "advanced-actions" })
loadProfile({ profile: "admin" })
loadProfile({ profile: "power" })


// ── 14. unload_profile ─────────────────────────────────────────────────────
unloadProfile({ profile: "debug" })


// ── 15. search_tools ───────────────────────────────────────────────────────
// 全ツール一覧:
searchTools({})

// キーワード検索:
searchTools({ query: "accessibility" })
searchTools({ query: "drag" })
searchTools({ query: "state" })


// ── 16. profile_status (引数なし) ──────────────────────────────────────────
profileStatus()
*/
