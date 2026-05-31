#!/usr/bin/env python3
"""
browser-whiskor MCP Interactive Shell

人間が AI の席に座って MCP プロトコルを直接操作するための対話型シェル。

2つのモード:
  MT (Manual Transmission)  — 生の JSON-RPC をそのまま表示。AI が受け取るのと全く同じデータ。
  AT (Auto Transmission)    — ツール名・引数を補完表示。整形出力＋入力支援。

使い方:
  # サーバーが起動していない場合 (シェルが自動起動):
  python manual/mcp-shell.py

  # サーバーが既に起動している場合 (プロキシモード):
  python manual/mcp-shell.py --proxy http://localhost:7892

  # MT モードで起動:
  python manual/mcp-shell.py --mode mt
"""
import sys
import json
import subprocess
import shlex
import os
import time
import threading
import signal
from pathlib import Path
from typing import Optional




VERSION = "1.0.0"
MCP_SERVER_CMD = ["node", "server/index.js", "--mcp"]

# ── ANSI colors ─────────────────────────────────────────────────────────────────
class C:
    CYAN    = "\033[96m"
    GREEN   = "\033[92m"
    YELLOW  = "\033[93m"
    RED     = "\033[91m"
    MAGENTA = "\033[95m"
    BLUE    = "\033[94m"
    BOLD    = "\033[1m"
    DIM     = "\033[2m"
    RESET   = "\033[0m"
    CLEAR   = "\033[2J\033[H"

# ── MCP Protocol Client ────────────────────────────────────────────────────────
class McpClient:
    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self.reader_thread: Optional[threading.Thread] = None
        self._pending: dict[int, dict] = {}
        self._next_id = 1
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._running = True
        self.tools: list[dict] = []
        self.server_info: dict = {}

    def start(self):
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        self.proc = subprocess.Popen(
            MCP_SERVER_CMD,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            env=env,
        )
        # reader thread: reads stdout line by line
        self.reader_thread = threading.Thread(target=self._reader, daemon=True)
        self.reader_thread.start()
        # stderr reader (for logs)
        stderr_thread = threading.Thread(target=self._stderr_reader, daemon=True)
        stderr_thread.start()
        # Initialize
        self._initialize()

    def _reader(self):
        while self._running and self.proc and self.proc.stdout:
            try:
                line = self.proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                msg = json.loads(line)
                with self._cond:
                    rid = msg.get("id")
                    if rid is not None and rid in self._pending:
                        self._pending[rid] = msg
                        self._cond.notify_all()
                    elif "method" in msg:
                        # server-initiated request (unlikely for this server)
                        pass
            except (json.JSONDecodeError, EOFError):
                break
            except (UnicodeDecodeError, ValueError):
                continue

    def _stderr_reader(self):
        while self._running and self.proc and self.proc.stderr:
            try:
                line = self.proc.stderr.readline()
                if not line:
                    break
            except (UnicodeDecodeError, ValueError):
                continue

    def _send(self, msg: dict) -> dict:
        rid = msg.get("id")
        with self._lock:
            self._pending[rid] = None
        payload = json.dumps(msg, ensure_ascii=False)
        if self.proc and self.proc.stdin:
            self.proc.stdin.write(payload + "\n")
            self.proc.stdin.flush()
        with self._cond:
            self._cond.wait_for(lambda: self._pending.get(rid) is not None, timeout=30)
            result = self._pending.pop(rid, None)
            return result or {"error": "timeout"}

    def _initialize(self):
        resp = self._send({
            "jsonrpc": "2.0", "id": self._next_id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "clientInfo": {"name": "mcp-shell", "version": VERSION},
            },
        })
        self._next_id += 1
        self.server_info = resp.get("result", {})
        # initialized notification
        self._send_no_wait({"jsonrpc": "2.0", "method": "notifications/initialized"})
        # fetch tools
        self.list_tools()

    def _send_no_wait(self, msg: dict):
        payload = json.dumps(msg, ensure_ascii=False)
        if self.proc and self.proc.stdin:
            self.proc.stdin.write(payload + "\n")
            self.proc.stdin.flush()

    def list_tools(self):
        resp = self._send({
            "jsonrpc": "2.0", "id": self._next_id,
            "method": "tools/list", "params": {},
        })
        self._next_id += 1
        self.tools = resp.get("result", {}).get("tools", [])
        return self.tools

    def call_tool(self, name: str, args: dict) -> dict:
        resp = self._send({
            "jsonrpc": "2.0", "id": self._next_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": args},
        })
        self._next_id += 1
        return resp

    def close(self):
        self._running = False
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


