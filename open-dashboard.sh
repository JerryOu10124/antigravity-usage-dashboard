#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NO_OPEN=0
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-open" ]]; then
    NO_OPEN=1
  else
    ARGS+=("$arg")
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "[Error] Node.js 20+ is required. Please install Node.js from https://nodejs.org/" >&2
  exit 1
fi

if ((${#ARGS[@]} > 0)); then
  node "$SCRIPT_DIR/sync_usage.mjs" "${ARGS[@]}"
else
  node "$SCRIPT_DIR/sync_usage.mjs"
fi

if [[ "$NO_OPEN" -eq 1 ]]; then
  exit 0
fi

DASH_FILE="$SCRIPT_DIR/dashboard.html"
if command -v open >/dev/null 2>&1; then
  open "$DASH_FILE"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$DASH_FILE" >/dev/null 2>&1 &
else
  echo "请用浏览器打开: $DASH_FILE"
fi
