# vscode-beads Dolt Compatibility Migration

**Bead:** beads-59q\
**Related:** beads-vlt (audit)

## Problem

vscode-beads is built around `BeadsDaemonClient` which connects to `.beads/bd.sock` via Unix domain sockets and communicates via JSON-RPC. Modern `bd` v0.55.4+ uses Dolt in direct mode — no daemon, no socket, no PID file. The extension is completely broken.

## Strategy

Replace the socket RPC client with a CLI-based client that has the **same public API**, so view providers need zero changes. All operations go through `bd` CLI with `--json` output.

---

## Requirements

Everything below must be working before any build/package/test steps.

### Already installed via mise

| Tool | Version | Purpose |
|------|---------|---------|
| `git` | 2.53.0 | Version control |
| `bd` | 0.55.4 | Beads CLI (what the extension talks to) |
| `code` | 1.109.5 | VS Code CLI (for `code --install-extension`) |
| `mise` | installed | Tool version manager |
| `node` | 24.14.0 | JavaScript runtime (required by esbuild, eslint, jest, vsce) |
| `bun` | 1.3.10 | Package manager and script runner (all `package.json` scripts use `bun run`) |

**Important:** mise manages node and bun via `~/.config/mise/config.toml`. The shims live at `~/.local/share/mise/shims/`. Make sure your shell config (`~/.zshrc`) has `eval "$(mise activate zsh)"` so the shims are on PATH.

**Verify all tools are on PATH:**
```bash
node --version && bun --version && bd --version
```

### Project dependencies

TypeScript, esbuild, eslint, jest, React, etc. from `package.json`. Installed locally into `node_modules/`.

```bash
cd vscode-beads
bun install
```

### @vscode/vsce (for packaging only)

The official VS Code Extension CLI. Produces `.vsix` files. Only needed for `bun run package`, not for dev/debug.

```bash
npm install -g @vscode/vsce
vsce --version    # Should print 3.x
```

### gh (GitHub CLI) — optional

Only needed for GitHub Releases automation.

```bash
brew install gh
gh auth login
```

### Quick setup

```bash
cd vscode-beads
bun install
npm install -g @vscode/vsce

# Verify
node --version && bun --version && vsce --version && bd --version
bun run compile:quiet    # Should produce dist/ with no errors
```

---

## Phase 1: Create `BeadsCLIClient.ts`

**New file:** `src/backend/BeadsCLIClient.ts`

Drop-in replacement for `BeadsDaemonClient` using `bd` CLI commands. Same public API so callers (view providers, extension.ts) need no changes.

**Core:** Private `execBd(args: string[])` method that spawns `bd` with args from the project's cwd, collects stdout, parses JSON, throws on non-zero exit.

**CLI mapping:**

| Method | CLI Command |
|--------|-------------|
| `list({status, priority, ...})` | `bd list --json --status=X --priority=N ...` |
| `show(id)` | `bd show <id> --json` (returns array, take first element) |
| `ready({assignee, ...})` | `bd ready --json ...` |
| `stats()` | `bd stats --json` → map `summary` to `StatsResponse` format |
| `listComments(id)` | `bd show <id> --json` → extract inline comments |
| `create({title, ...})` | `bd create <title> --json --type=X --priority=N ...` |
| `update({id, ...})` | `bd update <id> --title=X --status=X ...` → re-fetch via show |
| `close({id})` | `bd update <id> --status closed` → re-fetch via show |
| `addDependency(...)` | `bd dep add -- <from> <to> --type <type>` |
| `removeDependency(...)` | `bd dep remove -- <from> <to>` |
| `addLabel(...)` | `bd label add <id> -- <label>` |
| `removeLabel(...)` | `bd label remove <id> -- <label>` |
| `addComment(...)` | `bd comments add <id> <text> --author <author>` |
| `health()` / `ping()` / `status()` | `bd info --json` → synthetic response |

**Stats mapping:** `bd stats --json` returns `{ summary: { total_issues, open_issues, in_progress_issues, ... } }`. Map to existing `StatsResponse` shape (`total`, `open`, `in_progress`, etc.). `by_type`/`by_priority`/`by_assignee` default to `{}`.

