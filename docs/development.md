# Development

## Prerequisites

| Tool | Purpose | Install |
|---|---|---|
| **bun** | Package manager & script runner | `curl -fsSL https://bun.sh/install \| bash` |
| **code** or **cursor** | Editor CLI (for installing extensions) | VS Code → `Cmd+Shift+P` → "Shell Command: Install 'code' command in PATH"; Cursor → same with `cursor` |
| **vsce** | VS Code extension packager | `bun add -g @vscode/vsce` |
| **bd** | Beads CLI (runtime dependency) | See [beads](https://github.com/steveyegge/beads) |

## Quick Start

```bash
git clone <repo-url> && cd vscode-beads
bun install
./scripts/install.sh     # build → lint → test → package → install
```

Reload VS Code after install: `Cmd+Shift+P` → "Developer: Reload Window"

## Build & Install Script

`scripts/install.sh` runs the full pipeline: dependencies → compile → lint → test → package → install.

```bash
./scripts/install.sh              # Run all steps (prompts for editor if both VS Code and Cursor found)
./scripts/install.sh --dry        # Show steps without running them
./scripts/install.sh --step       # Prompt before each step (skip any with 'n')
./scripts/install.sh --editor=cursor  # Target Cursor instead of VS Code
```

The script checks for required CLI tools upfront. If any are missing, it shows the install command and offers to run it for you. Works with both VS Code (`code`) and Cursor (`cursor`).

## Build Commands

```bash
bun install              # Install dependencies
bun run compile          # Build extension + webview
bun run compile:quiet    # Build (quiet output)
bun run watch            # Watch mode (extension + webview in parallel)
bun run lint             # ESLint on src/**/*.{ts,tsx}
bun run test             # Jest tests (experimental VM modules)
bun run package          # Create VSIX package
```

## Development Workflow

**Option 1: Extension Development Host (recommended for debugging)**
1. Open this repo in VS Code
2. Run `bun run watch` in terminal
3. Press `F5` to launch Extension Development Host
4. `Cmd+R` (Mac) / `Ctrl+R` (Win/Linux) to reload after changes

**Option 2: Symlink for local testing**
```bash
ln -s "$(pwd)" ~/.vscode/extensions/vscode-beads
# Reload VS Code: Cmd+Shift+P → "Developer: Reload Window"
# Unlink when done
rm ~/.vscode/extensions/vscode-beads
```

**Option 3: Install VSIX locally**
```bash
./scripts/install.sh
# Or manually:
bun run package
code --install-extension vscode-beads-*.vsix --force
```

## Edit → Rebuild → Reload Cycle

After making code changes, rebuild and reinstall the extension:

```bash
./scripts/install.sh                  # Full rebuild + reinstall (recommended)
```

Then reload your editor: `Cmd+Shift+P` → "Developer: Reload Window"

For faster iteration, you can run individual steps:

```bash
bun run compile:quiet                 # Rebuild only (no lint/test/package)
bun run package                       # Package VSIX
code --install-extension vscode-beads-*.vsix --force   # or: cursor --install-extension ...
```

Or use watch mode to auto-rebuild on save (no reinstall needed with F5 debug host):

```bash
bun run watch                         # Watches extension + webview in parallel
# Press F5 in VS Code to launch Extension Development Host
# Cmd+R to reload the host after changes
```

**Tip:** If you only changed webview code (React components, styles), `Cmd+R` in
the Extension Development Host is enough — no reinstall needed. Extension-side
changes (providers, backend) require a full reload.

## Beads Setup (Issue Tracking)

After cloning, initialize beads for the project:

```bash
bd init
```

The extension auto-discovers `.beads/` directories in workspace folders. Issue data is stored in Dolt (`dolt/` subdirectory) and gitignored.

## Releasing

Use the `/project-release` slash command in Claude Code:

1. Run `/project-release` from `main` branch
2. Confirm the computed version (minor bump by default)
3. Command audits changelog for missing user-facing changes
4. If complete, it updates CHANGELOG.md, bumps package.json, commits, tags, and pushes
5. Tag push triggers GitHub Actions to publish to VS Code Marketplace

For hotfixes, create a `release-v*` branch and run `/project-release` (patch bump).

## Architecture

See [CLAUDE.md](../CLAUDE.md) for architecture details, data flow, and code conventions.
