#!/usr/bin/env bash
# Sync shared/ files to both Chrome and Firefox extensions.
# Equivalent of sync-shared.ps1 for Unix environments.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARED_DIR="$ROOT/shared/injected"
CHROME_DIR="$ROOT/extension/injected"
FIREFOX_DIR="$ROOT/firefox-mv2/injected"

if [ ! -d "$SHARED_DIR" ]; then
  echo "shared/injected/ not found. Nothing to sync."
  exit 0
fi

copied=0
errors=0

while IFS= read -r -d '' file; do
  rel="${file#$SHARED_DIR/}"
  chrome_target="$CHROME_DIR/$rel"
  ff_target="$FIREFOX_DIR/$rel"

  mkdir -p "$(dirname "$chrome_target")"
  mkdir -p "$(dirname "$ff_target")"

  if cp "$file" "$chrome_target" 2>/dev/null; then
    echo "  Chrome: $rel"
  else
    echo "  Chrome: $rel - FAILED" >&2
    errors=$((errors + 1))
  fi

  if cp "$file" "$ff_target" 2>/dev/null; then
    echo "  Firefox: $rel"
  else
    echo "  Firefox: $rel - FAILED" >&2
    errors=$((errors + 1))
  fi

  copied=$((copied + 1))
done < <(find "$SHARED_DIR" -type f -print0)

echo ""
if [ "$errors" -gt 0 ]; then
  echo " Result: $copied file(s) processed, $errors error(s)" >&2
  exit 1
else
  echo " Result: $copied file(s) processed, 0 errors"
fi
