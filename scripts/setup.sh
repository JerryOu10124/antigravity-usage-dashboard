#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/JerryOu10124/antigravity-usage-dashboard.git"
REPO_TAR_URL="https://github.com/JerryOu10124/antigravity-usage-dashboard/archive/refs/heads/main.tar.gz"
PORTABLE_NODE_DIR="${HOME}/.local/antigravity-node"

INSTALL_DIR="${AGY_DASHBOARD_DIR:-${HOME}/antigravity-usage-dashboard}"
PLUGIN_DEST="${AGY_PLUGIN_DEST:-}"
DATA_DIR=""
BUNDLE_OUT=""
SKIP_PLUGIN=0
SKIP_SYNC=0

while (($# > 0)); do
  case "$1" in
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --plugin-dest)
      PLUGIN_DEST="$2"
      shift 2
      ;;
    --data-dir)
      DATA_DIR="$2"
      shift 2
      ;;
    --bundle-out)
      BUNDLE_OUT="$2"
      shift 2
      ;;
    --skip-plugin)
      SKIP_PLUGIN=1
      shift
      ;;
    --skip-sync)
      SKIP_SYNC=1
      shift
      ;;
    *)
      shift
      ;;
  esac
done

test_node20() {
  local exe="$1"
  [[ -n "$exe" && -x "$exe" ]] || return 1
  local ver major
  ver="$("$exe" -v 2>/dev/null || true)"
  ver="${ver#v}"
  major="${ver%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 20))
}

find_node20() {
  local candidates=()
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  candidates+=(
    "$PORTABLE_NODE_DIR/bin/node"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "${HOME}/.volta/bin/node"
  )
  if [[ -d "${HOME}/.nvm/versions/node" ]]; then
    local nvm_node
    while IFS= read -r nvm_node; do
      candidates+=("$nvm_node")
    done < <(ls -1d "${HOME}/.nvm/versions/node"/v*/bin/node 2>/dev/null | sort -r || true)
  fi

  local c
  for c in "${candidates[@]}"; do
    if test_node20 "$c"; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

install_portable_node() {
  local os_raw arch_raw os_tag arch_tag
  os_raw="$(uname -s)"
  arch_raw="$(uname -m)"

  case "$os_raw" in
    Darwin) os_tag="darwin" ;;
    Linux) os_tag="linux" ;;
    *)
      echo "[Error] Unsupported OS for automatic Node.js install: $os_raw" >&2
      return 1
      ;;
  esac

  case "$arch_raw" in
    arm64|aarch64) arch_tag="arm64" ;;
    x86_64|amd64) arch_tag="x64" ;;
    *)
      echo "[Error] Unsupported CPU architecture for portable Node.js: $arch_raw" >&2
      return 1
      ;;
  esac

  if ! command -v curl >/dev/null 2>&1; then
    echo "[Error] curl is required to download Node.js 20+." >&2
    return 1
  fi

  echo "[Setup] Resolving latest Node.js LTS from nodejs.org..."
  local lts_ver
  lts_ver="$(curl -fsSL "https://nodejs.org/dist/index.json" | grep -oE '"version":"v(2[0-9]|[3-9][0-9])\.[0-9]+\.[0-9]+","date":"[^"]+","files":\[[^]]*\],"lts":"[^"]+"' | head -n 1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
  if [[ -z "$lts_ver" ]]; then
    echo "[Error] Could not resolve Node.js 20+ LTS version. Please install manually from https://nodejs.org/." >&2
    return 1
  fi

  local tar_name="node-${lts_ver}-${os_tag}-${arch_tag}.tar.gz"
  local tar_url="https://nodejs.org/dist/${lts_ver}/${tar_name}"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  echo "[Setup] Downloading portable Node.js ${lts_ver} (${os_tag}-${arch_tag})..."
  curl -fsSL "$tar_url" -o "$tmp_dir/$tar_name"
  tar -xzf "$tmp_dir/$tar_name" -C "$tmp_dir"

  local inner_dir="$tmp_dir/node-${lts_ver}-${os_tag}-${arch_tag}"
  if [[ ! -x "$inner_dir/bin/node" ]]; then
    echo "[Error] Extracted archive did not contain bin/node." >&2
    return 1
  fi

  rm -rf "$PORTABLE_NODE_DIR"
  mkdir -p "$(dirname "$PORTABLE_NODE_DIR")"
  mv "$inner_dir" "$PORTABLE_NODE_DIR"

  if ! test_node20 "$PORTABLE_NODE_DIR/bin/node"; then
    echo "[Error] Portable Node.js verification failed." >&2
    return 1
  fi
  printf '%s\n' "$PORTABLE_NODE_DIR/bin/node"
}

