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

# Version from package.json (single source of truth) so the banner never goes stale.
BW_VER="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"

# ── OCR engine offer (optional) — read text from pixels (canvas/WebGL like Unity,
# icon-only buttons) via ocr_region / POST /api/ocr. Engine is bring-your-own.
ocr_dismissed="cache/.ocr-offer-dismissed"
_ocr_available() {
  if [ -n "${WHISKOR_OCR_PATH:-}" ] && [ -x "${WHISKOR_OCR_PATH}" ]; then return 0; fi
  command -v tesseract >/dev/null 2>&1
}
if [ -z "${WHISKOR_OCR_NO_PROMPT:-}" ] && [ ! -f "$ocr_dismissed" ] && ! _ocr_available; then
  echo ""
  echo "[bw] No OCR engine found (optional). OCR reads text from pixels —"
  echo "[bw] canvas/WebGL apps (Unity) and icon-only buttons (ocr_region / POST /api/ocr)."
  if [ -t 0 ]; then
    printf "[bw] Install Tesseract now? [I]nstall (apt/brew)  [M]anual how-to  [N]o (default N, 10s): "
    resp=""; read -t 10 -n 1 resp || true; echo ""
    case "$resp" in
      i|I)
        if command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y tesseract-ocr || true
        elif command -v brew >/dev/null 2>&1; then brew install tesseract || true
        elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y tesseract || true
        else echo "[bw] No apt/brew/dnf found — install 'tesseract' via your package manager."; fi
        ;;
      m|M)
        echo "[bw] Manual: install 'tesseract' (apt: tesseract-ocr / brew: tesseract / dnf: tesseract),"
        echo "[bw] or set WHISKOR_OCR_PATH=/path/to/tesseract (or config intelligence.ocr.binPath)."
        echo "[bw] For Japanese add the 'jpn' data (apt: tesseract-ocr-jpn) and use lang:'eng+jpn'."
        touch "$ocr_dismissed"
        ;;
      *)
        echo "[bw] Skipping OCR. (Won't ask again; rm $ocr_dismissed to re-enable.)"
        touch "$ocr_dismissed"
        ;;
    esac
  else
    echo "[bw] To enable: install tesseract on PATH or set WHISKOR_OCR_PATH (WHISKOR_OCR_NO_PROMPT=1 silences this)."
  fi
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║       browser-whiskor v${BW_VER}  —  Server"
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