**Mutation watching:** Replace RPC polling with `fs.watch()` on `.beads/` directory (recursive). Debounce 500ms, emit synthetic `mutation` event. Triggers same `onDataChanged` flow.

**Type reuse:** Import all interfaces (`Issue`, `CreateArgs`, etc.) from `BeadsDaemonClient.ts` and re-export them. Types are still valid for CLI output.

**Key difference from old `bd show`:** Returns an array `[{...}]`, not a single object. Take `result[0]`.

---

## Phase 2: Simplify `BeadsProjectManager.ts`

**Modify:** `src/backend/BeadsProjectManager.ts`

**Import swap:** `BeadsDaemonClient` → `BeadsCLIClient`

**Remove entirely:**
- `ensureDaemonRunning()` — no daemon to start
- `startDaemonProcess()` — no daemon to spawn
- `restartDaemon()` — no daemon to restart
- `stopDaemon()` — no daemon to stop
- `promptDaemonStart()` — no daemon prompt
- `notifyDaemonError()` — simplify to generic error notification

**Simplify `createProjectFromPath()`:**
- Remove `beads.db` check → check `.beads/dolt/` directory instead
- Remove socket existence check
- Set `status` field instead of `daemonStatus`

**Simplify `setActiveProject()`:**
- Create `BeadsCLIClient` instead of `BeadsDaemonClient`
- Remove health check / auto-start / `needsAutoStart` logic
- Verify `bd` is available via `bd info --json`
- Start file-based mutation watching
- Set `project.status` instead of `project.daemonStatus`

**Simplify `setupMutationWatching()`:**
- Keep mutation/disconnected/reconnected event handlers
- Update status field names (`daemonStatus` → `status`, `"running"` → `"connected"`)

**Replace `getDaemonStatus()`** with `getConnectionStatus()`:
- Remove PID file, socket, process kill checks
- Run `bd info --json` — success = `connected`, failure = `disconnected`
- Check `.beads/dolt/` exists — missing = `not_initialized`
- Return `{ state, message }`

**Simplify `refresh()`:**
- Just call `bd info --json` and fire `onDataChanged`

**Update `showProjectPicker()`:**
- Change "Daemon:" detail text to "Status:"
- Use `project.status` instead of `project.daemonStatus`

---

## Phase 3: Update `BeadsProject` interface in `types.ts`

**Modify:** `src/backend/types.ts`

### 3a: Update BeadsProject interface

```typescript
// Before:
daemonStatus: "running" | "stopped" | "unknown";
daemonPid?: number;

// After:
status: "connected" | "disconnected" | "not_initialized";
```

Remove `dbPath` (no longer needed — Dolt uses `.beads/dolt/` directory).

### 3b: Add `owner` fallback in `normalizeBead()`

Modern `bd` uses `owner` instead of `assignee`. Add fallback:

```typescript
assignee: raw.assignee ? String(raw.assignee)
  : raw.owner ? String(raw.owner)
  : raw.assigned_to ? String(raw.assigned_to)
  : undefined,
```

### 3c: Add `owner` fallback in `issueToWebviewBead()`

Add `owner?` to the function's input type. Update assignee mapping:

```typescript
assignee: issue.assignee || issue.owner || undefined,
```

### 3d: Remove daemon webview messages

Remove from `WebviewToExtensionMessage`:
- `{ type: "startDaemon" }`
- `{ type: "stopDaemon" }`

---

## Phase 4: Update `extension.ts`

**Modify:** `src/extension.ts`

### 4a: Remove daemon commands

Remove registration of:
- `beads.startDaemon`
- `beads.stopDaemon`
- `beads.restartDaemon`
- `beads.checkDaemonStatus`

### 4b: Simplify status menu

Rename `beads.showDaemonMenu` → `beads.showStatusMenu`. Options:
- Show Status (`bd info --json`, display result)
- Refresh Board
- Show Logs

Remove start/stop/restart/force-stop options.

### 4c: Simplify `updateDaemonStatusBar()` → `updateStatusBar()`