ensure_node20() {
  local node_exe=""
  if node_exe="$(find_node20)"; then
    echo "[Setup] Found Node.js $("$node_exe" -v) ($node_exe)" >&2
    printf '%s\n' "$node_exe"
    return 0
  fi

  echo "[Setup] Node.js 20+ not found. Attempting automatic installation..." >&2
  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    echo "[Setup] Trying brew install node ..." >&2
    if brew install node >&2 && node_exe="$(find_node20)"; then
      echo "[Setup] Installed Node.js $("$node_exe" -v) via Homebrew ($node_exe)" >&2
      printf '%s\n' "$node_exe"
      return 0
    fi
  fi

  node_exe="$(install_portable_node)"
  echo "[Setup] Installed portable Node.js $("$node_exe" -v) ($node_exe)" >&2
  printf '%s\n' "$node_exe"
}

resolve_repo_dir() {
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    local script_dir candidate
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    candidate="$(cd "$script_dir/.." && pwd)"
    if [[ -f "$candidate/install.mjs" && -f "$candidate/plugin/token-usage/dist/server.cjs" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  if command -v git >/dev/null 2>&1; then
    if [[ -d "$INSTALL_DIR/.git" ]]; then
      echo "[Setup] Updating existing repository at $INSTALL_DIR ..." >&2
      git -C "$INSTALL_DIR" pull --ff-only >&2 || true
      printf '%s\n' "$INSTALL_DIR"
      return 0
    fi
    if [[ ! -f "$INSTALL_DIR/install.mjs" ]]; then
      echo "[Setup] Cloning antigravity-usage-dashboard into $INSTALL_DIR ..." >&2
      git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" >&2
      printf '%s\n' "$INSTALL_DIR"
      return 0
    fi
  fi

  echo "[Setup] Downloading antigravity-usage-dashboard archive from GitHub..." >&2
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN
  curl -fsSL "$REPO_TAR_URL" -o "$tmp_dir/repo.tar.gz"
  tar -xzf "$tmp_dir/repo.tar.gz" -C "$tmp_dir"
  local extracted
  extracted="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  mkdir -p "$INSTALL_DIR/data"
  (
    cd "$extracted"
    for item in *; do
      if [[ "$item" == "data" ]]; then
        [[ -f "data/.gitkeep" && ! -f "$INSTALL_DIR/data/.gitkeep" ]] && cp "data/.gitkeep" "$INSTALL_DIR/data/.gitkeep"
        continue
      fi
      if [[ "$item" == "config.json" && -f "$INSTALL_DIR/config.json" ]]; then
        continue
      fi
      rm -rf "$INSTALL_DIR/$item"
      cp -R "$item" "$INSTALL_DIR/$item"
    done
  )
  printf '%s\n' "$INSTALL_DIR"
}

NODE_EXE="$(ensure_node20)"
REPO_DIR="$(resolve_repo_dir)"
echo "[Setup] Repository directory: $REPO_DIR"

if [[ -f "$REPO_DIR/install.sh" ]]; then chmod +x "$REPO_DIR/install.sh" || true; fi
if [[ -f "$REPO_DIR/open-dashboard.sh" ]]; then chmod +x "$REPO_DIR/open-dashboard.sh" || true; fi
if [[ -f "$REPO_DIR/scripts/setup.sh" ]]; then chmod +x "$REPO_DIR/scripts/setup.sh" || true; fi

if [[ "$SKIP_PLUGIN" -eq 0 ]]; then
  INSTALL_ARGS=("$REPO_DIR/install.mjs")
  if [[ -n "$PLUGIN_DEST" ]]; then
    INSTALL_ARGS+=("--dest" "$PLUGIN_DEST")
  fi
  "$NODE_EXE" "${INSTALL_ARGS[@]}"
fi

if [[ "$SKIP_SYNC" -eq 0 ]]; then
  SYNC_ARGS=("$REPO_DIR/sync_usage.mjs")
  if [[ -n "$DATA_DIR" ]]; then
    SYNC_ARGS+=("--data-dir" "$DATA_DIR")
  fi
  if [[ -n "$BUNDLE_OUT" ]]; then
    SYNC_ARGS+=("--bundle-out" "$BUNDLE_OUT")
  fi
  "$NODE_EXE" "${SYNC_ARGS[@]}"
fi

echo ""
echo "[Setup] All done!"
echo "[Setup] Restart (or reopen) Antigravity and open 'Token 统计' from the left sidebar or '+' pane menu."
echo "[Setup] Standalone browser launcher: $REPO_DIR/open-dashboard.sh"
