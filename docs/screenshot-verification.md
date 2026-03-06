# Code-Server Development Environment

Browser-based VS Code for developing and verifying the vscode-beads extension. Your real VS Code stays untouched. Both you and the agent work against the same running instance.

## Prerequisites

- **code-server**: `brew install code-server`
- **Node.js**: Required for puppeteer
- **bun**: For building the extension

## One-Time Setup

### 1. Install code-server

```bash
brew install code-server
```

### 2. Disable workspace trust and welcome tab

Create or update `~/.local/share/code-server/User/settings.json`:

```json
{
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false
}
```

### 3. Symlink the extension

```bash
ln -sf /path/to/vscode-beads ~/.local/share/code-server/extensions/planet57.vscode-beads-dev
```

### 4. Install puppeteer

```bash
cd vscode-beads/scripts
bun install
```

## Running

From the beads repo root:

```bash
# Start code-server
code-server --auth none --bind-addr 127.0.0.1:8080 .

# Start watch mode (auto-rebuilds extension on save, ~50ms)
cd vscode-beads && bun run watch
```

Open `http://127.0.0.1:8080` in your browser. Refresh the tab after changes to pick up the rebuilt extension.

## How It Works

- You or the agent edit code (any editor, CLI, doesn't matter)
- Watch mode auto-rebuilds on save
- You see changes by refreshing the browser tab
- The agent can also verify via headless screenshots (no browser needed on its end)
- Same instance, same state — whoever is working, the browser shows the latest

## Agent Verification

The agent takes headless screenshots to verify UI changes without Chrome DevTools MCP (which burned ~400 lines of context per action). A screenshot is a single image read.

```bash
cd vscode-beads/scripts

# Basic screenshot
node screenshot.mjs

# Click Beads sidebar first
node screenshot.mjs --sidebar Beads

# Reload window before capture
node screenshot.mjs --reload --sidebar Beads

# Custom wait time (ms)
node screenshot.mjs --sidebar Beads --wait 5000

# Custom output path
node screenshot.mjs --output screenshots/my-test.png

# Custom URL
node screenshot.mjs --url http://127.0.0.1:3000
```

The agent reads screenshots via the `Read` tool (supports images).

## Files

- `scripts/screenshot.mjs` - Headless screenshot tool
- `scripts/package.json` - Puppeteer dependency
- `scripts/.gitignore` - Excludes `node_modules/` and `screenshots/`
- `scripts/screenshots/` - Output directory (gitignored)

## Troubleshooting

### code-server not starting
- Check port: `lsof -i :8080`
- Use different port: `--bind-addr 127.0.0.1:3000`

### Extension not loading
- Verify symlink: `ls -la ~/.local/share/code-server/extensions/ | grep beads`
- Rebuild: `bun run compile:quiet`
- Restart code-server

### Trust dialog still appearing
- Verify settings in `~/.local/share/code-server/User/settings.json`
- Restart code-server after changing settings

### Sidebar not found
- The extension may not have activated yet — increase `--wait`
- Check that the symlink points to a built extension (`dist/` directory exists)
