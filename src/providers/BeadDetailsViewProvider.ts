/**
 * BeadDetailsViewProvider - Provides the Bead Details view
 *
 * Features:
 * - Full view/edit of a single bead
 * - Editable fields: title, description, status, priority, type, labels, assignee
 * - Dependency management
 * - View in graph button
 */

import * as vscode from "vscode";
import { BaseViewProvider } from "./BaseViewProvider";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { WebviewToExtensionMessage, Bead, BeadStatus, issueToWebviewBead } from "../backend/types";
import { Logger } from "../utils/logger";
import { handleStartWork } from "../utils/startWork";
import { BugzillaClient, BugzillaConfig, resolveConfig } from "../backend/BugzillaClient";

export class BeadDetailsViewProvider extends BaseViewProvider {
  protected readonly viewType = "beadsDetails";
  private currentBeadId: string | null = null;
  private currentBeadStatus: BeadStatus | null = null;
  private currentProjectId: string | null = null;
  private loadSequence = 0; // Tracks request order to prevent stale responses

  // Cached data shared across selections — refreshed on mutation events via refresh()
  private cachedAllBeads: Bead[] | null = null;
  private cachedBlockedIds: Set<string> | null = null;

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger.child("Details"));
  }

  /**
   * Show details for a specific bead
   */
  public async showBead(beadId: string): Promise<void> {
    this.currentBeadId = beadId;
    this.currentProjectId = this.projectManager.getActiveProject()?.id || null;

    // Update context for conditional menu items
    vscode.commands.executeCommand("setContext", "beads.hasSelectedBead", true);

    // Auto-expand the details panel
    if (this._view) {
      this._view.show(true); // true = preserve focus
    }

    await this.loadData();
  }

  /**
   * Get the currently displayed bead ID
   */
  public getCurrentBeadId(): string | null {
    return this.currentBeadId;
  }

  /**
   * Clear the current bead (e.g., when switching projects)
   */
  public clearBead(): void {
    this.currentBeadId = null;
    vscode.commands.executeCommand("setContext", "beads.hasSelectedBead", false);
    this.postMessage({ type: "setBead", bead: null });
    this.setLoading(false);
  }

  /**
   * Invalidate cached data so next loadData() re-fetches from CLI.
   * Called by refresh() on mutation events.
   */
  public invalidateCache(): void {
    this.cachedAllBeads = null;
    this.cachedBlockedIds = null;
  }

  protected async loadData(): Promise<void> {
    // Increment sequence to track this request - prevents stale responses from
    // overwriting newer data when multiple refreshes occur in rapid succession
    const thisRequest = ++this.loadSequence;

    const client = this.projectManager.getClient();
    const activeProjectId = this.projectManager.getActiveProject()?.id;

    // Clear selection and cache if project changed
    if (this.currentProjectId && activeProjectId !== this.currentProjectId) {
      this.currentBeadId = null;
      this.currentProjectId = activeProjectId || null;
      this.invalidateCache();
    }

    if (!this.currentBeadId) {
      this.postMessage({ type: "setBead", bead: null });
      this.setLoading(false);
      return;
    }

    // Bugzilla bugs (bz-NNN) are fetched directly from Bugzilla, not bd
    if (this.currentBeadId.startsWith("bz-")) {
      await this.loadBugzillaBead(thisRequest);
      return;
    }

    if (!client) {
      this.postMessage({ type: "setBead", bead: null });
      this.setLoading(false);
      return;
    }

    this.setLoading(true);
    this.setError(null);

    try {
      // Fast path: only fetch the selected bead (1 CLI call).
      // Use cached list/blocked data if available; refresh them in background if stale.
      const issue = await client.show(this.currentBeadId);

      // Check if a newer request has started - if so, discard this stale response
      if (thisRequest !== this.loadSequence) {
        this.log.debug(`Discarding stale response (request ${thisRequest}, current ${this.loadSequence})`);
        return;
      }

      // Send cached beads list immediately (dependency picker)
      if (this.cachedAllBeads) {
        this.postMessage({ type: "setBeads", beads: this.cachedAllBeads });
      }

      // Comments are included in the show() response — no separate fetch needed
      const commentsArray = (issue?.comments ?? []) as Array<{ id: number; author: string; text: string; created_at: string }>;
      this.log.debug(`Loaded ${commentsArray.length} comments for ${this.currentBeadId}`);

      if (issue) {
        this.currentBeadStatus = issue.status as BeadStatus ?? null;
        const bead = issueToWebviewBead(issue);
        if (bead) {
          if (this.cachedBlockedIds?.has(bead.id)) {
            bead.isBlocked = true;
          }
          this.postMessage({ type: "setBead", bead });
        } else {
          this.setError("Invalid bead status");
          this.postMessage({ type: "setBead", bead: null });
        }
      } else {
        this.setError("Bead not found");
        this.postMessage({ type: "setBead", bead: null });
      }

      // Refresh cached list/blocked data in background if stale
      if (!this.cachedAllBeads || !this.cachedBlockedIds) {
        this.refreshCachedData(thisRequest, client);
      }
    } catch (err) {
      // Only handle error if this is still the current request
      if (thisRequest !== this.loadSequence) {
        return;
      }
      this.setError(String(err));
      this.postMessage({ type: "setBead", bead: null });
      this.handleDaemonError("Failed to load bead details", err);
    } finally {
      // Only update loading state if this is still the current request
      if (thisRequest === this.loadSequence) {
        this.setLoading(false);
      }
    }
  }

  /**
   * Refresh list/blocked caches in background and push updated data to webview.
   */
  private async refreshCachedData(
    thisRequest: number,
    client: ReturnType<BeadsProjectManager["getClient"]> & object
  ): Promise<void> {
    try {
      const [allIssues, blockedIds] = await Promise.all([
        client.list({ status: "all" }).catch((err) => {
          this.log.warn(`Failed to fetch beads list: ${err}`);
          return [];
        }),
        client.blocked().catch((err) => {
          this.log.warn(`Failed to fetch blocked IDs: ${err}`);
          return [] as string[];
        }),
      ]);

      this.cachedAllBeads = (allIssues || []).map(issueToWebviewBead).filter((b): b is Bead => b !== null);
      this.cachedBlockedIds = new Set(blockedIds);

      // Push updated data to webview if this is still the current request
      if (thisRequest === this.loadSequence) {
        this.postMessage({ type: "setBeads", beads: this.cachedAllBeads });
      }
    } catch (err) {
      this.log.warn(`Background cache refresh failed: ${err}`);
    }
  }

  private getBugzillaConfig(): BugzillaConfig {
    const config = vscode.workspace.getConfiguration("beads");
    const vsCodeConfig: BugzillaConfig = {
      url: config.get<string>("bugzilla.url", ""),
      apiKey: config.get<string>("bugzilla.apiKey", ""),
      username: config.get<string>("bugzilla.username", "")
        || config.get<string>("userId", "")
        || process.env.USER || "",
    };
    return resolveConfig(vsCodeConfig);
  }

  private async loadBugzillaBead(thisRequest: number): Promise<void> {
    this.setLoading(true);
    this.setError(null);

    try {
      const bzConfig = this.getBugzillaConfig();
      if (!BugzillaClient.isConfigured(bzConfig)) {
        this.setError("Bugzilla not configured");
        this.postMessage({ type: "setBead", bead: null });
        return;
      }

      const bugId = parseInt(this.currentBeadId!.replace("bz-", ""), 10);
      const bead = await new BugzillaClient(bzConfig).fetchBug(bugId);

      if (thisRequest !== this.loadSequence) {
        return;
      }

      if (bead) {
        this.currentBeadStatus = bead.status as BeadStatus ?? null;
        this.postMessage({ type: "setBead", bead });
      } else {
        this.setError("Bugzilla bug not found");
        this.postMessage({ type: "setBead", bead: null });
      }
    } catch (err) {
      if (thisRequest !== this.loadSequence) {
        return;
      }
      this.setError(String(err));
      this.postMessage({ type: "setBead", bead: null });
    } finally {
      if (thisRequest === this.loadSequence) {
        this.setLoading(false);
      }
    }
  }

  /**
   * Override refresh to invalidate caches before reloading.
   * Called on mutation events — ensures fresh list/blocked data.
   */
  public override refresh(): void {
    this.invalidateCache();
    super.refresh();
  }

  protected async handleCustomMessage(
    message: WebviewToExtensionMessage
  ): Promise<void> {
    const client = this.projectManager.getClient();
    if (!client) {
      return;
    }

    switch (message.type) {
      case "updateBead":
        this.log.debug(`Updating bead ${message.beadId}: ${JSON.stringify(message.updates)}`);

        try {
          // Map webview field names (camelCase) to daemon API field names (snake_case)
          const {
            labels,
            externalRef,
            acceptanceCriteria,
            estimatedMinutes,
            bugzillaId,
            type: issueType,
            ...rest
          } = message.updates;
          const updateArgs: Record<string, unknown> = {
            id: message.beadId,
            ...rest,
          };
          // Map webview 'type' to CLI 'issue_type'
          if (issueType !== undefined) {
            updateArgs.issue_type = issueType;
          }
          // Daemon uses set_labels instead of labels
          if (labels !== undefined) {
            updateArgs.set_labels = labels;
          }
          // Map camelCase to snake_case
          if (externalRef !== undefined) {
            updateArgs.external_ref = externalRef;
          }
          if (acceptanceCriteria !== undefined) {
            updateArgs.acceptance_criteria = acceptanceCriteria;
          }
          if (estimatedMinutes !== undefined) {
            updateArgs.estimated_minutes = estimatedMinutes;
          }
          // Handle bugzillaId via metadata
          if (bugzillaId !== undefined) {
            if (typeof bugzillaId === "number") {
              updateArgs.set_metadata = { bugzilla_id: String(bugzillaId) };
              // Auto-populate external_ref with Bugzilla URL unless already set to something else
              const bzConfig = this.getBugzillaConfig();
              const bugzillaUrl = bzConfig.url ? `${bzConfig.url.replace(/\/+$/, "")}/show_bug.cgi?id=${bugzillaId}` : "";
              if (!externalRef) {
                updateArgs.external_ref = bugzillaUrl;
              }
            } else {
              // null = clearing
              updateArgs.unset_metadata = ["bugzilla_id"];
            }
          }
          await client.update(updateArgs as unknown as Parameters<typeof client.update>[0]);

          // Offer to start work when transitioning open → in_progress
          if (
            message.updates.status === "in_progress" &&
            this.currentBeadStatus === "open"
          ) {
            handleStartWork(message.beadId, client, this.log);
          }
          // Data will refresh via mutation events
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to update bead: ${err}`);
        }
        break;

      case "addDependency":
        try {
          // When reverse=true, swap direction: target depends on current bead
          const fromId = message.reverse ? message.targetId : message.beadId;
          const toId = message.reverse ? message.beadId : message.targetId;
          await client.addDependency({
            from_id: fromId,
            to_id: toId,
            dep_type: message.dependencyType,
          });
          // Data will refresh via mutation events
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to add dependency: ${err}`);
        }
        break;

      case "removeDependency":
        try {
          await client.removeDependency({
            from_id: message.beadId,
            to_id: message.dependsOnId,
          });
          // Data will refresh via mutation events
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to remove dependency: ${err}`);
        }
        break;

      case "addComment":
        try {
          // Get username from environment or default
          const author = process.env.USER || process.env.USERNAME || "vscode";
          await client.addComment({
            id: message.beadId,
            author,
            text: message.text,
          });
          // Refresh to show new comment
          await this.loadData();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to add comment: ${err}`);
        }
        break;

      case "deleteBead": {
        const confirm = await vscode.window.showWarningMessage(
          `Delete bead ${message.beadId}? This cannot be undone.`,
          { modal: true },
          "Delete"
        );
        if (confirm === "Delete") {
          try {
            await client.delete(message.beadId);
            this.clearBead();
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to delete bead: ${err}`);
          }
        }
        break;
      }

      case "viewInGraph":
        vscode.commands.executeCommand("beadsGraph.focus");
        break;
    }
  }
}
