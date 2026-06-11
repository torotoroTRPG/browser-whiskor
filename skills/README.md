# skills/

AIエージェント向けの同梱スキル集。スキルは「エージェントが必要になったときだけ読み込む手順書」で、
MCPのようにツールスキーマが常時コンテキストを占有しないぶんトークン効率が良い。

| スキル | 内容 |
|---|---|
| [browser-whiskor-http/](browser-whiskor-http/) | MCPを使わず HTTP API（`:7892`）だけでブラウザを知覚・操作する手順。`SKILL.md`（基本ワークフロー）+ `reference.md`（全エンドポイント・全アクション） |

## インストール方法

スキルはフォルダごとコピーするだけで使える（自己完結）。

**Claude Code:**

```powershell
# ユーザー全体で使う場合
Copy-Item -Recurse skills/browser-whiskor-http "$env:USERPROFILE/.claude/skills/"
# 特定プロジェクトだけで使う場合
Copy-Item -Recurse skills/browser-whiskor-http <project>/.claude/skills/
```

```bash
# macOS / Linux
cp -r skills/browser-whiskor-http ~/.claude/skills/
```

**その他のエージェント:** SKILL.md は frontmatter（name / description）+ Markdown 本文という
一般的なスキル形式。Agent Skills 形式に対応したツールならそのまま、未対応でも本文を
システムプロンプトや手順書として渡せば機能する。

## MCPとの使い分け

- **MCP**（`node server/index.js --mcp`）: Claude Desktop / Cursor などMCPクライアントから使う標準経路。動的プロファイルでコンテキストを節約する（静的公開は `mcpServer.staticTools`）
- **HTTPスキル**: fetch/curl が使える面（Claude in Chrome、CLIエージェント等）向け。ツールスキーマがコンテキストに乗らない

どちらも同じサーバー（`npm start`）に接続するので併用できる。
