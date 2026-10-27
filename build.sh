#!/usr/bin/env bash
# build.sh — verify tools, build, and install the vscode-beads extension.
#
# Idempotent: safe to re-run. Installs the build toolchain (bun) if missing,
# compiles the extension + webview, and symlinks the repo into the code-server
# extensions dir so a browser reload picks up changes (the project's dev drill).
#
# Usage:
#   ./build.sh               # verify tools, build, install (symlink)
#   ./build.sh --no-install  # verify + build only, skip the symlink install
#   ./build.sh --package     # also produce a .vsix (bun run package)
#   ./build.sh --deps-only   # only verify/install build tools, then stop
#   ./build.sh -h | --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

log()  { printf "[build] %s\n" "$*"; }
warn() { printf "[build] WARNING: %s\n" "$*" >&2; }
die()  { printf "[build] ERROR: %s\n" "$*" >&2; exit 1; }

DO_INSTALL=1
DO_PACKAGE=0
DEPS_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-install) DO_INSTALL=0; shift ;;
    --package)    DO_PACKAGE=1; shift ;;
    --deps-only)  DEPS_ONLY=1; shift ;;
    -h|--help)    sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# 1. Verify build tools (install if missing) — idempotent.
# ---------------------------------------------------------------------------

command -v node >/dev/null 2>&1 || die "node not found — install Node.js 18+ and re-run."

# Make a per-user bun install visible even in a shell that predates it.
export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  log "bun not found — installing..."
  if command -v brew >/dev/null 2>&1; then
    brew install oven-sh/bun/bun
  else
    curl -fsSL https://bun.sh/install | bash
  fi
  command -v bun >/dev/null 2>&1 || die "bun install failed — see https://bun.sh."
fi
log "bun $(bun --version) at $(command -v bun)"

# Install JS dependencies (idempotent; a no-op when already up to date).
if [ ! -d node_modules ]; then
  log "Installing dependencies..."
  bun install
fi

if [ "$DEPS_ONLY" -eq 1 ]; then
  log "Build tools ready (--deps-only)."
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Build the extension + webview.
# ---------------------------------------------------------------------------

log "Compiling extension + webview..."
bun run compile

# ---------------------------------------------------------------------------
# 3. Install into every editor present (idempotent). Desktop VS Code and
#    code-server use different extension dirs, so install into whichever exist.
# ---------------------------------------------------------------------------

if [ "$DO_INSTALL" -eq 0 ]; then
  if [ "$DO_PACKAGE" -eq 1 ]; then log "Packaging .vsix..."; bun run package; fi
  log "Skipping install (--no-install). Done."
  exit 0
fi

installed=0
VSIX="$SCRIPT_DIR/$(node -e "const p=require('./package.json');process.stdout.write(p.name+'-'+p.version+'.vsix')")"

# 3a. Desktop VS Code — reads ~/.vscode/extensions and dedupes by extension id,
#     so `--install-extension --force` cleanly replaces any prior build.
if command -v code >/dev/null 2>&1; then
  # Always repackage — step 2 just recompiled, so any existing .vsix is stale.
  log "Packaging .vsix..."
  bun run package
  log "Installing into VS Code..."
  code --install-extension "$VSIX" --force >/dev/null
  log "Installed into VS Code (reload the window to pick up changes)."
  installed=1
elif [ "$DO_PACKAGE" -eq 1 ]; then
  log "Packaging .vsix..."
  bun run package
fi

# 3b. code-server — symlink the repo so a browser reload picks up rebuilds
#     without repackaging.
EXT_ID="$(node -e "const p=require('./package.json');process.stdout.write(p.publisher+'.'+p.name)")-dev"
CS_EXT_DIR="$HOME/.local/share/code-server/extensions"
LINK="$CS_EXT_DIR/$EXT_ID"

if command -v code-server >/dev/null 2>&1 || [ -d "$CS_EXT_DIR" ]; then
  mkdir -p "$CS_EXT_DIR"
  if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$SCRIPT_DIR" ]; then
    log "code-server already linked: $LINK -> $SCRIPT_DIR"
  elif [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
    warn "$LINK exists and is not a symlink — leaving it alone."
  else
    # Covers: missing, dangling, or stale-target symlink.
    rm -f "$LINK"
    ln -s "$SCRIPT_DIR" "$LINK"
    log "Linked into code-server: $LINK -> $SCRIPT_DIR"
  fi
  installed=1
fi

if [ "$installed" -eq 0 ]; then
  warn "Neither 'code' nor code-server found — built but not installed."
fi

log "Done."
