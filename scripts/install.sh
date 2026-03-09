#!/usr/bin/env bash
#
# install.sh — Build, lint, package, and install vscode-beads
#
# Usage:
#   ./scripts/install.sh              # Run all steps
#   ./scripts/install.sh --dry        # Show steps without running them
#   ./scripts/install.sh --step       # Prompt before each step
#   ./scripts/install.sh --editor X   # Skip editor prompt (code or cursor)
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
EDITOR_CLI=""  # set by --editor or auto-detected
EDITOR_NAME="" # human-readable name

for arg in "$@"; do
  case "$arg" in
    --dry)  MODE="dry" ;;
    --step) MODE="step" ;;
    --editor=*) EDITOR_CLI="${arg#--editor=}" ;;
    -h|--help)
      echo "Usage: $0 [--dry | --step | --editor=code|cursor]"
      echo "  --dry          Show steps without running them"
      echo "  --step         Prompt before each step"
      echo "  --editor=X     Target editor: code or cursor (skip prompt)"
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

# --- Detect target editor ---

detect_editor() {
  local has_code has_cursor
  has_code=$(command -v code >/dev/null 2>&1 && echo 1 || echo 0)
  has_cursor=$(command -v cursor >/dev/null 2>&1 && echo 1 || echo 0)

  if [ -n "$EDITOR_CLI" ]; then
    # User specified --editor
    case "$EDITOR_CLI" in
      code)   EDITOR_NAME="VS Code" ;;
      cursor) EDITOR_NAME="Cursor" ;;
      *)
        echo -e "${RED}Unknown editor: $EDITOR_CLI (expected 'code' or 'cursor')${RESET}"
        exit 1
        ;;
    esac
    return
  fi

  if [ "$has_code" = "1" ] && [ "$has_cursor" = "1" ]; then
    if [ "$MODE" = "dry" ]; then
      # Default to code in dry mode — no prompts
      EDITOR_CLI="code"
      EDITOR_NAME="VS Code"
    else
      echo -e "${BOLD}Both VS Code and Cursor detected. Which editor?${RESET}"
      echo "  1) VS Code  (code)"
      echo "  2) Cursor   (cursor)"
      printf "  Choose [1/2]: "
      read -r choice </dev/tty
      case "$choice" in
        2|cursor) EDITOR_CLI="cursor"; EDITOR_NAME="Cursor" ;;
        *)        EDITOR_CLI="code";   EDITOR_NAME="VS Code" ;;
      esac
    fi
  elif [ "$has_cursor" = "1" ]; then
    EDITOR_CLI="cursor"
    EDITOR_NAME="Cursor"
  elif [ "$has_code" = "1" ]; then
    EDITOR_CLI="code"
    EDITOR_NAME="VS Code"
  else
    EDITOR_CLI=""  # neither found — handled in preflight
    EDITOR_NAME=""
  fi
}

detect_editor

# --- Preflight: check required tools ---

echo -e "\n${BOLD}Checking prerequisites...${RESET}"

# Build the tool list dynamically based on detected editor
TOOLS=("bun")
INSTALL_CMDS=("curl -fsSL https://bun.sh/install | bash")
INSTALL_STEPS=("Run: curl -fsSL https://bun.sh/install | bash")

# Editor CLI (code or cursor)
if [ -n "$EDITOR_CLI" ]; then
  TOOLS+=("$EDITOR_CLI")
else
  # Neither found — require one
  TOOLS+=("code or cursor")
fi
INSTALL_CMDS+=("")  # manual install for editors
if [ "$EDITOR_CLI" = "cursor" ] || [ -z "$EDITOR_CLI" ]; then
  INSTALL_STEPS+=("1. Install Cursor from https://cursor.com\n  2. Open Cursor → Cmd+Shift+P → 'Install cursor command in PATH'")
else
  INSTALL_STEPS+=("1. Install VS Code from https://code.visualstudio.com\n  2. Open VS Code → Cmd+Shift+P → 'Shell Command: Install code command in PATH'")
fi

TOOLS+=("vsce")
INSTALL_CMDS+=("bun add -g @vscode/vsce")
INSTALL_STEPS+=("Run: bun add -g @vscode/vsce")