Two states:
- Connected: `$(check) Beads`
- Disconnected: `$(circle-slash) Beads`

Remove `zombie` and `not_initialized` as separate visual states.

---

## Phase 5: Update `BaseViewProvider.ts`

**Modify:** `src/providers/BaseViewProvider.ts`

- Remove `startDaemon` and `stopDaemon` message handlers
- Simplify `handleDaemonError()` → `handleError()` (just log + show output)
- Remove call to `projectManager.ensureDaemonRunning()` and `projectManager.stopDaemon()`
- Remove `projectManager.notifyDaemonError()` call

---

## Phase 6: Tests

**New files:**

### `src/test/cli-client.test.ts`
Test `BeadsCLIClient` by stubbing `child_process.spawn`:
- `list()` calls `bd list --json`, returns `Issue[]`
- `list({status: 'open'})` includes `--status=open` flag
- `show(id)` returns single Issue from array response
- `show(id)` returns null for not-found
- `stats()` maps `summary` to `StatsResponse`
- `create/update/close` build correct args
- `addDependency/removeDependency/addLabel/removeLabel/addComment` build correct args
- `health()` calls `bd info --json`, returns synthetic response
- `isConnected()` returns true when bd available
- `execBd` throws on non-zero exit, handles ENOENT

### `src/test/types.test.ts`
- `normalizeBead` maps `owner` → `assignee` when `assignee` missing
- `normalizeBead` prefers `assignee` over `owner`
- `issueToWebviewBead` maps `owner` → `assignee`
- `normalizeStatus` maps all known statuses
- `normalizePriority` handles edge cases

### Jest config
Create `jest.config.js` (none exists yet — `package.json` runs jest directly).

---

## Phase 7: Cleanup

- Delete `src/backend/BeadsDaemonClient.ts` (replaced by `BeadsCLIClient.ts`)
  - First update `BeadsCLIClient.ts` to own its type definitions instead of importing from the deleted file
- Remove daemon commands from `package.json` `contributes.commands`
- Remove `beads.autoStartDaemon` configuration setting
- Update CHANGELOG.md

---

## Verification

After each phase:
```bash
bun run compile:quiet    # Must compile clean
bun run lint             # Must pass lint
bun run test             # Must pass tests (after Phase 6)
```

---

## Packaging, Installation & Distribution

### Prerequisites

```bash
cd vscode-beads
bun install                          # Install dependencies
npm install -g @vscode/vsce          # Install the VS Code Extension CLI (one-time)
```

`@vscode/vsce` is the official tool for packaging and publishing VS Code extensions. It produces `.vsix` files (zip archives with extension metadata).

### Build & Package

```bash
bun run compile                      # Build extension + webview → dist/
bun run package                      # Creates vscode-beads-<version>.vsix
```

The `package` script runs `vsce package` under the hood. The version comes from `package.json` (`"version": "0.12.0"`). Output: `vscode-beads-0.12.0.vsix`.

### Local Installation (your machine)

**Option A: Install the VSIX** (recommended for real testing)

```bash
code --install-extension vscode-beads-0.12.0.vsix
```

Then reload VS Code (`Cmd+Shift+P` → "Developer: Reload Window"). The extension appears in the sidebar as "Beads". To uninstall: `code --uninstall-extension planet57.vscode-beads`.

**Option B: Symlink for rapid iteration** (dev only)

```bash
ln -s "$(pwd)" ~/.vscode/extensions/vscode-beads
# Reload VS Code window after changes
# Remove when done:
rm ~/.vscode/extensions/vscode-beads
```

No packaging step needed — just `bun run compile` and reload. Faster for active development but can behave differently from a real install (no activation events filtering, etc.).

**Option C: Extension Development Host** (debugging)

1. Open the `vscode-beads` folder in VS Code
2. Run `bun run watch` in the terminal
3. Press `F5` — launches a second VS Code window with the extension loaded
4. Set breakpoints, inspect logs in Debug Console
5. `Cmd+R` in the dev host to reload after changes

### Testing After Installation

