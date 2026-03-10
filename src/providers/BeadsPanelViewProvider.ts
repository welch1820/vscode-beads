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
import { BugzillaClient, BugzillaConfig, resolveConfig } from "../backend/BugzillaClient";
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

  protected async loadData(): Promise<void> {
    const client = this.projectManager.getClient();
    if (!client) {
      this.postMessage({ type: "setBeads", beads: [] });
      return;
    }

    this.setLoading(true);
    this.setError(null);

    try {
      // Fetch beads and Bugzilla bugs in parallel
      const bzConfig = this.getBugzillaConfig();
      const bzPromise = BugzillaClient.isConfigured(bzConfig)
        ? new BugzillaClient(bzConfig).fetchAssignedBugs().catch((err) => {
            this.log.warn(`Bugzilla fetch failed: ${err}`);
            return [] as Bead[];
          })
        : Promise.resolve([] as Bead[]);

      const [issues, blockedByMap, bzBeads] = await Promise.all([
        client.list({ status: "all" }),
        client.blockedByMap(),
        bzPromise,
      ]);
      const beads = issues
        .map(issueToWebviewBead)
        .filter((b): b is Bead => b !== null)
        .map((b) => {
          b.source = "beads";
          const blockers = blockedByMap.get(b.id);
          return blockers ? { ...b, isBlocked: true, blockedBy: blockers } : b;
        });

      // Enrich epics with their children (bd list doesn't include dependency details)
      const epics = beads.filter((b) => b.type === "epic");
      if (epics.length > 0) {
        const childResults = await Promise.all(
          epics.map((epic) => client.listDependents(epic.id))
        );
        for (let i = 0; i < epics.length; i++) {
          const children = childResults[i];
          if (children.length > 0) {
            epics[i].blocks = children.map((c) => ({ id: c.id, dependencyType: c.dependencyType as "parent-child" | undefined }));
          }
        }
      }

      this.postMessage({ type: "setBeads", beads: [...beads, ...bzBeads] });
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
        if (message.beadId.startsWith("bz-")) {
          vscode.window.showWarningMessage("Bugzilla bugs are read-only in this view.");
          break;
        }
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

      case "addDependency":
        try {
          const fromId = message.reverse ? message.targetId : message.beadId;
          const toId = message.reverse ? message.beadId : message.targetId;
          this.log.info(`addDependency: ${fromId} → ${toId} (type=${message.dependencyType}, reverse=${message.reverse})`);
          await client.addDependency({
            from_id: fromId,
            to_id: toId,
            dep_type: message.dependencyType,
          });
          this.log.info(`addDependency: success`);
          // Force refresh — epic children aren't in the mutation event data
          await this.loadData();
        } catch (err) {
          this.log.error(`addDependency: failed — ${err}`);
          vscode.window.showErrorMessage(`Failed to add dependency: ${err}`);
        }
        break;

      case "removeDependency":
        try {
          await client.removeDependency({
            from_id: message.beadId,
            to_id: message.dependsOnId,
          });
          await this.loadData();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to remove dependency: ${err}`);
        }
        break;

      case "reverseDependency":
        try {
          await client.removeDependency({
            from_id: message.removeFrom,
            to_id: message.removeTo,
          });
          await client.addDependency({
            from_id: message.addFrom,
            to_id: message.addTo,
            dep_type: message.depType,
          });
          // Force immediate refresh — fs.watch debounce may not catch both ops
          await this.loadData();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to reverse dependency: ${err}`);
        }
        break;

      case "deleteBead": {
        if (message.beadId.startsWith("bz-")) {
          vscode.window.showWarningMessage("Bugzilla bugs cannot be deleted from this view.");
          break;
        }
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