# ── HTTP Proxy Client ──────────────────────────────────────────────────────────
class HttpProxyClient:
    """Connect to an already-running server via HTTP API proxy."""
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.tools = []

    def _api(self, method: str, path: str, body: dict = None) -> dict:
        import urllib.request
        import urllib.error
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return {"error": f"HTTP {e.code}: {e.read().decode()[:200]}"}
        except Exception as e:
            return {"error": str(e)}

    def list_tools(self):
        # We can't get the full MCP tool list via HTTP, but we can get sessions
        sessions = self._api("GET", "/api/sessions")
        return sessions

    def call_tool(self, name: str, args: dict) -> dict:
        if name == "get_sessions":
            return {"result": self._api("GET", "/api/sessions")}
        if name == "capture_screenshot":
            return {"result": self._api("POST", "/api/screenshot", {"tabId": args.get("tabId"), "marks": args.get("marks")})}
        # Generic: POST /api/action with tool name
        tab_id = args.pop("tabId", None)
        action = {"type": name, **args}
        result = self._api("POST", "/api/action", {"tabId": tab_id, "action": action})
        return {"result": result}

    def close(self):
        pass


# ── Interactive Shell ──────────────────────────────────────────────────────────
class McpShell:
    def __init__(self, client: McpClient | HttpProxyClient, mode: str = "at"):
        self.client = client
        self.mode = mode.lower()  # "mt" or "at"
        self.running = True
        self.history: list[str] = []

    def run(self):
        print(f"{C.CLEAR}{C.BOLD}browser-whiskor MCP Interactive Shell v{VERSION}{C.RESET}")
        print(f"{C.DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{C.RESET}")
        print(f"  {C.CYAN}MT{C.RESET} (Manual) — 生の JSON-RPC をそのまま表示")
        print(f"  {C.GREEN}AT{C.RESET} (Auto)   — 全情報表示 + 整形（内容は同一）")
        print(f"{C.DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{C.RESET}")

        # Show tool count + server info
        try:
            tools = self.client.list_tools()
            count = len(tools) if isinstance(tools, list) else (tools.get("count", "?") if isinstance(tools, dict) else "?")
            print(f"  Connected — {C.BOLD}{count}{C.RESET} tools available")
            if self.mode == "mt":
                self._show_server_info_raw()
            else:
                self._show_server_info()
        except Exception as e:
            print(f"  {C.RED}Warning: {e}{C.RESET}")

        print(f"{C.DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{C.RESET}")
        print(f"  {C.YELLOW}help{C.RESET} コマンド一覧  |  {C.YELLOW}mode mt{C.RESET} / {C.YELLOW}mode at{C.RESET} モード切替")
        print(f"  {C.YELLOW}tools{C.RESET} ツール一覧  |  {C.YELLOW}server{C.RESET} 接続情報  |  {C.YELLOW}profiles{C.RESET} プロファイル")
        print(f"  {C.YELLOW}call <name> <json-args>{C.RESET} 呼び出し (MT)")
        print(f"  {C.YELLOW}<name> <key=val ...>{C.RESET} 簡易呼び出し (AT)")
        print(f"  {C.YELLOW}[Enter]{C.RESET} ピッカー表示 (AT)  —  番号選択 or 入力で絞り込み")
        print(f"  {C.YELLOW}exit{C.RESET} / {C.YELLOW}Ctrl+C{C.RESET} 終了")
        print(f"  {C.DIM}AI の標準フロー: get_sessions → tabId 取得 → 各ツールに tabId=... を渡す{C.RESET}")
        print()

        while self.running:
            try:
                prompt = f"{C.MAGENTA}mcp{C.RESET} {self._mode_indicator()}> "
                line = input(prompt).strip()
                if not line:
                    if self.mode == "at":
                        self._run_picker()
                    continue
                self.history.append(line)
                self._dispatch(line)
            except (EOFError, KeyboardInterrupt):
                print()
                self._cmd_exit()
                break

    def _mode_indicator(self) -> str:
        return f"{C.CYAN}MT{C.RESET}" if self.mode == "mt" else f"{C.GREEN}AT{C.RESET}"

    def _dispatch(self, line: str):
        parts = shlex.split(line)
        cmd = parts[0].lower()

        if cmd in ("exit", "quit", "q"):
            self._cmd_exit()
        elif cmd == "help":
            if len(parts) > 1:
                self._cmd_tool_help(parts[1])
            else:
                self._cmd_help()
        elif cmd == "mode":
            self._cmd_mode(parts)
        elif cmd == "tools":
            self._cmd_tools()
        elif cmd == "call":
            self._cmd_call(parts[1:])
        elif cmd in ("server", "info"):
            self._cmd_server()
        elif cmd in ("profiles",):
            self._cmd_profiles()
        elif cmd in ("load-profile", "load"):
            self._cmd_load_profile(parts)
        elif cmd in ("unload-profile", "unload"):
            self._cmd_unload_profile(parts)
        elif cmd in ("mt", "manual"):
            self.mode = "mt"
            print(f"  → {C.CYAN}MT (Manual) モード{C.RESET}")
        elif cmd in ("at", "auto"):
            self.mode = "at"
            print(f"  → {C.GREEN}AT (Auto) モード{C.RESET}")
        else:
            # --help / -h は shell-only の人間用便利機能（AI 未実装）
            if len(parts) > 1 and parts[-1].lower() in ("--help", "-h"):
                self._cmd_tool_help(cmd)
                return
            self._cmd_tool_invoke(cmd, parts[1:])

    def _cmd_help(self):
        print(f"""
  {C.BOLD}Commands:{C.RESET}
    {C.GREEN}help{C.RESET}                    このヘルプ
    {C.GREEN}mode mt{C.RESET} / {C.GREEN}mode at{C.RESET}      モード切替 (MT=生JSON, AT=整形)
    {C.GREEN}tools{C.RESET}                   ツール一覧
    {C.GREEN}server{C.RESET}                  接続情報 (initialize 応答)
    {C.GREEN}profiles{C.RESET}                プロファイル状態
    {C.GREEN}load-profile <name>{C.RESET}     プロファイル動的ロード
    {C.GREEN}unload-profile <name>{C.RESET}   プロファイルアンロード
    {C.GREEN}call <name> <json>{C.RESET}      ツール呼び出し (MT: 生JSON引数)
    {C.GREEN}<name> <key=val ...>{C.RESET}    ツール呼び出し (AT: key=value形式)
    {C.GREEN}<name>{{}}{C.RESET}               引数なしツールの呼び出し
    {C.GREEN}[Enter]{C.RESET}                 ピッカー表示 (番号選択, 文字絞り込み, q=戻る)
    {C.GREEN}exit{C.RESET}                    終了

  {C.BOLD}Examples:{C.RESET}
    {C.DIM}# 接続情報を見る (AT→整形, MT→生JSON){C.RESET}
    server

    {C.DIM}# AT モード: [Enter] で対話型ピッカー起動{C.RESET}
    {C.DIM}# 番号 > Enter で選択、文字入力で絞り込み、q で戻る{C.RESET}

    {C.DIM}# プロファイル操作 (ロード/アンロード後、ツール一覧自動更新){C.RESET}
    profiles
    load-profile debug
    load-profile state-nav
    unload-profile debug

    {C.DIM}# MT モード: 生 JSON-RPC リクエスト/レスポンスがそのまま見える{C.RESET}
    call get_sessions {{}}

    {C.DIM}# AT モード: 引数を key=val で指定、結果は整形表示{C.RESET}
    get_text_coords tabId=1666822684 search=ログイン

    {C.DIM}# 引数なしツール{C.RESET}
    get_sessions
""")

    def _cmd_mode(self, parts):
        if len(parts) < 2:
            print(f"  {C.YELLOW}Usage:{C.RESET} mode <mt|at|manual|auto>")
            return
        mode = parts[1].lower()
        if mode in ("mt", "manual"):
            self.mode = "mt"
            print(f"  → {C.CYAN}MT (Manual Transmission) モード{C.RESET}")
            print(f"  {C.DIM}生の JSON-RPC リクエスト/レスポンスをそのまま表示します。{C.RESET}")
        elif mode in ("at", "auto"):
            self.mode = "at"
            print(f"  → {C.GREEN}AT (Auto Transmission) モード{C.RESET}")
            print(f"  {C.DIM}ツール名と引数を key=value 形式で入力してください。{C.RESET}")

    def _cmd_tools(self):
        tools = self.client.tools if hasattr(self.client, "tools") and self.client.tools else self.client.list_tools()
        if not tools:
            print(f"  {C.YELLOW}No tools available{C.RESET}")
            return
        print(f"  {C.BOLD}{len(tools)} tools registered:{C.RESET}")
        by_category = {
            "READ": [], "WRITE": [], "CAPTURE": [],
            "CONTROL": [], "INTELLIGENCE": [], "REPLAY": [],
        }
        others = []
        for t in tools:
            name = t.get("name", t.get("id", "?"))
            desc = t.get("description", "")[:60]
            found = False
            for cat in by_category:
                if name.startswith(cat.lower()[:-1]) or any(kw in desc for kw in [cat.title(), cat]):
                    by_category[cat].append((name, desc))
                    found = True
                    break
            if not found:
                others.append((name, desc))
        for cat, items in by_category.items():
            if items:
                print(f"\n  {C.BOLD}{cat}:{C.RESET}")
                for name, desc in items:
                    print(f"    {C.GREEN}{name}{C.RESET}  {C.DIM}{desc}{C.RESET}")
        if others:
            print(f"\n  {C.BOLD}Other:{C.RESET}")
            for name, desc in others:
                print(f"    {C.GREEN}{name}{C.RESET}  {C.DIM}{desc}{C.RESET}")
        print()

    def _show_tool_categories(self, tools):
        if not tools:
            return
        counts: dict[str, int] = {}
        for t in tools:
            name = t.get("name", "")
            desc = t.get("description", "")
            for cat in ("READ", "WRITE", "CAPTURE", "CONTROL", "INTELLIGENCE", "REPLAY"):
                if cat.lower() in name.lower() or cat.lower() in desc.lower()[:20]:
                    counts[cat] = counts.get(cat, 0) + 1
                    break
            else:
                counts["OTHER"] = counts.get("OTHER", 0) + 1
        parts = [f"  {C.BOLD}{k}: {v}{C.RESET}" for k, v in sorted(counts.items())]
        if parts:
            print("".join(parts))

    # ── Interactive Tool Picker ──────────────────────────────────────────────
    @staticmethod
    def _get_key() -> str:
        import os as _os
        if _os.name == 'nt':
            import msvcrt as _m
            ch = _m.getch()
            if ch == b'\xe0':
                ch2 = _m.getch()
                return {b'H': 'UP', b'P': 'DOWN', b'K': 'LEFT', b'M': 'RIGHT'}.get(ch2, 'UNKNOWN')
            if ch in (b'\r', b'\n'):
                return 'ENTER'
            if ch == b'\x1b':
                return 'ESC'
            if ch in (b'\x08', b'\x7f'):
                return 'BS'
            try:
                return chr(ch[0])
            except (IndexError, ValueError):
                return 'UNKNOWN'
        else:
            import tty as _tty, termios as _tm
            fd = sys.stdin.fileno()
            old = _tm.tcgetattr(fd)
            try:
                _tty.setraw(fd)
                ch = sys.stdin.read(1)
                if ch == '\x1b':
                    seq = sys.stdin.read(2)
                    return {'[A': 'UP', '[B': 'DOWN', '[C': 'RIGHT', '[D': 'LEFT'}.get(seq, 'ESC')
                if ch in ('\r', '\n'):
                    return 'ENTER'
                if ch == '\x7f':
                    return 'BS'
                return ch
            finally:
                _tm.tcsetattr(fd, _tm.TCSADRAIN, old)

    def _run_picker(self):
        tools = self.client.tools
        if not tools:
            print(f"  {C.YELLOW}No tools available. Try loading a profile.{C.RESET}")
            return

        import shutil as _sh
        cols = _sh.get_terminal_size().columns
        page = 18

        # Build filtered list (interactive filter loop)
        filt = ""
        while True:
            filtered = [t for t in tools if not filt or filt.lower() in t.get("name", "").lower() or filt.lower() in t.get("description", "").lower()]
            if not filtered and not filt:
                print(f"  {C.YELLOW}No tools available.{C.RESET}")
                return

            # Render
            print(f"\n  {C.BOLD}━━━ Tool Picker (type to filter, or #Enter to select, q=quit) ━━━{C.RESET}")
            for i, t in enumerate(filtered[:page]):
                name = t.get("name", "?")
                desc = t.get("description", "")[:cols - len(name) - 12]
                print(f"  {C.CYAN}[{i+1}]{C.RESET}  {C.GREEN}{name}{C.RESET}  {C.DIM}{desc}{C.RESET}")
            if len(filtered) > page:
                print(f"  {C.DIM}... {len(filtered) - page} more (type to narrow){C.RESET}")
            if filt:
                print(f"  {C.DIM}filter: {filt}  ({len(filtered)} tools){C.RESET}")
            print()

            raw = input(f"  {C.DIM}pick #, type filter, or q:{C.RESET} ").strip()
            if not raw:
                continue
            if raw.lower() == 'q':
                print(f"  {C.DIM}cancelled{C.RESET}")
                break
            if raw.isdigit():
                idx = int(raw) - 1
                if 0 <= idx < len(filtered):
                    name = filtered[idx].get("name", "")
                    sel_desc = filtered[idx].get("description", "")
                    print(f"  {C.GREEN}▸{C.RESET} {C.BOLD}{name}{C.RESET}  {C.DIM}{sel_desc[:70]}{C.RESET}")
                    args_line = input(f"  {C.DIM}args (key=val ...):{C.RESET} ").strip()
                    args = {}
                    if args_line:
                        for p in shlex.split(args_line):
                            if "=" in p:
                                k, v = p.split("=", 1)
                                try:
                                    if v.lower() == "true": v = True
                                    elif v.lower() == "false": v = False
                                    elif v.isdigit(): v = int(v)
                                    elif "." in v and all(p2.isdigit() or p2 == "." for p2 in v.split(".")): v = float(v)
                                    else:
                                        try: v = json.loads(v)
                                        except: pass
                                except: pass
                                args[k] = v
                    if args_line or not filtered[idx].get("inputSchema", {}).get("properties"):
                        self._do_call(name, args)
                    else:
                        print(f"  {C.YELLOW}Requires args:{C.RESET} {', '.join(filtered[idx].get('inputSchema',{}).get('properties',{}).keys())}")
                    print()
                    break
                else:
                    print(f"  {C.YELLOW}Invalid: {raw}{C.RESET}")
            else:
                filt = raw

    def _cmd_call(self, parts):
        if len(parts) < 1:
            print(f"  {C.YELLOW}Usage:{C.RESET} call <tool_name> [<json_args>]")
            return
        name = parts[0]
        args = {}
        if len(parts) > 1:
            raw = " ".join(parts[1:])
            try:
                args = json.loads(raw)
            except json.JSONDecodeError:
                print(f"  {C.RED}Invalid JSON: {raw}{C.RESET}")
                return
        self._do_call(name, args)

    def _cmd_tool_help(self, name: str):
        tools = self.client.tools
        tool = None
        for t in tools:
            if t.get("name", "").lower() == name.lower():
                tool = t
                break
        if not tool:
            for t in tools:
                if name.lower() in t.get("name", "").lower():
                    tool = t
                    break
        if not tool:
            print(f"  {C.YELLOW}Unknown tool: {name}{C.RESET}")
            return
        tname = tool.get("name", "?")
        tdesc = tool.get("description", "")
        schema = tool.get("inputSchema", {})
        props = schema.get("properties", {})
        required = schema.get("required", [])
        print(f"\n  {C.BOLD}{tname}{C.RESET}")
        if tdesc:
            print(f"  {C.DIM}{tdesc}{C.RESET}")
        print(f"  {C.DIM}━━━ inputSchema (AI equivalent of --help) ━━━{C.RESET}")
        print(json.dumps(schema, indent=2, ensure_ascii=False))
        if props:
            print(f"\n  {C.BOLD}Required:{C.RESET} {', '.join(required) if required else '(none)'}")
            print(f"  {C.BOLD}Params:{C.RESET}")
            for pname, pinfo in props.items():
                ptype = pinfo.get("type", "any")
                pdesc = pinfo.get("description", "")
                print(f"    {C.GREEN}{pname}{C.RESET}  {C.DIM}<{ptype}>{C.RESET}  {pdesc}")
        # Flow hint
        if "tabId" in props:
            print(f"  {C.DIM}Flow:{C.RESET} call get_sessions → use returned tabId")
        print()

    def _cmd_tool_invoke(self, name: str, parts: list[str]):
        args = {}
        for p in parts:
            if "=" in p:
                k, v = p.split("=", 1)
                # Try to parse as number, boolean, or JSON
                try:
                    if v.lower() == "true":
                        v = True
                    elif v.lower() == "false":
                        v = False
                    elif v.isdigit():
                        v = int(v)
                    elif "." in v and all(p2.isdigit() or p2 == "." for p2 in v.split(".")):
                        v = float(v)
                    else:
                        try:
                            v = json.loads(v)
                        except (json.JSONDecodeError, ValueError):
                            pass
                except:
                    pass
                args[k] = v
            else:
                # positional: try to find the first required param from tool schema
                args[p] = p
        self._do_call(name, args)

    def _do_call(self, name: str, args: dict):
        if self.mode == "mt":
            self._call_mt(name, args)
        else:
            self._show_mcp_state()
            self._call_at(name, args)

    def _show_mcp_state(self):
        try:
            resp = self.client.call_tool("profile_status", {})
            if "error" in resp:
                return
            content = resp.get("result", {}).get("content", [])
            print(f"\n  {C.BOLD}━━━ MCP State (raw — what AI receives) ━━━{C.RESET}")
            for c in content:
                if c.get("type") == "text":
                    raw = c.get("text", "")
                    try:
                        parsed = json.loads(raw)
                        print(json.dumps(parsed, indent=2, ensure_ascii=False))
                    except (json.JSONDecodeError, ValueError):
                        print(raw)
            print(f"  {C.BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{C.RESET}")
        except Exception:
            pass

    def _call_mt(self, name: str, args: dict):
        print(f"\n{C.DIM}───────────────── Request ─────────────────{C.RESET}")
        req = {
            "jsonrpc": "2.0", "id": "N",
            "method": "tools/call",
            "params": {"name": name, "arguments": args},
        }
        print(json.dumps(req, indent=2, ensure_ascii=False))
        print(f"{C.DIM}───────────────── Response ────────────────{C.RESET}")
        try:
            result = self.client.call_tool(name, args)
            if "error" in result:
                print(f"  {C.RED}Error:{C.RESET} {json.dumps(result['error'], indent=2, ensure_ascii=False)}")
            else:
                result_data = result.get("result", {})
                content = result_data.get("content", [])
                if content:
                    for c in content:
                        if c.get("type") == "text":
                            try:
                                parsed = json.loads(c["text"])
                                print(json.dumps(parsed, indent=2, ensure_ascii=False))
                            except (json.JSONDecodeError, KeyError):
                                print(c.get("text", str(c)))
                        else:
                            print(json.dumps(c, indent=2, ensure_ascii=False))
                else:
                    print(json.dumps(result, indent=2, ensure_ascii=False))
            print()
        except Exception as e:
            print(f"  {C.RED}Error:{C.RESET} {e}\n")

    def _call_at(self, name: str, args: dict):
        print(f"\n  {C.CYAN}▶{C.RESET} {C.BOLD}{name}{C.RESET} {C.DIM}{json.dumps(args, ensure_ascii=False)}{C.RESET}")
        try:
            result = self.client.call_tool(name, args)
            if "error" in result:
                print(f"  {C.RED}✗ Error:{C.RESET} {result['error'].get('message', str(result['error']))}")
                print(json.dumps(result, indent=2, ensure_ascii=False))
                print()
                return

            # ── 1. Full raw response (what AI receives) ──────────────
            print(f"  {C.BOLD}━━━ Raw Response (AI view) ━━━{C.RESET}")
            result_data = result.get("result", {})
            content = result_data.get("content", [])
            if content:
                for c in content:
                    raw = c.get("text", "")
                    if raw:
                        try:
                            parsed = json.loads(raw)
                            print(json.dumps(parsed, indent=2, ensure_ascii=False))
                        except (json.JSONDecodeError, ValueError):
                            print(raw)
            else:
                print(json.dumps(result_data, indent=2, ensure_ascii=False))

            # ── 2. Full JSON-RPC envelope ────────────────────────────
            print(f"  {C.BOLD}━━━ JSON-RPC Envelope ━━━{C.RESET}")
            print(json.dumps(result, indent=2, ensure_ascii=False))

            # ── 3. Formatted structure (human help, same data) ───────
            if content:
                for c in content:
                    raw = c.get("text", "")
                    if raw:
                        try:
                            parsed = json.loads(raw)
                            self._print_formatted(parsed)
                        except (json.JSONDecodeError, ValueError):
                            pass
            print()
        except Exception as e:
            print(f"  {C.RED}✗ Error:{C.RESET} {e}\n")

    def _print_formatted(self, data):
        if isinstance(data, list):
            if not data:
                print(f"  {C.DIM}(empty){C.RESET}")
                return
            print(f"  {C.BOLD}[{len(data)} items]{C.RESET}")
            for i, item in enumerate(data[:10]):
                if isinstance(item, dict):
                    label = item.get("title") or item.get("name") or item.get("url") or item.get("text", "")
                    sid = item.get("tabId", item.get("id", ""))
                    line = f"  {C.CYAN}[{i}]{C.RESET}"
                    if sid:
                        line += f" {C.YELLOW}#{sid}{C.RESET}"
                    if label:
                        label_str = str(label)[:80]
                        line += f" {label_str}"
                    print(line)
                else:
                    print(f"  {C.CYAN}[{i}]{C.RESET} {str(item)[:100]}")
            if len(data) > 10:
                print(f"  {C.DIM}... and {len(data) - 10} more{C.RESET}")
        elif isinstance(data, dict):
            # Flatten summary keys
            summary_keys = ["ok", "tabId", "url", "title", "status", "total", "count", "healthy"]
            summary = {k: data.get(k) for k in summary_keys if k in data}
            if summary:
                parts = [f"  {C.GREEN}✓{C.RESET}"]
                for k, v in summary.items():
                    parts.append(f"{C.DIM}{k}:{C.RESET} {v}")
                print(" ".join(parts))
            # Show important nested data
            for key in ["sessions", "tools", "items", "patterns", "states", "nodes"]:
                if key in data and isinstance(data[key], list):
                    print(f"  {C.BOLD}{key}: {len(data[key])} items{C.RESET}")
                    for item in data[key][:5]:
                        label = item.get("title") or item.get("name") or item.get("url") or item.get("text", "")
                        sid = item.get("tabId", item.get("id", ""))
                        line = f"    {C.CYAN}•{C.RESET}"
                        if sid:
                            line += f" {C.YELLOW}#{sid}{C.RESET}"
                        if label:
                            line += f" {str(label)[:70]}"
                        print(line)
                    if len(data[key]) > 5:
                        print(f"    {C.DIM}... and {len(data[key]) - 5} more{C.RESET}")
            # Remaining keys
            shown = set(summary_keys) | {"sessions", "tools", "items", "patterns", "states", "nodes", "content"}
            extra = {k: v for k, v in data.items() if k not in shown and not k.startswith("_")}
            if extra:
                print(f"  {C.DIM}{json.dumps(extra, indent=2, ensure_ascii=False)[:200]}{C.RESET}")
        else:
            print(f"  {json.dumps(data, indent=2, ensure_ascii=False)[:200]}")

    def _show_server_info(self):
        info = self.client.server_info if hasattr(self.client, "server_info") and self.client.server_info else {}
        if not info:
            print(f"  {C.DIM}(no server info){C.RESET}")
            return
        si = info.get("serverInfo", {})
        caps = info.get("capabilities", {})
        proto = info.get("protocolVersion", "?")
        name = si.get("name", "?")
        ver = si.get("version", "?")
        print(f"  {C.BOLD}Server:{C.RESET} {name} v{ver}  {C.DIM}(protocol {proto}){C.RESET}")
        if caps:
            cap_list = ", ".join(f"{C.GREEN}{k}{C.RESET}" for k in caps.keys())
            print(f"  {C.BOLD}Capabilities:{C.RESET} {cap_list}")

    def _show_server_info_raw(self):
        """MT mode: dump full initialize response as raw JSON."""
        info = self.client.server_info if hasattr(self.client, "server_info") and self.client.server_info else {}
        if info:
            print(json.dumps(info, indent=2, ensure_ascii=False))

    def _cmd_server(self):
        print(f"\n  {C.BOLD}━━━ Server Info ━━━{C.RESET}")
        if self.mode == "mt":
            self._show_server_info_raw()
        else:
            self._show_server_info()
        print()

    def _cmd_profiles(self):
        """Show profile_status output."""
        print(f"\n  {C.BOLD}━━━ Profiles ━━━{C.RESET}")
        resp = self.client.call_tool("profile_status", {})
        if "error" in resp:
            print(f"  {C.RED}Error:{C.RESET} {resp['error'].get('message', str(resp['error']))}")
            print()
            return
        content = resp.get("result", {}).get("content", [])
        if content:
            for c in content:
                if c.get("type") == "text":
                    try:
                        parsed = json.loads(c["text"])
                        self._print_formatted(parsed)
                    except (json.JSONDecodeError, KeyError):
                        print(f"  {c.get('text', str(c))}")
                else:
                    print(f"  {json.dumps(c, indent=2, ensure_ascii=False)}")
        else:
            self._print_formatted(resp.get("result", {}))
        print()

    def _cmd_load_profile(self, parts):
        if len(parts) < 2:
            print(f"  {C.YELLOW}Usage:{C.RESET} load-profile <name>")
            return
        name = parts[1]
        print(f"\n  {C.CYAN}▶{C.RESET} load_profile({name})")
        resp = self.client.call_tool("load_profile", {"profile": name})
        if "error" in resp:
            print(f"  {C.RED}✗ Error:{C.RESET} {resp['error'].get('message', str(resp['error']))}")
        else:
            print(f"  {C.GREEN}✓ Loaded{C.RESET}")
            # Refresh tools
            tools = self.client.list_tools()
            if isinstance(tools, list):
                print(f"  {C.DIM}→ {len(tools)} tools now available{C.RESET}")
        print()

    def _cmd_unload_profile(self, parts):
        if len(parts) < 2:
            print(f"  {C.YELLOW}Usage:{C.RESET} unload-profile <name>")
            return
        name = parts[1]
        print(f"\n  {C.CYAN}▶{C.RESET} unload_profile({name})")
        resp = self.client.call_tool("unload_profile", {"profile": name})
        if "error" in resp:
            print(f"  {C.RED}✗ Error:{C.RESET} {resp['error'].get('message', str(resp['error']))}")
        else:
            print(f"  {C.GREEN}✓ Unloaded{C.RESET}")
            tools = self.client.list_tools()
            if isinstance(tools, list):
                print(f"  {C.DIM}→ {len(tools)} tools now available{C.RESET}")
        print()

    def _cmd_exit(self):
        self.running = False
        print(f"  {C.YELLOW}Bye!{C.RESET}")
        self.client.close()


# ── Entry Point ────────────────────────────────────────────────────────────────
def main():
    import argparse
    parser = argparse.ArgumentParser(description="browser-whiskor MCP Interactive Shell")
    parser.add_argument("--mode", choices=["mt", "at"], default="at",
                        help="起動モード (mt=生JSON, at=整形)")
    parser.add_argument("--proxy", metavar="URL", default=None,
                        help="既存サーバーにプロキシ接続 (例: http://localhost:7892)")
    args = parser.parse_args()

    if args.proxy:
        client = HttpProxyClient(args.proxy)
    else:
        print(f"{C.DIM}Starting MCP server...{C.RESET}", end=" ", flush=True)
        client = McpClient()
        client.start()
        print(f"{C.GREEN}ready{C.RESET}")

    shell = McpShell(client, mode=args.mode)
    try:
        shell.run()
    except KeyboardInterrupt:
        pass
    finally:
        client.close()


if __name__ == "__main__":
    main()
