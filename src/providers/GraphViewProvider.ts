import * as vscode from "vscode";
import { BaseViewProvider } from "./BaseViewProvider";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { Bead, DependencyGraph, DependencyType, issueToWebviewBead } from "../backend/types";
import { Logger } from "../utils/logger";

export class GraphViewProvider extends BaseViewProvider {
  protected readonly viewType = "beadsGraph";

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger.child("Graph"));
  }

  protected async loadData(): Promise<void> {
    const client = this.projectManager.getClient();
    if (!client) {
      this.postMessage({ type: "setGraph", graph: { nodes: [], edges: [] } });
      return;
    }

    this.setLoading(true);
    this.setError(null);

    try {
      const issues = await client.list({ status: "all" });
      const beads = issues.map(issueToWebviewBead).filter((b): b is Bead => b !== null);

      const graph = this.buildGraph(beads);
      this.postMessage({ type: "setGraph", graph });
    } catch (err) {
      this.setError(String(err));
      this.handleDaemonError("Failed to load graph", err);
    } finally {
      this.setLoading(false);
    }
  }

  /**
   * Centers the graph view on a specific bead
   */
  public highlightBead(beadId: string): void {
    this.postMessage({ type: "highlightNode", beadId });
  }

  private buildGraph(beads: Bead[]): DependencyGraph {
    const nodeIds = new Set(beads.map((b) => b.id));
    const edgeSet = new Set<string>();
    const edges: DependencyGraph["edges"] = [];

    for (const bead of beads) {
      // Edges from dependsOn: this bead depends on dep.id → dep.id blocks this bead
      if (bead.dependsOn) {
        for (const dep of bead.dependsOn) {
          if (!nodeIds.has(dep.id)) continue;
          const key = `${dep.id}->${bead.id}:${dep.dependencyType || "blocks"}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({
              from: dep.id,
              to: bead.id,
              type: (dep.dependencyType as DependencyType) || "blocks",
            });
          }
        }
      }

      // Edges from blocks: this bead blocks dep.id → this bead -> dep.id
      if (bead.blocks) {
        for (const dep of bead.blocks) {
          if (!nodeIds.has(dep.id)) continue;
          const key = `${bead.id}->${dep.id}:${dep.dependencyType || "blocks"}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({
              from: bead.id,
              to: dep.id,
              type: (dep.dependencyType as DependencyType) || "blocks",
            });
          }
        }
      }
    }

    return { nodes: beads, edges };
  }
}
