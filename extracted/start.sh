#!/usr/bin/env bash
# Site Inspector v2 — サーバー起動スクリプト
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# node_modules がなければインストール
if [ ! -d "node_modules" ]; then
  echo "[SI] node_modules not found. Running npm install..."
  npm install
fi

# キャッシュディレクトリを作成
mkdir -p cache/sessions

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║       Site Inspector v2  —  Server           ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  WebSocket   ws://localhost:7891             ║"
echo "║  HTTP API    http://localhost:7892/api       ║"
echo "║  Dashboard   http://localhost:7892/          ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  拡張機能をChromiumに読み込んだ後、"
echo "  ブラウザのDevToolsを開いてください。"
echo ""
echo "  --mock     モックデータで動作確認"
echo "  --verbose  全メッセージをログ表示"
echo ""

node server/index.js "$@"
