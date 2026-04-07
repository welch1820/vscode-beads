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
import { BeadsProject } from "./types";
import { BeadsCLIClient, MutationEvent } from "./BeadsCLIClient";
import { Logger } from "../utils/logger";
import { TeamMemberService } from "./team/TeamMemberService";
import { GitLabTeamProvider } from "./team/GitLabTeamProvider";
import { GitLogTeamProvider } from "./team/GitLogTeamProvider";

const ACTIVE_PROJECT_KEY = "beads.activeProjectId";

export class BeadsProjectManager implements vscode.Disposable {
  private projects: BeadsProject[] = [];
  private activeProject: BeadsProject | null = null;
  private client: BeadsCLIClient | null = null;
  private log: Logger;
  private context: vscode.ExtensionContext;
  private teamService: TeamMemberService;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

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
    this.teamService = new TeamMemberService(logger);

    // Register providers in priority order: GitLab first, git log as fallback
    this.teamService.addProvider(
      new GitLabTeamProvider(() => {
        const config = vscode.workspace.getConfiguration("beads.gitlab");
        return {
          url: config.get<string>("url", ""),
          token: config.get<string>("token", ""),
        };
      })
    );
    this.teamService.addProvider(new GitLogTeamProvider());
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

  /** Directories to skip when scanning for .beads subdirectories */
  private static readonly SCAN_SKIP_DIRS = new Set([
    "node_modules", ".git", ".hg", ".svn", "dist", "build", "out",
    ".beads", "__pycache__", ".tox", "vendor", ".cache",
  ]);

  /**
   * Discovers Beads projects in all workspace folders,
   * scanning subfolders up to a configurable depth.
   * After discovery, annotates duplicate projects that share
   * the same database (same project_id in metadata.json).
   */
  async discoverProjects(): Promise<void> {
    this.log.info("Discovering Beads projects...");

    const discoveredProjects: BeadsProject[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const maxDepth = vscode.workspace
      .getConfiguration("beads")
      .get<number>("scanDepth", 3);

    for (const folder of workspaceFolders) {
      const found = await this.scanForBeadsProjects(
        folder.uri.fsPath,
        folder.name,
        0,
        maxDepth
      );
      discoveredProjects.push(...found);
    }

    // Annotate duplicates: projects sharing the same project_id
    const byProjectId = new Map<string, BeadsProject[]>();
    for (const p of discoveredProjects) {
      if (p.projectId) {
        const group = byProjectId.get(p.projectId) || [];
        group.push(p);
        byProjectId.set(p.projectId, group);
      }
    }
    for (const group of byProjectId.values()) {
      if (group.length > 1) {
        for (const p of group) {
          p.duplicatePaths = group
            .filter((other) => other.rootPath !== p.rootPath)
            .map((other) => other.rootPath);
        }
      }
    }

    this.projects = discoveredProjects;
    this._onProjectsChanged.fire(this.projects);

    this.log.info(`Discovered ${this.projects.length} project(s)`);
  }

  /**
   * Recursively scans a directory for .beads subdirectories.
   * Every .beads at any depth is discovered. Child directories are
   * always scanned so that a workspace root with its own .beads still
   * discovers projects in subfolders.
   */
  private async scanForBeadsProjects(
    dir: string,
    displayName: string,
    depth: number,
    maxDepth: number
  ): Promise<BeadsProject[]> {
    const results: BeadsProject[] = [];

    const beadsDir = path.join(dir, ".beads");
    try {
      const stats = await fs.promises.stat(beadsDir);
      if (stats.isDirectory()) {
        const project = await this.createProjectFromPath(dir, beadsDir, displayName);
        this.log.info(`Found project: ${project.name} at ${project.rootPath}`);
        results.push(project);
      }
    } catch {
      // no .beads here
    }

    // Don't recurse past the depth limit
    if (depth >= maxDepth) {
      return results;
    }

    // Scan child directories
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") ||
          BeadsProjectManager.SCAN_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const childPath = path.join(dir, entry.name);
      const found = await this.scanForBeadsProjects(
        childPath,
        entry.name,
        depth + 1,
        maxDepth
      );
      results.push(...found);
    }
    return results;
  }

