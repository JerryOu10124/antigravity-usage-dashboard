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

case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$(pwd)/$INSTALL_DIR" ;;
esac

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
  if command -v brew >/dev/null 2>&1; then
    local brew_node_prefix
    brew_node_prefix="$(brew --prefix node 2>/dev/null || true)"
    if [[ -n "$brew_node_prefix" ]]; then
      candidates+=("$brew_node_prefix/bin/node")
    fi
  fi
  local nvm_root="${NVM_DIR:-${HOME}/.nvm}"
  if [[ -d "${nvm_root}/versions/node" ]]; then
    local nvm_node
    while IFS= read -r nvm_node; do
      candidates+=("$nvm_node")
    done < <(ls -1d "${nvm_root}/versions/node"/v*/bin/node 2>/dev/null | sort -r || true)
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
  if ! command -v tar >/dev/null 2>&1; then
    echo "[Error] tar is required to extract portable Node.js." >&2
    return 1
  fi

  echo "[Setup] Resolving latest Node.js LTS from nodejs.org..." >&2
  local lts_ver
  lts_ver="$(curl -fsSL "https://nodejs.org/dist/index.tab" | awk -F '\t' '
    NR == 1 {
      for (i = 1; i <= NF; i++) {
        if ($i == "version") vc = i
        if ($i == "lts") lc = i
      }
      next
    }
    vc && lc {
      v = $vc
      sub(/^v/, "", v)
      split(v, a, ".")
      if ($lc != "-" && $lc != "" && (a[1] + 0) >= 20) {
        print $vc
        exit
      }
    }
  ' || true)"

  if [[ -z "$lts_ver" ]]; then
    echo "[Error] Could not resolve Node.js 20+ LTS version. Please install manually from https://nodejs.org/." >&2
    return 1
  fi

  local tar_name="node-${lts_ver}-${os_tag}-${arch_tag}.tar.gz"
  local tar_url="https://nodejs.org/dist/${lts_ver}/${tar_name}"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  echo "[Setup] Downloading portable Node.js ${lts_ver} (${os_tag}-${arch_tag})..." >&2
  if ! curl -fsSL "$tar_url" -o "$tmp_dir/$tar_name"; then
    rm -rf "$tmp_dir"
    echo "[Error] Failed to download $tar_url" >&2
    return 1
  fi
  if ! tar -xzf "$tmp_dir/$tar_name" -C "$tmp_dir"; then
    rm -rf "$tmp_dir"
    echo "[Error] Failed to extract $tar_name" >&2
    return 1
  fi

  local inner_dir="$tmp_dir/node-${lts_ver}-${os_tag}-${arch_tag}"
  if ! test_node20 "$inner_dir/bin/node"; then
    rm -rf "$tmp_dir"
    echo "[Error] Extracted Node.js binary failed version check." >&2
    return 1
  fi

  local stage_old="${PORTABLE_NODE_DIR}.old.$$"
  mkdir -p "$(dirname "$PORTABLE_NODE_DIR")"
  if [[ -d "$PORTABLE_NODE_DIR" ]]; then
    mv "$PORTABLE_NODE_DIR" "$stage_old"
  fi
  if mv "$inner_dir" "$PORTABLE_NODE_DIR"; then
    rm -rf "$stage_old" "$tmp_dir"
  else
    [[ -d "$stage_old" && ! -d "$PORTABLE_NODE_DIR" ]] && mv "$stage_old" "$PORTABLE_NODE_DIR" || true
    rm -rf "$tmp_dir"
    echo "[Error] Failed to place portable Node.js in $PORTABLE_NODE_DIR" >&2
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

  if ! node_exe="$(install_portable_node)"; then
    return 1
  fi
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
      local existing_remote
      existing_remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
      if [[ ! -f "$INSTALL_DIR/install.mjs" && "$existing_remote" != *antigravity-usage-dashboard* ]]; then
        echo "[Error] Target $INSTALL_DIR is an unrelated git repository ($existing_remote). Pass --install-dir to pick another folder." >&2
        return 1
      fi
      echo "[Setup] Updating existing repository at $INSTALL_DIR ..." >&2
      if ! git -C "$INSTALL_DIR" pull --ff-only >&2; then
        echo "[Warning] git pull --ff-only failed; continuing with existing files in $INSTALL_DIR." >&2
      fi
      printf '%s\n' "$INSTALL_DIR"
      return 0
    fi
    if [[ ! -e "$INSTALL_DIR" || ! -f "$INSTALL_DIR/install.mjs" ]]; then
      if [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]]; then
        echo "[Error] Directory $INSTALL_DIR is not empty and does not look like this repository. Pass --install-dir to specify an empty path." >&2
        return 1
      fi
      echo "[Setup] Cloning antigravity-usage-dashboard into $INSTALL_DIR ..." >&2
      git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" >&2
      printf '%s\n' "$INSTALL_DIR"
      return 0
    fi
  fi

  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    echo "[Error] curl and tar are required to download the repository archive." >&2
    return 1
  fi

  echo "[Setup] Downloading antigravity-usage-dashboard archive from GitHub..." >&2
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  if ! curl -fsSL "$REPO_TAR_URL" -o "$tmp_dir/repo.tar.gz"; then
    rm -rf "$tmp_dir"
    echo "[Error] Failed to download $REPO_TAR_URL" >&2
    return 1
  fi
  if ! tar -xzf "$tmp_dir/repo.tar.gz" -C "$tmp_dir"; then
    rm -rf "$tmp_dir"
    echo "[Error] Failed to extract repository archive." >&2
    return 1
  fi

  local extracted
  extracted="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1 || true)"
  if [[ -z "$extracted" || ! -f "$extracted/install.mjs" || ! -f "$extracted/plugin/token-usage/dist/server.cjs" ]]; then
    rm -rf "$tmp_dir"
    echo "[Error] Downloaded archive did not contain expected antigravity-usage-dashboard files." >&2
    return 1
  fi

  mkdir -p "$INSTALL_DIR/data"
  (
    shopt -s dotglob nullglob
    local src_item base
    for src_item in "$extracted"/*; do
      base="$(basename "$src_item")"
      if [[ "$base" == "." || "$base" == ".." || "$base" == ".git" ]]; then
        continue
      fi
      if [[ "$base" == "data" ]]; then
        if [[ -f "$src_item/.gitkeep" && ! -f "$INSTALL_DIR/data/.gitkeep" ]]; then
          cp "$src_item/.gitkeep" "$INSTALL_DIR/data/.gitkeep"
        fi
        continue
      fi
      if [[ "$base" == "config.json" && -f "$INSTALL_DIR/config.json" ]]; then
        continue
      fi
      rm -rf "${INSTALL_DIR:?}/$base"
      cp -R "$src_item" "$INSTALL_DIR/$base"
    done
  )
  rm -rf "$tmp_dir"
  printf '%s\n' "$INSTALL_DIR"
}

if ! NODE_EXE="$(ensure_node20)"; then
  exit 1
fi
if ! REPO_DIR="$(resolve_repo_dir)"; then
  exit 1
fi
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
echo "[Setup] Restart (or reopen) Antigravity and open 'Token Usage' from the left sidebar or '+' pane menu."
echo "[Setup] Standalone browser launcher: $REPO_DIR/open-dashboard.sh"
