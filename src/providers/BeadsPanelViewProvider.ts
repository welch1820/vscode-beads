/**
 * BeadsPanelViewProvider - Provides the main Beads Panel view
 *
 * Features:
 * - Table/list view of all beads
 * - Column sorting
 * - Filtering by status, priority, labels, type
 * - Text search
 * - Click to open details
 */

import * as vscode from "vscode";
import { BaseViewProvider } from "./BaseViewProvider";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { WebviewToExtensionMessage, Bead, issueToWebviewBead } from "../backend/types";
import { Logger } from "../utils/logger";
import { handleStartWork } from "../utils/startWork";

export class BeadsPanelViewProvider extends BaseViewProvider {
  protected readonly viewType = "beadsPanel";
  private selectedBeadId: string | null = null;

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger.child("Panel"));
  }

  /**
   * Set the selected bead ID and notify webview
   */
  public setSelectedBead(beadId: string | null): void {
    this.selectedBeadId = beadId;
    this.postMessage({ type: "setSelectedBeadId", beadId });
  }

  protected async loadData(): Promise<void> {
    const client = this.projectManager.getClient();
    if (!client) {
      this.postMessage({ type: "setBeads", beads: [] });
      return;
    }

    this.setLoading(true);
    this.setError(null);

    try {
      const [issues, blockedByMap] = await Promise.all([
        client.list({ status: "all" }),
        client.blockedByMap(),
      ]);
      const beads = issues
        .map(issueToWebviewBead)
        .filter((b): b is Bead => b !== null)
        .map((b) => {
          const blockers = blockedByMap.get(b.id);
          return blockers ? { ...b, isBlocked: true, blockedBy: blockers } : b;
        });
      this.postMessage({ type: "setBeads", beads });
    } catch (err) {
      this.setError(String(err));
      this.postMessage({ type: "setBeads", beads: [] });
      this.handleDaemonError("Failed to load beads", err);
    } finally {
      this.setLoading(false);
    }
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
        try {
          // Check if this is an open → in_progress transition before updating
          let wasOpen = false;
          if (message.updates.status === "in_progress") {
            try {
              const oldBead = await client.show(message.beadId);
              wasOpen = oldBead?.status === "open";
            } catch {
              // Non-critical — proceed with update
            }
          }

          await client.update({
            id: message.beadId,
            ...message.updates,
          });

          // Offer to start work when transitioning open → in_progress
          if (wasOpen) {
            handleStartWork(message.beadId, client, this.log);
          }
          // Data will refresh via mutation events
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to update bead: ${err}`);
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
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to delete bead: ${err}`);
          }
        }
        break;
      }
    }
  }
}
