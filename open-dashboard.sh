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
  local candidates=(
    "${HOME}/.local/antigravity-node/bin/node"
    "$(command -v node 2>/dev/null || true)"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "${HOME}/.volta/bin/node"
  )
  local nvm_root="${NVM_DIR:-${HOME}/.nvm}"
  if [[ -d "${nvm_root}/versions/node" ]]; then
    local nvm_node
    while IFS= read -r nvm_node; do
      candidates+=("$nvm_node")
    done < <(ls -1d "${nvm_root}/versions/node"/v*/bin/node 2>/dev/null | sort -r || true)
  fi

  local cand ver major
  for cand in "${candidates[@]}"; do
    if [[ -n "$cand" && -x "$cand" ]]; then
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
