/**
 * BaseViewProvider - Abstract base class for all Beads webview providers
 *
 * Provides common functionality for:
 * - Setting up webview content
 * - Message passing between extension and webview
 * - Loading/error states
 * - Project context
 */

import * as vscode from "vscode";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import {
  ExtensionToWebviewMessage,
  ViewToggles,
  WebviewToExtensionMessage,
} from "../backend/types";
import { Logger } from "../utils/logger";

// beads Dolt key-value prefix for the filter-bar view toggles. The key is
// suffixed with the user id (ui.view-toggles.<userId>) so a shared/central
// Dolt server keeps each user's toggles separate rather than project-wide.
const VIEW_TOGGLES_KEY_PREFIX = "ui.view-toggles";

export abstract class BaseViewProvider implements vscode.WebviewViewProvider {
  protected _view?: vscode.WebviewView;
  protected readonly extensionUri: vscode.Uri;
  protected readonly projectManager: BeadsProjectManager;
  protected readonly log: Logger;
  protected abstract readonly viewType: string;

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    this.extensionUri = extensionUri;
    this.projectManager = projectManager;
    this.log = logger;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "resources"),
      ],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      await this.handleMessage(message);
    });

    // Refresh data when the view becomes visible again (e.g., after being hidden)
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.initializeView();
      }
    });

    // Note: We don't call initializeView() here because the webview's React app
    // hasn't loaded yet. Instead, we wait for the "ready" message from the webview
    // (handled in handleMessage) which indicates the app is ready to receive data.
  }

  /**
   * Initializes the view with current data
   */
  protected async initializeView(): Promise<void> {
    if (!this._view) {
      return;
    }

    // Send view type
    this.postMessage({ type: "setViewType", viewType: this.viewType });

    // Send current project
    const project = this.projectManager.getActiveProject();
    this.postMessage({ type: "setProject", project });

    // Send all available projects
    const projects = this.projectManager.getProjects();
    this.postMessage({ type: "setProjects", projects });

    // Send settings
    const config = vscode.workspace.getConfiguration("beads");
    this.postMessage({
      type: "setSettings",
      settings: {
        renderMarkdown: config.get<boolean>("renderMarkdown", true),
        userId: this.getUserId(),
        tooltipHoverDelay: config.get<number>("tooltipHoverDelay", 1000),
      },
    });

    // Send team members (git contributors + bd config)
    this.projectManager.getTeamMembers().then((members) => {
      this.postMessage({ type: "setTeamMembers", members });
    }).catch((err) => {
      this.log.debug(`Failed to load team members: ${err}`);
    });

    // Send this project's persisted filter-bar toggles (from the Dolt kv store)
    await this.sendViewToggles();

    // Load view-specific data
    await this.loadData();
  }

  /**
   * Current user id: prefer the `beads.userId` setting, then $USER, then
   * "unknown". Used for the webview settings and the per-user view-toggles key.
   */
  protected getUserId(): string {
    const config = vscode.workspace.getConfiguration("beads");
    return config.get<string>("userId", "") || process.env.USER || process.env.USERNAME || "unknown";
  }

  /** Per-user kv key holding this user's filter-bar toggles for the project. */
  private viewTogglesKey(): string {
    return `${VIEW_TOGGLES_KEY_PREFIX}.${this.getUserId()}`;
  }

  /**
   * Read this user's filter-bar toggles for the active project from the beads
   * Dolt kv store and push them to the webview. Sends null (webview falls back
   * to defaults = all off) when nothing is stored, no project is active, or bd
   * errors.
   */
  protected async sendViewToggles(): Promise<void> {
    let toggles: ViewToggles | null = null;
    const client = this.projectManager.getClient();
    if (client) {
      try {
        const raw = await client.kvGet(this.viewTogglesKey());
        if (raw) { toggles = JSON.parse(raw) as ViewToggles; }
      } catch (err) {
        this.log.debug(`Failed to load view toggles: ${err}`);
      }
    }
    this.postMessage({ type: "setViewToggles", toggles });
  }

  /**
   * Loads view-specific data. Override in subclasses.
   */
  protected abstract loadData(): Promise<void>;

  /**
   * Handles messages from the webview. Override in subclasses for custom handling.
   */
  protected async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.initializeView();
        break;

      case "refresh":
        await this.loadData();
        break;

      case "selectProject":
        await this.projectManager.setActiveProject(message.projectId);
        break;

      case "selectBead":
        vscode.commands.executeCommand("beads.openBeadDetails", message.beadId);
        break;

      case "openBeadDetails":
        vscode.commands.executeCommand("beads.openBeadDetails", message.beadId);
        break;

      case "viewInGraph":
        // Focus the graph view and highlight the bead
        vscode.commands.executeCommand("beadsGraph.focus");
        vscode.commands.executeCommand("beads.viewInGraph", message.beadId);
        break;

      case "copyBeadId":
        if (message.beadId) {
          await vscode.env.clipboard.writeText(message.beadId);
          vscode.window.setStatusBarMessage(`$(check) Copied: ${message.beadId}`, 2000);
        }
        break;

      case "openFile":
        await this.handleOpenFile(message.filePath, message.line);
        break;

      case "saveViewToggles": {
        const client = this.projectManager.getClient();
        if (client) {
          try {
            await client.kvSet(this.viewTogglesKey(), JSON.stringify(message.toggles));
          } catch (err) {
            this.log.debug(`Failed to save view toggles: ${err}`);
          }
        }
        break;
      }

      default:
        await this.handleCustomMessage(message);
    }
  }

  /**
   * Override in subclasses to handle view-specific messages
   */
  protected async handleCustomMessage(
    _message: WebviewToExtensionMessage
  ): Promise<void> {
    // Default: do nothing
  }

  /**
   * Opens a file in the editor, optionally at a specific line
   */
  private async handleOpenFile(filePath: string, line?: number): Promise<void> {
    const project = this.projectManager.getActiveProject();
    if (!project) {
      vscode.window.showWarningMessage("No active project");
      return;
    }

    // Resolve path relative to project root
    const resolvedPath = filePath.startsWith("/")
      ? filePath
      : vscode.Uri.joinPath(vscode.Uri.file(project.rootPath), filePath).fsPath;

    const fileUri = vscode.Uri.file(resolvedPath);

    try {
      // Check if file exists
      await vscode.workspace.fs.stat(fileUri);

      // Open the file
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc);

      // If line specified, scroll to it
      if (line !== undefined && line > 0) {
        const lineIndex = line - 1; // VS Code uses 0-based line numbers
        const position = new vscode.Position(lineIndex, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter
        );
      }
    } catch (err) {
      vscode.window.showWarningMessage(`File not found: ${filePath}`);
    }
  }

  /**
   * Sends a message to the webview
   */
  protected postMessage(message: ExtensionToWebviewMessage): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  /**
   * Sets the loading state in the webview
   */
  protected setLoading(loading: boolean): void {
    this.postMessage({ type: "setLoading", loading });
  }

  /**
   * Sets an error message in the webview
   */
  protected setError(error: string | null): void {
    this.postMessage({ type: "setError", error });
  }

  /**
   * Handles connection errors - logs and shows output option
   */
  protected handleDaemonError(message: string, err: unknown): void {
    this.log.error(`${message}: ${err}`);
  }

  /**
   * Triggers a refresh of the view
   */
  public refresh(): void {
    // Update project state in webview
    const project = this.projectManager.getActiveProject();
    this.postMessage({ type: "setProject", project });

    // Also update projects list (for dropdown status indicators)
    const projects = this.projectManager.getProjects();
    this.postMessage({ type: "setProjects", projects });

    // Re-send team members (may have changed if project switched)
    this.projectManager.getTeamMembers().then((members) => {
      this.postMessage({ type: "setTeamMembers", members });
    }).catch((err) => {
      this.log.debug(`Failed to load team members: ${err}`);
    });

    // Re-send the (possibly different) project's persisted view toggles
    this.sendViewToggles().catch((err) => {
      this.log.debug(`Failed to send view toggles: ${err}`);
    });

    this.loadData().catch((err) => {
      this.log.error(`Unhandled error in loadData: ${err}`);
    });
  }

  /**
   * Generates the HTML content for the webview
   */
  protected getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js")
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.css")
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <title>Beads</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Generates a random nonce for CSP
   */
  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