  /**
   * Checks whether a .beads/config.yaml has server-host and server-port,
   * indicating the project uses a central Dolt server (no local dolt/ dir).
   */
  private async hasCentralServerConfig(beadsDir: string): Promise<boolean> {
    try {
      const configPath = path.join(beadsDir, "config.yaml");
      const content = await fs.promises.readFile(configPath, "utf-8");
      // Match uncommented server-host and server-port lines
      const hasHost = /^server-host:\s*\S/m.test(content);
      const hasPort = /^server-port:\s*\d/m.test(content);
      return hasHost && hasPort;
    } catch {
      return false;
    }
  }

  /**
   * Creates a BeadsProject from a discovered path
   */
  private async createProjectFromPath(
    rootPath: string,
    beadsDir: string,
    folderName: string
  ): Promise<BeadsProject> {
    // Check if project is fully initialized:
    // - local Dolt: .beads/dolt/ directory exists
    // - central server: config.yaml has server-host + server-port
    let status: "connected" | "disconnected" | "not_initialized" = "disconnected";
    const doltDir = path.join(beadsDir, "dolt");
    try {
      const stat = await fs.promises.stat(doltDir);
      if (stat.isDirectory()) {
        status = "connected";
      }
    } catch {
      // No local dolt dir — check for central server config
      if (await this.hasCentralServerConfig(beadsDir)) {
        status = "connected";
      } else {
        status = "not_initialized";
      }
    }

    // Read project_id from metadata.json for duplicate detection
    let projectId: string | undefined;
    try {
      const metaPath = path.join(beadsDir, "metadata.json");
      const metaContent = await fs.promises.readFile(metaPath, "utf-8");
      const meta = JSON.parse(metaContent);
      if (meta.project_id) {
        projectId = String(meta.project_id);
      }
    } catch {
      // No metadata.json or invalid — projectId stays undefined
    }

    return {
      id: this.generateProjectId(beadsDir),
      name: folderName,
      rootPath,
      beadsDir,
      status,
      projectId,
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

    // Clean up previous client and poll timer
    this.stopPollTimer();
    if (this.client) {
      this.client.stopMutationWatch();
      this.client.dispose();
    }

    this.activeProject = project;
    this.teamService.invalidate();

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

      // Start file-based mutation watching (+ polling for central server projects)
      await this.setupMutationWatching();
    } catch (err) {
      this.log.warn(`bd CLI not available or project not initialized: ${err}`);
      project.status = "disconnected";
    }

    this._onActiveProjectChanged.fire(this.activeProject);
    this._onDataChanged.fire();

    return true;
  }

  /**
   * Sets up file-based mutation watching for the active project.
   * For central server projects (no local dolt/), also starts a periodic poll
   * since fs.watch won't detect server-side changes.
   */
  private async setupMutationWatching(): Promise<void> {
    if (!this.client || !this.activeProject) return;

    // Stop any existing poll timer from a previous project
    this.stopPollTimer();

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

    // Central server projects need periodic polling since local fs.watch
    // won't detect changes made on the remote Dolt server
    const hasLocalDolt = fs.existsSync(path.join(this.activeProject.beadsDir, "dolt"));
    if (!hasLocalDolt && await this.hasCentralServerConfig(this.activeProject.beadsDir)) {
      const pollIntervalMs = vscode.workspace.getConfiguration("beads")
        .get<number>("centralServerPollInterval", 30) * 1000;
      this.log.info(`Central server project "${this.activeProject.name}" — polling every ${pollIntervalMs / 1000}s`);
      this.pollTimer = setInterval(() => {
        this._onDataChanged.fire();
      }, pollIntervalMs);
    }

    this._onActiveProjectChanged.fire(this.activeProject);
    this._onDataChanged.fire();
  }

  private stopPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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

    // Check if .beads/dolt/ exists or central server is configured
    const doltDir = path.join(this.activeProject.beadsDir, "dolt");
    let hasLocalDolt = false;
    try {
      const stat = await fs.promises.stat(doltDir);
      hasLocalDolt = stat.isDirectory();
    } catch {
      // no local dolt dir
    }
    if (!hasLocalDolt && !(await this.hasCentralServerConfig(this.activeProject.beadsDir))) {
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
      await this.setupMutationWatching();
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
   * Returns team members via provider chain (GitLab, git log, etc.)
   * with persistent file cache in .beads/team-members.json.
   */
  async getTeamMembers(): Promise<string[]> {
    const project = this.activeProject;
    if (!project) {
      return [];
    }
    return this.teamService.getMembers(project.beadsDir, project.rootPath);
  }

  dispose(): void {
    this.stopPollTimer();
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
