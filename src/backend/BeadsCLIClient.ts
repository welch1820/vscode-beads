/**
 * BeadsCLIClient - CLI-based client for Beads (replaces BeadsDaemonClient)
 *
 * Executes `bd` CLI commands with `--json` output instead of connecting to
 * a daemon socket. Drop-in replacement: same public API so view providers
 * need zero changes.
 */

import * as path from "path";
import * as fs from "fs";
import { EventEmitter } from "events";
import { spawn } from "child_process";

// ── Types (previously in BeadsDaemonClient.ts) ────────────────────

export interface Issue {
  id: string;
  title: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  status: string;
  priority: number;
  issue_type: string;
  assignee?: string;
  owner?: string;
  labels?: string[];
  estimated_minutes?: number;
  external_ref?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  dependencies?: IssueDependency[];
  dependents?: IssueDependency[];
  comments?: IssueComment[];
  metadata?: Record<string, unknown>;
}

export interface IssueComment {
  id: number;
  author: string;
  text: string;
  created_at: string;
}

export interface IssueDependency {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  dependency_type: string;
  // bd list returns raw join format with these fields instead of id/dependency_type
  issue_id?: string;
  depends_on_id?: string;
  type?: string;
}

export interface CreateArgs {
  id?: string;
  title: string;
  description?: string;
  issue_type?: string;
  priority?: number;
  design?: string;
  acceptance_criteria?: string;
  assignee?: string;
  external_ref?: string;
  labels?: string[];
  dependencies?: string[];
}

export interface UpdateArgs {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  assignee?: string;
  external_ref?: string;
  estimated_minutes?: number;
  add_labels?: string[];
  remove_labels?: string[];
  set_labels?: string[];
  set_metadata?: Record<string, string>;
  unset_metadata?: string[];
}

export interface CloseArgs {
  id: string;
  reason?: string;
}

export interface ListArgs {
  query?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  assignee?: string;
  labels?: string[];
  labels_any?: string[];
  ids?: string[];
  limit?: number;
  title_contains?: string;
  description_contains?: string;
}

export interface ReadyArgs {
  assignee?: string;
  priority?: number;
  limit?: number;
  labels?: string[];
}

export interface DepAddArgs {
  from_id: string;
  to_id: string;
  dep_type: string;
}

export interface DepRemoveArgs {
  from_id: string;
  to_id: string;
  dep_type?: string;
}

export interface LabelArgs {
  id: string;
  label: string;
}

export interface CommentAddArgs {
  id: string;
  author: string;
  text: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  client_version?: string;
  compatible: boolean;
  uptime_seconds: number;
  db_response_ms: number;
  active_connections: number;
  max_connections: number;
  memory_alloc_mb: number;
  error?: string;
}

export interface StatusResponse {
  version: string;
  workspace_path: string;
  database_path: string;
  socket_path: string;
  pid: number;
  uptime_seconds: number;
  last_activity_time: string;
  exclusive_lock_active: boolean;
  exclusive_lock_holder?: string;
}

export interface StatsResponse {
  total: number;
  open: number;
  in_progress: number;
  blocked: number;
  closed: number;
  by_type: Record<string, number>;
  by_priority: Record<string, number>;
  by_assignee: Record<string, number>;
}

export interface MutationEvent {
  Type: string;
  IssueID: string;
  Timestamp: string;
}

export interface ClientOptions {
  timeout?: number;
  cwd?: string;
}

const DEFAULT_TIMEOUT = 30000;
const DEBOUNCE_MS = 500;

export class BeadsCLIClient extends EventEmitter {
  private beadsDir: string;
  private cwd: string;
  private timeout: number;
  private connected: boolean = false;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  // Serialize all bd commands — concurrent Dolt embedded DB access causes panics
  private commandQueue: Promise<unknown> = Promise.resolve();