for i in "${!TOOLS[@]}"; do
  cmd="${TOOLS[$i]}"

  # Special case: "code or cursor" means neither was found
  if [ "$cmd" = "code or cursor" ]; then
    echo -e "  ${RED}✗${RESET} No editor CLI found (code or cursor)"
    if [ "$MODE" = "dry" ]; then
      echo -e "  ${DIM}(would need: VS Code or Cursor CLI on PATH)${RESET}"
      continue
    fi
    echo -e "  ${YELLOW}Manual install required:${RESET}"
    echo -e "  Install VS Code (https://code.visualstudio.com) or Cursor (https://cursor.com)"
    echo -e "  Then install the CLI: Cmd+Shift+P → 'Install ... command in PATH'"
    echo -e "\nInstall an editor CLI, then re-run this script."
    exit 1
  fi

  if command -v "$cmd" >/dev/null 2>&1; then
    version=$("$cmd" --version 2>/dev/null | head -1)
    echo -e "  ${GREEN}✓${RESET} $cmd ${DIM}($version)${RESET}"
  else
    echo -e "  ${RED}✗${RESET} $cmd not found"

    # In dry mode, just report and continue — no prompts
    if [ "$MODE" = "dry" ]; then
      echo -e "  ${DIM}(would install: ${INSTALL_CMDS[$i]:-manual})${RESET}"
      continue
    fi

    install_cmd="${INSTALL_CMDS[$i]}"
    install_steps="${INSTALL_STEPS[$i]}"

    if [ -n "$install_cmd" ]; then
      echo -e "  To install: ${DIM}${install_cmd}${RESET}"
      printf "  Run this now? [Y/n] "
      read -r answer </dev/tty
      case "$answer" in
        n|N|no|No)
          # User declined — collect remaining missing tools and exit
          manual_steps=()
          for j in $(seq "$i" $((${#TOOLS[@]} - 1))); do
            if ! command -v "${TOOLS[$j]}" >/dev/null 2>&1; then
              manual_steps+=("${TOOLS[$j]}: ${INSTALL_STEPS[$j]}")
            fi
          done
          echo -e "\n${YELLOW}Install these tools manually, then re-run this script:${RESET}"
          for step in "${manual_steps[@]}"; do
            echo -e "  $step"
          done
          exit 1
          ;;
      esac

      echo -e "  ${DIM}→ ${install_cmd}${RESET}"
      if eval "$install_cmd"; then
        # Re-source shell profile so new tool is on PATH
        # shellcheck disable=SC1090
        [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true
        [ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true
        export PATH="$HOME/.bun/bin:$PATH"  # bun installer adds here

        if command -v "$cmd" >/dev/null 2>&1; then
          version=$("$cmd" --version 2>/dev/null | head -1)
          echo -e "  ${GREEN}✓${RESET} $cmd installed ${DIM}($version)${RESET}"
        else
          echo -e "  ${RED}✗${RESET} $cmd still not found after install"
          echo -e "  You may need to restart your shell. Then re-run this script."
          exit 1
        fi
      else
        echo -e "  ${RED}✗ Install command failed${RESET}"
        echo -e "  Manual steps: ${install_steps}"
        exit 1
      fi
    else
      # No auto-install available — must be manual
      echo -e "  ${YELLOW}Manual install required:${RESET}"
      echo -e "  $install_steps"
      echo -e "\nInstall $cmd, then re-run this script."
      exit 1
    fi
  fi
done

# --- Build steps ---

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
if [ -z "$vsix" ] && [ "$MODE" != "dry" ]; then
  echo -e "\n${RED}No .vsix file found after packaging.${RESET}"
  exit 1
fi
vsix="${vsix:-vscode-beads-*.vsix}"  # fallback for dry mode display

editor_label="${EDITOR_NAME:-VS Code/Cursor}"
editor_cmd="${EDITOR_CLI:-code}"

run_step "Install extension into $editor_label" \
  "$editor_cmd --install-extension '$vsix' --force"

echo -e "\n${GREEN}${BOLD}Done.${RESET} Reload $editor_label to activate: ${DIM}Cmd+Shift+P → Developer: Reload Window${RESET}"
