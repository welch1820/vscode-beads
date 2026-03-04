/**
 * BeadsProjectManager - Project Discovery and Active Project Management
 *
 * This service handles:
 * - Discovering Beads projects in the current VS Code workspace
 * - Managing the currently active project
 * - Connecting to bd CLI for data operations
 * - Real-time mutation tracking via filesystem watching
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { BeadsProject } from "./types";
import { BeadsCLIClient, MutationEvent } from "./BeadsCLIClient";
import { Logger } from "../utils/logger";

const ACTIVE_PROJECT_KEY = "beads.activeProjectId";

export class BeadsProjectManager implements vscode.Disposable {
  private projects: BeadsProject[] = [];
  private activeProject: BeadsProject | null = null;
  private client: BeadsCLIClient | null = null;
  private log: Logger;
  private context: vscode.ExtensionContext;
  private teamMembersCache: string[] | null = null;

  private readonly _onProjectsChanged = new vscode.EventEmitter<BeadsProject[]>();
  public readonly onProjectsChanged = this._onProjectsChanged.event;

  private readonly _onActiveProjectChanged = new vscode.EventEmitter<BeadsProject | null>();
  public readonly onActiveProjectChanged = this._onActiveProjectChanged.event;

  private readonly _onDataChanged = new vscode.EventEmitter<void>();
  public readonly onDataChanged = this._onDataChanged.event;

  private readonly _onMutation = new vscode.EventEmitter<MutationEvent>();
  public readonly onMutation = this._onMutation.event;

  constructor(context: vscode.ExtensionContext, logger: Logger) {
    this.context = context;
    this.log = logger.child("ProjectManager");
  }

  /**
   * Initializes the project manager by discovering all projects
   */
  async initialize(): Promise<void> {
    await this.discoverProjects();

    // Restore previously selected project, or default to first
    if (this.projects.length > 0 && !this.activeProject) {
      const savedProjectId = this.context.workspaceState.get<string>(ACTIVE_PROJECT_KEY);
      const targetProject = savedProjectId
        ? this.projects.find((p) => p.id === savedProjectId)
        : null;

      await this.setActiveProject(targetProject?.id || this.projects[0].id);
    }
  }

  /**
   * Discovers Beads projects in all workspace folders
   */
  async discoverProjects(): Promise<void> {
    this.log.info("Discovering Beads projects...");

    const discoveredProjects: BeadsProject[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders || [];

    // Check each workspace folder for a .beads directory
    for (const folder of workspaceFolders) {
      const beadsDir = path.join(folder.uri.fsPath, ".beads");

      try {
        const stats = await fs.promises.stat(beadsDir);
        if (stats.isDirectory()) {
          const project = await this.createProjectFromPath(
            folder.uri.fsPath,
            beadsDir,
            folder.name
          );
          discoveredProjects.push(project);
          this.log.info(`Found project: ${project.name} at ${project.rootPath}`);
        }
      } catch {
        // .beads directory doesn't exist in this folder, skip
      }
    }

    this.projects = discoveredProjects;
    this._onProjectsChanged.fire(this.projects);

    this.log.info(`Discovered ${this.projects.length} project(s)`);
  }

  /**
   * Creates a BeadsProject from a discovered path
   */
  private async createProjectFromPath(
    rootPath: string,
    beadsDir: string,
    folderName: string
  ): Promise<BeadsProject> {
    // Check if project is fully initialized (has dolt database)
    let status: "connected" | "disconnected" | "not_initialized" = "disconnected";
    const doltDir = path.join(beadsDir, "dolt");
    try {
      const stat = await fs.promises.stat(doltDir);
      if (stat.isDirectory()) {
        status = "connected";
      }
    } catch {
      status = "not_initialized";
    }

    return {
      id: this.generateProjectId(beadsDir),
      name: folderName,
      rootPath,
      beadsDir,
      status,
    };
  }

  /**
   * Generates a stable ID for a project based on its beads directory path
   */
  private generateProjectId(beadsDir: string): string {
    return crypto.createHash("sha256").update(beadsDir).digest("hex").slice(0, 12);
  }

  /**
   * Gets all discovered projects
   */
  getProjects(): BeadsProject[] {
    return this.projects;
  }

  /**
   * Gets the currently active project
   */
  getActiveProject(): BeadsProject | null {
    return this.activeProject;
  }

  /**
   * Gets the CLI client for the active project.
   * Returns null if the project is not connected (database missing/broken).
   * Use refresh() to re-check connectivity after fixing the database.
   */
  getClient(): BeadsCLIClient | null {
    if (!this.activeProject || this.activeProject.status !== "connected") {
      return null;
    }
    return this.client;
  }

  /**
   * Sets the active project by ID
   */
  async setActiveProject(projectId: string): Promise<boolean> {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) {
      this.log.warn(`Project not found: ${projectId}`);
      return false;
    }

    // Clean up previous client
    if (this.client) {
      this.client.stopMutationWatch();
      this.client.dispose();
    }

    this.activeProject = project;
    this.teamMembersCache = null; // Invalidate on project switch

    // Save selection to workspace state
    await this.context.workspaceState.update(ACTIVE_PROJECT_KEY, project.id);

    // Create CLI client
    this.client = new BeadsCLIClient(project.beadsDir, {
      cwd: project.rootPath,
    });

    this.log.info(`Active project set to: ${project.name}`);

    // Verify bd is available and project is initialized
    try {
      await this.client.health();
      project.status = "connected";
      this.log.info("bd CLI available, project connected");

      // Start file-based mutation watching
      this.setupMutationWatching();
    } catch (err) {
      this.log.warn(`bd CLI not available or project not initialized: ${err}`);
      project.status = "disconnected";
    }

    this._onActiveProjectChanged.fire(this.activeProject);
    this._onDataChanged.fire();

    return true;
  }

  /**
   * Sets up file-based mutation watching for the active project
   */
  private setupMutationWatching(): void {
    if (!this.client) return;

    this.client.on("mutation", (mutation: MutationEvent) => {
      this.log.debug(`Mutation: ${mutation.Type} on ${mutation.IssueID}`);
      this._onMutation.fire(mutation);
      this._onDataChanged.fire();
    });

    this.client.on("disconnected", (err: Error) => {
      if (this.activeProject) {
        this.log.warn(`File watcher error for "${this.activeProject.name}": ${err.message}`);
        this.activeProject.status = "disconnected";
        this._onActiveProjectChanged.fire(this.activeProject);
      }
    });

    this.client.startMutationWatch();
    this._onActiveProjectChanged.fire(this.activeProject);
    this._onDataChanged.fire();
  }

  /**
   * Check connection status by running bd info
   */
  async getConnectionStatus(): Promise<{
    state: "connected" | "disconnected" | "not_initialized";
    message: string;
  }> {
    if (!this.activeProject) {
      return { state: "disconnected", message: "No active project" };
    }

    // Check if .beads/dolt/ exists
    const doltDir = path.join(this.activeProject.beadsDir, "dolt");
    try {
      const stat = await fs.promises.stat(doltDir);
      if (!stat.isDirectory()) {
        return { state: "not_initialized", message: "Run 'bd init' to initialize." };
      }
    } catch {
      return { state: "not_initialized", message: "Run 'bd init' to initialize." };
    }

    // Try bd info to verify CLI works
    if (this.client) {
      try {
        await this.client.health();
        return { state: "connected", message: "Connected" };
      } catch (err) {
        return { state: "disconnected", message: `bd error: ${err}` };
      }
    }

    return { state: "disconnected", message: "No client" };
  }

  /**
   * Refreshes data for the active project.
   * Re-checks connectivity, so this can recover from a broken database.
   */
  async refresh(): Promise<void> {
    if (!this.activeProject || !this.client) {
      return;
    }

    const previousStatus = this.activeProject.status;
    const status = await this.getConnectionStatus();
    this.activeProject.status = status.state;

    // If we just recovered from disconnected, start mutation watching
    if (previousStatus !== "connected" && status.state === "connected") {
      this.log.info("Database recovered, starting mutation watch");
      this.setupMutationWatching();
    }

    this._onDataChanged.fire();
  }

  /**
   * Shows a quick pick to select a project
   */
  async showProjectPicker(): Promise<BeadsProject | undefined> {
    if (this.projects.length === 0) {
      vscode.window.showWarningMessage(
        "No Beads projects found. Initialize a project with `bd init` first."
      );
      return undefined;
    }

    const items = this.projects.map((project) => ({
      label: project.name,
      description: project.rootPath,
      detail: `Status: ${project.status}`,
      project,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a Beads project",
      title: "Switch Beads Project",
    });

    if (selected) {
      await this.setActiveProject(selected.project.id);
      return selected.project;
    }

    return undefined;
  }

  /**
   * Returns a merged, deduplicated list of team members from:
   * 1. Git commit history (author emails)
   * 2. bd config team.members
   * Results are cached per project activation.
   */
  async getTeamMembers(): Promise<string[]> {
    if (this.teamMembersCache) {
      return this.teamMembersCache;
    }

    const members = new Set<string>();
    const rootPath = this.activeProject?.rootPath;
    if (!rootPath) {
      return [];
    }

    // Source 1: Git commit authors (emails)
    try {
      const gitEmails = await this.execSimple("git", ["log", "--format=%aE", "--all"], rootPath);
      for (const email of gitEmails.split("\n")) {
        const trimmed = email.trim().toLowerCase();
        if (trimmed) {
          members.add(trimmed);
        }
      }
    } catch (err) {
      this.log.debug(`Git history unavailable: ${err}`);
    }

    // Source 2: bd config team.members
    try {
      const configResult = await this.execSimple("bd", ["config", "get", "team.members"], rootPath);
      const trimmed = configResult.trim();
      if (trimmed) {
        for (const member of trimmed.split(",")) {
          const m = member.trim();
          if (m) {
            members.add(m);
          }
        }
      }
    } catch {
      // team.members not configured — that's fine
    }

    this.teamMembersCache = Array.from(members).sort();
    this.log.info(`Team members discovered: ${this.teamMembersCache.length}`);
    return this.teamMembersCache;
  }

  /**
   * Runs a command and returns stdout as a string
   */
  private execSimple(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd, timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  dispose(): void {
    if (this.client) {
      this.client.stopMutationWatch();
      this.client.dispose();
    }
    this._onProjectsChanged.dispose();
    this._onActiveProjectChanged.dispose();
    this._onDataChanged.dispose();
    this._onMutation.dispose();
  }
}
