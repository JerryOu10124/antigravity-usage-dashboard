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

find_node() {
  for cand in "$(command -v node 2>/dev/null || true)" "${HOME}/.local/antigravity-node/bin/node" "/opt/homebrew/bin/node" "/usr/local/bin/node"; do
    if [[ -n "$cand" && -x "$cand" ]]; then
      local ver major
      ver="$("$cand" -v 2>/dev/null || true)"
      ver="${ver#v}"
      major="${ver%%.*}"
      if [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 20)); then
        printf '%s\n' "$cand"
        return 0
      fi
    fi
  done
  return 1
}

NODE_EXE=""
if ! NODE_EXE="$(find_node)"; then
  echo "[提示] 未检测到 Node.js 20+，正在自动安装运行环境..."
  bash "$SCRIPT_DIR/scripts/setup.sh" --skip-plugin --skip-sync
  NODE_EXE="$(find_node)"
fi

if ((${#ARGS[@]} > 0)); then
  "$NODE_EXE" "$SCRIPT_DIR/sync_usage.mjs" "${ARGS[@]}"
else
  "$NODE_EXE" "$SCRIPT_DIR/sync_usage.mjs"
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
