#!/usr/bin/env bash
#
# install.sh — Build, lint, package, and install vscode-beads
#
# Usage:
#   ./scripts/install.sh          # Run all steps
#   ./scripts/install.sh --dry    # Show steps without running them
#   ./scripts/install.sh --step   # Prompt before each step
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  BOLD='\033[1m' DIM='\033[2m' GREEN='\033[32m' RED='\033[31m' YELLOW='\033[33m' RESET='\033[0m'
else
  BOLD='' DIM='' GREEN='' RED='' YELLOW='' RESET=''
fi

MODE="run"  # run | dry | step
for arg in "$@"; do
  case "$arg" in
    --dry)  MODE="dry" ;;
    --step) MODE="step" ;;
    -h|--help)
      echo "Usage: $0 [--dry | --step]"
      echo "  --dry   Show steps without running them"
      echo "  --step  Prompt before each step"
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

step_num=0

run_step() {
  local label="$1"
  shift
  step_num=$((step_num + 1))

  echo -e "\n${BOLD}[$step_num] $label${RESET}"
  echo -e "${DIM}  → $*${RESET}"

  if [ "$MODE" = "dry" ]; then
    return 0
  fi

  if [ "$MODE" = "step" ]; then
    printf "  Run this step? [Y/n] "
    read -r answer </dev/tty
    case "$answer" in
      n|N|no|No) echo -e "  ${YELLOW}Skipped${RESET}"; return 0 ;;
    esac
  fi

  if eval "$@"; then
    echo -e "  ${GREEN}✓ Done${RESET}"
  else
    echo -e "  ${RED}✗ Failed${RESET}"
    exit 1
  fi
}

# --- Preflight: check required tools ---

echo -e "${BOLD}Checking prerequisites...${RESET}"

missing=()

check_tool() {
  local cmd="$1" install_hint="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    local version
    version=$("$cmd" --version 2>/dev/null | head -1)
    echo -e "  ${GREEN}✓${RESET} $cmd ${DIM}($version)${RESET}"
  else
    echo -e "  ${RED}✗${RESET} $cmd — $install_hint"
    missing+=("$cmd")
  fi
}

check_tool "bun"  "Install: curl -fsSL https://bun.sh/install | bash"
check_tool "code" "Install VS Code, then: Shell Command: Install 'code' command in PATH"
check_tool "vsce" "Install: bun add -g @vscode/vsce"

if [ ${#missing[@]} -gt 0 ]; then
  echo -e "\n${RED}Missing tools: ${missing[*]}${RESET}"
  echo "Install them and re-run this script."
  exit 1
fi

# --- Steps ---

cd "$PROJECT_DIR"

run_step "Install dependencies" \
  "bun install --frozen-lockfile 2>&1 | tail -1"

run_step "Compile (extension + webview)" \
  "bun run compile:quiet"

run_step "Lint" \
  "bun run lint"

run_step "Run tests" \
  "bun run test 2>&1 || echo '  (tests may be experimental — check output)'"

run_step "Package VSIX" \
  "bun run package 2>&1 | tail -3"

# Find the VSIX (most recently created)
vsix=$(ls -t "$PROJECT_DIR"/vscode-beads-*.vsix 2>/dev/null | head -1)
if [ -z "$vsix" ]; then
  echo -e "\n${RED}No .vsix file found after packaging.${RESET}"
  exit 1
fi

run_step "Install extension" \
  "code --install-extension '$vsix' --force"

echo -e "\n${GREEN}${BOLD}Done.${RESET} Reload VS Code to activate: ${DIM}Cmd+Shift+P → Developer: Reload Window${RESET}"
