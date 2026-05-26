#!/usr/bin/env bash
# Pre-push validation: YAML lint, shared/ sync check, file structure validation.
# Equivalent of validate.ps1 for Unix environments.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
errors=0

echo "=== Validate: Checking shared/ sync ==="
if command -v node &>/dev/null; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    const shared = path.join('$ROOT', 'shared/injected');
    const chrome = path.join('$ROOT', 'extension/injected');
    const firefox = path.join('$ROOT', 'firefox-mv2/injected');
    let ok = true;
    function walk(dir, prefix) {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isFile()) {
          const rel = path.relative(prefix, p);
          const c = path.join(chrome, rel);
          const ff = path.join(firefox, rel);
          if (!fs.existsSync(c)) { console.log('  MISSING Chrome:', rel); ok = false; }
          if (!fs.existsSync(ff)) { console.log('  MISSING Firefox:', rel); ok = false; }
        }
      }
    }
    walk(shared, shared);
    if (ok) console.log('  All shared files synced.');
    process.exit(ok ? 0 : 1);
  " || errors=$((errors + 1))
else
  echo "  Skipping (node not available)"
fi

echo "=== Validate: Checking file structure ==="
for dir in "$ROOT/server" "$ROOT/extension" "$ROOT/shared"; do
  if [ ! -d "$dir" ]; then
    echo "  MISSING: $dir" >&2
    errors=$((errors + 1))
  fi
done

if [ "$errors" -gt 0 ]; then
  echo "FAILED: $errors error(s) found" >&2
  exit 1
fi
echo "All checks passed."