1. Open a workspace that has a `.beads/` directory (any project with `bd init` run)
2. Look for the Beads icon in the activity bar (left sidebar)
3. Check the status bar at the bottom — should show `$(check) Beads` or `$(circle-slash) Beads`
4. Open the Issues panel — should list beads from `bd list --json`
5. Click a bead — Details panel should populate
6. Try creating a bead via `Cmd+Shift+P` → "Beads: Create New Issue"
7. Verify file-change refresh: run `bd create "test" --type task` in terminal, board should auto-update

### Sharing with Team Members

**Option 1: Share the .vsix file** (simplest, no marketplace needed)

```bash
bun run compile && bun run package   # Produces vscode-beads-0.12.0.vsix
```

Send the `.vsix` file to teammates (Slack, email, shared drive). They install with:

```bash
code --install-extension vscode-beads-0.12.0.vsix
```

Or in VS Code: `Cmd+Shift+P` → "Extensions: Install from VSIX..." → select file.

**Option 2: Git-based distribution**

Teammates clone the repo and build locally:

```bash
git clone <repo-url>
cd vscode-beads
bun install
bun run package
code --install-extension vscode-beads-*.vsix
```

**Option 3: GitHub Releases** (recommended for versioned distribution)

Attach `.vsix` files to GitHub releases. Teammates download from the Releases page and install. Can be automated with CI:

```bash
# In CI after tests pass:
bun run package
gh release create v0.12.0 vscode-beads-0.12.0.vsix --title "v0.12.0" --notes "Dolt CLI migration"
```

**Option 4: VS Code Marketplace** (public distribution, future)

Requires a publisher account on https://marketplace.visualstudio.com and an Azure DevOps personal access token. Current publisher is `planet57`.

```bash
vsce login planet57
vsce publish                         # Publishes current version
```

This is a heavier process — use for stable public releases, not internal iteration.

### Version Bumping

Before packaging a new version:

```bash
# In package.json, update "version": "0.13.0"
# Or use npm version:
npm version patch   # 0.12.0 → 0.12.1
npm version minor   # 0.12.0 → 0.13.0
```

Then `bun run package` picks up the new version automatically.

---

## Build / Test / Install / Uninstall

Quick-reference commands for the full lifecycle. Run from `vscode-beads/`.

### Build

```bash
bun install                              # Install/update dependencies
bun run compile:quiet                    # Compile extension + webview (quiet output)
bun run lint                             # ESLint check
bun run test                             # Jest tests (all suites)
```

All four must pass cleanly before packaging.

### Package

```bash
bun run package                          # Produces vscode-beads-<version>.vsix
```

This runs `vsce package`, which triggers `vscode:prepublish` → `bun run compile` automatically.

### Install

```bash
code --install-extension vscode-beads-0.12.0.vsix --force
```

Then reload VS Code: `Cmd+Shift+P` → "Developer: Reload Window".

### Uninstall

```bash
code --uninstall-extension planet57.vscode-beads
```

The extension ID is `planet57.vscode-beads` (from `package.json` publisher + name).

### Verify Installation

1. Reload VS Code window
2. Check status bar — should show `$(check) Beads` (connected) or `$(circle-slash) Beads` (disconnected)
3. Open the Beads sidebar panels (Dashboard, Issues, Details)
4. Create a bead via CLI (`bd create "test" -t task`) — board should auto-refresh
5. Select a bead in Issues panel — Details panel should populate
6. Delete a bead via CLI (`bd delete <id> --force`) — extension should handle gracefully

---

## Execution Order

Phases 3 (types) and 5 (BaseViewProvider) should come before Phase 2 (ProjectManager) to avoid intermediate compile errors. Suggested order:

1. Phase 1 — Create BeadsCLIClient.ts (new file, no compile impact)
2. Phase 3 — Update types.ts (owner fallback, BeadsProject interface)
3. Phase 5 — Update BaseViewProvider.ts (remove daemon message handlers)
4. Phase 2 — Simplify BeadsProjectManager.ts (swap to CLI client)
5. Phase 4 — Update extension.ts (remove daemon commands)
6. Phase 7 — Cleanup (delete old file, move types)
7. Phase 6 — Tests
8. Final compile/lint/test verification