  constructor(beadsDir: string, options: ClientOptions = {}) {
    super();
    this.beadsDir = beadsDir;
    this.cwd = options.cwd || path.dirname(beadsDir);
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  static findBeadsDir(startPath: string): string | null {
    let current = startPath;
    const root = path.parse(current).root;
    while (current !== root) {
      const beadsDir = path.join(current, ".beads");
      if (fs.existsSync(beadsDir) && fs.statSync(beadsDir).isDirectory()) {
        return beadsDir;
      }
      current = path.dirname(current);
    }
    return null;
  }

  // ── Core execution ───────────────────────────────────────────────

  /**
   * Spawn `bd` with args, collect stdout, parse JSON, throw on non-zero exit.
   * Commands are serialized to prevent concurrent Dolt database access panics.
   */
  private execBd(args: string[]): Promise<unknown> {
    const result = this.commandQueue.then(
      () => this.spawnBd(args),
      () => this.spawnBd(args) // Run even if previous command failed
    );
    this.commandQueue = result.catch(() => {}); // Keep queue moving on errors
    return result;
  }

  private spawnBd(args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      const proc = spawn("bd", args, {
        cwd: this.cwd,
        timeout: this.timeout,
        env: { ...process.env },
      });

      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

      proc.on("error", (err: Error) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("bd not found on PATH. Install beads: https://github.com/steveyegge/beads"));
        } else {
          reject(err);
        }
      });

      proc.on("close", (code: number | null) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `bd exited with code ${code}`));
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(trimmed));
        } catch {
          // Non-JSON output (e.g. from bd update/delete) — resolve with raw string
          resolve(trimmed);
        }
      });
    });
  }

  // ── Queries ──────────────────────────────────────────────────────

  async list(args: ListArgs = {}): Promise<Issue[]> {
    const cmd = ["list", "--json", "--flat"];
    if (args.status) { cmd.push(`--status=${args.status}`); }
    if (args.priority !== undefined) { cmd.push(`--priority=${args.priority}`); }
    if (args.assignee) { cmd.push(`--assignee=${args.assignee}`); }
    if (args.issue_type) { cmd.push(`--type=${args.issue_type}`); }
    if (args.labels && args.labels.length > 0) {
      for (const l of args.labels) { cmd.push(`--label=${l}`); }
    }
    if (args.limit) { cmd.push(`--limit=${args.limit}`); }
    const result = await this.execBd(cmd);
    if (Array.isArray(result)) {
      return result as Issue[];
    }
    // Some bd versions wrap the array in an object (e.g., { issues: [...] })
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const obj = result as Record<string, unknown>;
      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) return val as Issue[];
      }
    }
    return [];
  }

  async show(id: string): Promise<Issue | null> {
    try {
      const result = await this.execBd(["show", id, "--json"]);
      // bd show returns an array with one element
      if (Array.isArray(result) && result.length > 0) {
        return result[0] as Issue;
      }
      return result as Issue | null;
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes("not found")) {
        return null;
      }
      throw err;
    }
  }

  async ready(args: ReadyArgs = {}): Promise<Issue[]> {
    const cmd = ["ready", "--json"];
    if (args.assignee) { cmd.push(`--assignee=${args.assignee}`); }
    if (args.priority !== undefined) { cmd.push(`--priority=${args.priority}`); }
    if (args.limit) { cmd.push(`--limit=${args.limit}`); }
    const result = await this.execBd(cmd);
    return Array.isArray(result) ? (result as Issue[]) : [];
  }

  async blocked(): Promise<string[]> {
    try {
      const result = await this.execBd(["blocked", "--json"]);
      if (Array.isArray(result)) {
        return result.map((item: { id?: string }) => item.id ?? "").filter(Boolean);
      }
      return [];
    } catch {
      return [];
    }
  }

  /** Returns a map of blocked bead ID → array of blocker IDs */
  async blockedByMap(): Promise<Map<string, string[]>> {
    try {
      const result = await this.execBd(["blocked", "--json"]);
      const map = new Map<string, string[]>();
      if (Array.isArray(result)) {
        for (const item of result) {
          const id = item.id ?? "";
          const blockers = Array.isArray(item.blocked_by) ? item.blocked_by : [];
          if (id) map.set(id, blockers);
        }
      }
      return map;
    } catch {
      return new Map();
    }
  }

  async stats(): Promise<StatsResponse> {
    const result = await this.execBd(["stats", "--json"]) as {
      summary?: {
        total_issues?: number;
        open_issues?: number;
        in_progress_issues?: number;
        blocked_issues?: number;
        closed_issues?: number;
      };
    } | null;
    const s = result?.summary ?? {};
    return {
      total: s.total_issues ?? 0,
      open: s.open_issues ?? 0,
      in_progress: s.in_progress_issues ?? 0,
      blocked: s.blocked_issues ?? 0,
      closed: s.closed_issues ?? 0,
      by_type: {},
      by_priority: {},
      by_assignee: {},
    };
  }

  async listComments(id: string): Promise<IssueComment[]> {
    const issue = await this.show(id);
    return (issue?.comments as IssueComment[]) ?? [];
  }

  // ── Mutations ────────────────────────────────────────────────────

  async create(args: CreateArgs): Promise<Issue> {
    const cmd = ["create", args.title, "--json"];
    if (args.issue_type) { cmd.push(`--type=${args.issue_type}`); }
    if (args.priority !== undefined) { cmd.push(`--priority=${args.priority}`); }
    if (args.assignee) { cmd.push(`--assignee=${args.assignee}`); }
    if (args.description) { cmd.push(`--description=${args.description}`); }
    if (args.design) { cmd.push(`--design=${args.design}`); }
    if (args.acceptance_criteria) { cmd.push(`--acceptance=${args.acceptance_criteria}`); }
    if (args.external_ref) { cmd.push(`--external-ref=${args.external_ref}`); }
    if (args.labels && args.labels.length > 0) {
      cmd.push(`--labels=${args.labels.join(",")}`);
    }
    const result = await this.execBd(cmd);
    return result as Issue;
  }

  async update(args: UpdateArgs): Promise<Issue> {
    const cmd = ["update", args.id];
    if (args.title) { cmd.push(`--title=${args.title}`); }
    if (args.status) { cmd.push(`--status=${args.status}`); }
    if (args.priority !== undefined) { cmd.push(`--priority=${args.priority}`); }
    if (args.issue_type) { cmd.push(`--type=${args.issue_type}`); }
    if (args.assignee) { cmd.push(`--assignee=${args.assignee}`); }
    if (args.description) { cmd.push(`--description=${args.description}`); }
    if (args.design) { cmd.push(`--design=${args.design}`); }
    if (args.acceptance_criteria) { cmd.push(`--acceptance=${args.acceptance_criteria}`); }
    if (args.notes) { cmd.push(`--notes=${args.notes}`); }
    if (args.external_ref) { cmd.push(`--external-ref=${args.external_ref}`); }
    if (args.estimated_minutes !== undefined) { cmd.push(`--estimate=${args.estimated_minutes}`); }
    if (args.set_labels && args.set_labels.length > 0) {
      cmd.push(`--set-labels=${args.set_labels.join(",")}`);
    }
    if (args.add_labels) {
      for (const l of args.add_labels) { cmd.push(`--add-label=${l}`); }
    }
    if (args.remove_labels) {
      for (const l of args.remove_labels) { cmd.push(`--remove-label=${l}`); }
    }
    if (args.set_metadata) {
      for (const [k, v] of Object.entries(args.set_metadata)) { cmd.push(`--set-metadata`, `${k}=${v}`); }
    }
    if (args.unset_metadata) {
      for (const k of args.unset_metadata) { cmd.push(`--unset-metadata`, k); }
    }
    // bd update doesn't return JSON — re-fetch
    await this.execBd(cmd);
    const updated = await this.show(args.id);
    return updated as Issue;
  }

  async close(args: CloseArgs): Promise<Issue> {
    await this.execBd(["update", args.id, "--status=closed"]);
    const updated = await this.show(args.id);
    return updated as Issue;
  }

  async delete(id: string): Promise<void> {
    await this.execBd(["delete", id, "--force"]);
  }

  async addDependency(args: DepAddArgs): Promise<void> {
    const cmd = ["dep", "add", args.from_id, args.to_id];
    if (args.dep_type) { cmd.push(`--type=${args.dep_type}`); }
    await this.execBd(cmd);
  }

  async removeDependency(args: DepRemoveArgs): Promise<void> {
    await this.execBd(["dep", "remove", args.from_id, args.to_id]);
  }

  async addLabel(args: LabelArgs): Promise<void> {
    await this.execBd(["label", "add", args.id, args.label]);
  }

  async removeLabel(args: LabelArgs): Promise<void> {
    await this.execBd(["label", "remove", args.id, args.label]);
  }

  async addComment(args: CommentAddArgs): Promise<void> {
    const cmd = ["comments", "add", args.id, args.text];
    if (args.author) { cmd.push(`--author=${args.author}`); }
    await this.execBd(cmd);
  }

  // ── Connection / Health ──────────────────────────────────────────

  isConnected(): boolean {
    return this.connected;
  }

  /** Compat — checks if .beads/ directory exists */
  socketExists(): boolean {
    try {
      return fs.existsSync(this.beadsDir) && fs.statSync(this.beadsDir).isDirectory();
    } catch {
      return false;
    }
  }

  async health(): Promise<HealthResponse> {
    const info = await this.execBd(["info", "--json"]) as Record<string, unknown> | null;
    this.connected = true;
    return {
      status: "healthy",
      version: String(info?.version ?? "unknown"),
      compatible: true,
      uptime_seconds: 0,
      db_response_ms: 0,
      active_connections: 0,
      max_connections: 0,
      memory_alloc_mb: 0,
    };
  }

  async ping(): Promise<{ message: string; version: string }> {
    const info = await this.execBd(["info", "--json"]) as Record<string, unknown> | null;
    this.connected = true;
    return {
      message: "pong",
      version: String(info?.version ?? "unknown"),
    };
  }

  async status(): Promise<StatusResponse> {
    const info = await this.execBd(["info", "--json"]) as Record<string, unknown> | null;
    this.connected = true;
    return {
      version: String(info?.version ?? "unknown"),
      workspace_path: this.cwd,
      database_path: String(info?.database_path ?? info?.database ?? ""),
      socket_path: "",
      pid: 0,
      uptime_seconds: 0,
      last_activity_time: new Date().toISOString(),
      exclusive_lock_active: false,
    };
  }

  // ── Mutation watching (file-based) ───────────────────────────────

  startMutationWatch(_intervalMs?: number): void {
    if (this.watcher) { return; }
    this.connected = true;
    try {
      this.watcher = fs.watch(this.beadsDir, { recursive: true }, () => {
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
        this.debounceTimer = setTimeout(() => {
          const mutation: MutationEvent = {
            Type: "update",
            IssueID: "*",
            Timestamp: new Date().toISOString(),
          };
          this.emit("mutation", mutation);
        }, DEBOUNCE_MS);
      });
      this.watcher.on("error", () => {
        this.connected = false;
        this.emit("disconnected", new Error("File watcher error"));
      });
    } catch {
      this.connected = false;
    }
  }

  stopMutationWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  dispose(): void {
    this.stopMutationWatch();
  }
}
