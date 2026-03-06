# Agent Automation Strategy for VS Code Extension Development

## Current Stack

```
Puppeteer screenshot script + code-server (local, headless)
```

Agent takes headless screenshots of code-server to verify UI changes. No human in the loop for visual verification.

## Workflow

1. Agent writes/edits code
2. Agent builds: `bun run compile:quiet` (or watch mode)
3. Agent takes screenshot: `node scripts/screenshot.mjs --sidebar Beads`
4. Agent reads screenshot via `Read` tool (multimodal)
5. Agent verifies UI and iterates

See `docs/screenshot-verification.md` for full setup and usage.

## Context Cost (Solved)

Chrome DevTools MCP and Playwright MCP returned ~400-line accessibility trees per action, burning context fast.

**Solution:** Puppeteer screenshot script returns a single image. Agent reads it via the `Read` tool (supports images). No accessibility tree, no context bloat.

## Previous Stack (Deprecated)

```
Chrome DevTools MCP + code-server (local, headed)
```

Human-in-the-loop: agent wrote code, human reloaded window, agent used DevTools MCP for verification. Context-expensive and slow.

## Capabilities

| Capability | How |
|------------|-----|
| Extension install | `code-server --install-extension` |
| Window reload | Command palette (human) |
| Screenshots | `take_screenshot` |
| Console logs | `list_console_messages` |
| UI interaction | `click`, `fill`, `press_key` |
| Command palette | `press_key` Meta+Shift+P |

---

## Ruled Out Options

| Option | Why Ruled Out |
|--------|---------------|
| **vscode.dev** | No local extension support |
| **OpenVSCode Server (Docker)** | Unix socket blocked in container, bd CLI can't connect |
| **Playwright MCP** | Same context bloat as Chrome DevTools MCP |
| **Browser MCP** | Less capable than Chrome DevTools MCP |
| **@vscode/test-electron** | Tests API only, not visual UI |
| **F5 Dev Host** | Agent can't see/interact |
| **Headless + VNC** | Unnecessary complexity for local dev |

## References

- [code-server](https://github.com/coder/code-server)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Context optimization discussion](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code)
