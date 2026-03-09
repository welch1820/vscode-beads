import { EventEmitter } from "events";
import { BeadsCLIClient } from "../backend/BeadsCLIClient";

// ── Mock child_process.spawn ─────────────────────────────────────

interface MockProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

let mockProcess: MockProcess;
let lastSpawnArgs: { cmd: string; args: string[]; opts: Record<string, unknown> } | null = null;

jest.mock("child_process", () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    lastSpawnArgs = { cmd, args, opts };
    mockProcess = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    return mockProcess;
  },
}));

// Mock fs for constructor and socketExists
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(true),
    statSync: jest.fn().mockReturnValue({ isDirectory: () => true }),
    watch: jest.fn().mockReturnValue({
      on: jest.fn(),
      close: jest.fn(),
    }),
  };
});

// ── Helpers ──────────────────────────────────────────────────────

function createClient(): BeadsCLIClient {
  return new BeadsCLIClient("/test/project/.beads", { cwd: "/test/project" });
}

/** Simulate bd producing stdout JSON and exiting 0. */
function resolveWith(data: unknown): void {
  const json = JSON.stringify(data);
  process.nextTick(() => {
    mockProcess.stdout.emit("data", Buffer.from(json));
    mockProcess.emit("close", 0);
  });
}

/** Simulate bd exiting 0 with no output. */
function resolveEmpty(): void {
  process.nextTick(() => {
    mockProcess.emit("close", 0);
  });
}

/** Simulate bd producing stderr and exiting non-zero. */
function rejectWith(stderr: string, code = 1): void {
  process.nextTick(() => {
    mockProcess.stderr.emit("data", Buffer.from(stderr));
    mockProcess.emit("close", code);
  });
}

/** Simulate bd not found (ENOENT). */
function rejectNotFound(): void {
  process.nextTick(() => {
    const err = new Error("spawn bd ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockProcess.emit("error", err);
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe("BeadsCLIClient", () => {
  let client: BeadsCLIClient;

  beforeEach(() => {
    lastSpawnArgs = null;
    client = createClient();
  });

  // ── list ─────────────────────────────────────────────────────

  describe("list", () => {
    it("calls bd list --json with no filters", async () => {
      const promise = client.list();
      resolveWith([{ id: "b-1", title: "Test", status: "open", priority: 2 }]);
      const result = await promise;

      expect(lastSpawnArgs!.cmd).toBe("bd");
      expect(lastSpawnArgs!.args).toEqual(["list", "--json", "--flat"]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("b-1");
    });

    it("includes --status flag when provided", async () => {
      const promise = client.list({ status: "open" });
      resolveWith([]);
      await promise;
      expect(lastSpawnArgs!.args).toContain("--status=open");
    });

    it("includes --priority flag when provided", async () => {
      const promise = client.list({ priority: 1 });
      resolveWith([]);
      await promise;
      expect(lastSpawnArgs!.args).toContain("--priority=1");
    });

    it("includes --assignee flag when provided", async () => {
      const promise = client.list({ assignee: "alice" });
      resolveWith([]);
      await promise;
      expect(lastSpawnArgs!.args).toContain("--assignee=alice");
    });

    it("includes --type flag when provided", async () => {
      const promise = client.list({ issue_type: "bug" });
      resolveWith([]);
      await promise;
      expect(lastSpawnArgs!.args).toContain("--type=bug");
    });

    it("includes multiple --label flags", async () => {
      const promise = client.list({ labels: ["ui", "backend"] });
      resolveWith([]);
      await promise;
      expect(lastSpawnArgs!.args).toContain("--label=ui");
      expect(lastSpawnArgs!.args).toContain("--label=backend");
    });

    it("includes --limit flag when provided", async () => {
      const promise = client.list({ limit: 10 });
      resolveWith([]);
      await promise;
      expect(lastSpawnArgs!.args).toContain("--limit=10");
    });

    it("returns empty array when bd returns null", async () => {
      const promise = client.list();
      resolveEmpty();
      const result = await promise;
      expect(result).toEqual([]);
    });
  });

  // ── show ─────────────────────────────────────────────────────

  describe("show", () => {
    it("calls bd show <id> --json", async () => {
      const promise = client.show("b-1");
      resolveWith([{ id: "b-1", title: "Test", status: "open", priority: 2 }]);
      const result = await promise;

      expect(lastSpawnArgs!.args).toEqual(["show", "b-1", "--json"]);
      expect(result!.id).toBe("b-1");
    });

    it("unwraps single-element array from bd show", async () => {
      const promise = client.show("b-2");
      resolveWith([{ id: "b-2", title: "Wrapped", status: "open", priority: 1 }]);
      const result = await promise;
      expect(result!.id).toBe("b-2");
    });

    it("returns null when issue not found", async () => {
      const promise = client.show("nonexistent");
      rejectWith("issue not found");
      const result = await promise;
      expect(result).toBeNull();
    });

    it("throws on non-not-found errors", async () => {
      const promise = client.show("b-3");
      rejectWith("database error");
      await expect(promise).rejects.toThrow("database error");
    });
  });

  // ── ready ────────────────────────────────────────────────────

  describe("ready", () => {
    it("calls bd ready --json", async () => {
      const promise = client.ready();
      resolveWith([]);
      await promise;
      expect(lastSpawnArgs!.args).toEqual(["ready", "--json"]);
    });

    it("includes filters", async () => {
      const promise = client.ready({ assignee: "bob", priority: 0, limit: 5 });
      resolveWith([]);
      await promise;
      expect(lastSpawnArgs!.args).toContain("--assignee=bob");
      expect(lastSpawnArgs!.args).toContain("--priority=0");
      expect(lastSpawnArgs!.args).toContain("--limit=5");
    });
  });

  // ── stats ────────────────────────────────────────────────────

  describe("stats", () => {
    it("calls bd stats --json and maps summary fields", async () => {
      const promise = client.stats();
      resolveWith({
        summary: {
          total_issues: 10,
          open_issues: 4,
          in_progress_issues: 2,
          blocked_issues: 1,
          closed_issues: 3,
        },
      });
      const result = await promise;

      expect(lastSpawnArgs!.args).toEqual(["stats", "--json"]);
      expect(result.total).toBe(10);
      expect(result.open).toBe(4);
      expect(result.in_progress).toBe(2);
      expect(result.blocked).toBe(1);
      expect(result.closed).toBe(3);
    });

    it("defaults to zeros when summary is missing", async () => {
      const promise = client.stats();
      resolveWith({});
      const result = await promise;

      expect(result.total).toBe(0);
      expect(result.open).toBe(0);
    });

    it("defaults to zeros when result is null", async () => {
      const promise = client.stats();
      resolveEmpty();
      const result = await promise;

      expect(result.total).toBe(0);
    });
  });

  // ── create ───────────────────────────────────────────────────

  describe("create", () => {
    it("calls bd create <title> --json with flags", async () => {
      const promise = client.create({
        title: "New bug",
        issue_type: "bug",
        priority: 1,
        assignee: "alice",
      });
      resolveWith({ id: "b-new", title: "New bug", status: "open", priority: 1 });
      const result = await promise;

      expect(lastSpawnArgs!.args[0]).toBe("create");
      expect(lastSpawnArgs!.args[1]).toBe("New bug");
      expect(lastSpawnArgs!.args).toContain("--json");
      expect(lastSpawnArgs!.args).toContain("--type=bug");
      expect(lastSpawnArgs!.args).toContain("--priority=1");
      expect(lastSpawnArgs!.args).toContain("--assignee=alice");
      expect(result.id).toBe("b-new");
    });

    it("includes description and labels when provided", async () => {
      const promise = client.create({
        title: "Task",
        description: "A task description",
        labels: ["ui", "backend"],
      });
      resolveWith({ id: "b-t", title: "Task", status: "open", priority: 2 });
      await promise;

      expect(lastSpawnArgs!.args).toContain("--description=A task description");
      expect(lastSpawnArgs!.args).toContain("--labels=ui,backend");
    });
  });

  // ── update ───────────────────────────────────────────────────

  describe("update", () => {
    it("calls bd update <id> with flags then re-fetches via show", async () => {
      // update() calls execBd for update, then show() for re-fetch
      const promise = client.update({ id: "b-1", title: "Updated", status: "in_progress", priority: 0 });

      // First call: bd update (no JSON output)
      resolveEmpty();

      // Need to wait a tick for the show() call
      await new Promise((r) => setTimeout(r, 10));

      // Second call: bd show (re-fetch)
      resolveWith([{ id: "b-1", title: "Updated", status: "in_progress", priority: 0 }]);

      const result = await promise;
      expect(result.title).toBe("Updated");
    });

    it("includes label flags", async () => {
      const promise = client.update({
        id: "b-1",
        set_labels: ["ui", "dx"],
        add_labels: ["new-label"],
        remove_labels: ["old-label"],
      });
      // Yield to let the serialized command queue spawn the process
      await Promise.resolve();
      resolveEmpty();

      // Check the update command args (first spawn call)
      // The args are captured from the update call
      expect(lastSpawnArgs!.args).toContain("--set-labels=ui,dx");
      expect(lastSpawnArgs!.args).toContain("--add-label=new-label");
      expect(lastSpawnArgs!.args).toContain("--remove-label=old-label");

      // Let show() resolve
      await new Promise((r) => setTimeout(r, 10));
      resolveWith([{ id: "b-1", title: "T", status: "open", priority: 2 }]);
      await promise;
    });

    it("includes --set-metadata flags when provided", async () => {
      const promise = client.update({
        id: "b-1",
        set_metadata: { bugzilla_id: "123" },
      });
      await Promise.resolve();
      resolveEmpty();

      expect(lastSpawnArgs!.args).toContain("--set-metadata");
      expect(lastSpawnArgs!.args).toContain("bugzilla_id=123");

      await new Promise((r) => setTimeout(r, 10));
      resolveWith([{ id: "b-1", title: "T", status: "open", priority: 2 }]);
      await promise;
    });

    it("includes --unset-metadata flags when provided", async () => {
      const promise = client.update({
        id: "b-1",
        unset_metadata: ["bugzilla_id"],
      });
      await Promise.resolve();
      resolveEmpty();

      expect(lastSpawnArgs!.args).toContain("--unset-metadata");
      expect(lastSpawnArgs!.args).toContain("bugzilla_id");

      await new Promise((r) => setTimeout(r, 10));
      resolveWith([{ id: "b-1", title: "T", status: "open", priority: 2 }]);
      await promise;
    });
  });

  // ── close ────────────────────────────────────────────────────

  describe("close", () => {
    it("calls bd update <id> --status=closed then re-fetches", async () => {
      const promise = client.close({ id: "b-1" });

      // First call: bd update --status=closed
      resolveEmpty();
      await new Promise((r) => setTimeout(r, 10));

      // Second call: bd show (re-fetch)
      resolveWith([{ id: "b-1", title: "Closed", status: "closed", priority: 2 }]);
      const result = await promise;

      expect(result.status).toBe("closed");
    });
  });

  // ── addDependency ────────────────────────────────────────────

  describe("addDependency", () => {
    it("calls bd dep add <from> <to> with type", async () => {
      const promise = client.addDependency({ from_id: "b-1", to_id: "b-2", dep_type: "blocks" });
      resolveEmpty();
      await promise;

      expect(lastSpawnArgs!.args).toEqual(["dep", "add", "b-1", "b-2", "--type=blocks"]);
    });
  });

  // ── removeDependency ─────────────────────────────────────────

  describe("removeDependency", () => {
    it("calls bd dep remove <from> <to>", async () => {
      const promise = client.removeDependency({ from_id: "b-1", to_id: "b-2" });
      resolveEmpty();
      await promise;

      expect(lastSpawnArgs!.args).toEqual(["dep", "remove", "b-1", "b-2"]);
    });
  });

  // ── addLabel ─────────────────────────────────────────────────

  describe("addLabel", () => {
    it("calls bd label add <id> <label>", async () => {
      const promise = client.addLabel({ id: "b-1", label: "urgent" });
      resolveEmpty();
      await promise;

      expect(lastSpawnArgs!.args).toEqual(["label", "add", "b-1", "urgent"]);
    });
  });

  // ── removeLabel ──────────────────────────────────────────────

  describe("removeLabel", () => {
    it("calls bd label remove <id> <label>", async () => {
      const promise = client.removeLabel({ id: "b-1", label: "stale" });
      resolveEmpty();
      await promise;

      expect(lastSpawnArgs!.args).toEqual(["label", "remove", "b-1", "stale"]);
    });
  });

  // ── addComment ───────────────────────────────────────────────

  describe("addComment", () => {
    it("calls bd comments add <id> <text> --author=<author>", async () => {
      const promise = client.addComment({ id: "b-1", author: "alice", text: "Great work" });
      resolveEmpty();
      await promise;

      expect(lastSpawnArgs!.args).toEqual(["comments", "add", "b-1", "Great work", "--author=alice"]);
    });
  });

  // ── health ───────────────────────────────────────────────────

  describe("health", () => {
    it("calls bd info --json and returns synthetic health response", async () => {
      const promise = client.health();
      resolveWith({ version: "0.55.4" });
      const result = await promise;

      expect(lastSpawnArgs!.args).toEqual(["info", "--json"]);
      expect(result.status).toBe("healthy");
      expect(result.version).toBe("0.55.4");
      expect(result.compatible).toBe(true);
    });

    it("sets isConnected to true", async () => {
      expect(client.isConnected()).toBe(false);
      const promise = client.health();
      resolveWith({ version: "0.55.4" });
      await promise;
      expect(client.isConnected()).toBe(true);
    });
  });

  // ── ping ─────────────────────────────────────────────────────

  describe("ping", () => {
    it("returns pong with version", async () => {
      const promise = client.ping();
      resolveWith({ version: "0.55.4" });
      const result = await promise;

      expect(result.message).toBe("pong");
      expect(result.version).toBe("0.55.4");
    });
  });

  // ── status ───────────────────────────────────────────────────

  describe("status", () => {
    it("returns synthetic status response", async () => {
      const promise = client.status();
      resolveWith({ version: "0.55.4", database: "/path/to/db" });
      const result = await promise;

      expect(result.version).toBe("0.55.4");
      expect(result.workspace_path).toBe("/test/project");
    });
  });

  // ── Error handling ───────────────────────────────────────────

  describe("error handling", () => {
    it("throws on non-zero exit code", async () => {
      const promise = client.list();
      rejectWith("some error");
      await expect(promise).rejects.toThrow("some error");
    });

    it("throws descriptive error when bd is not on PATH", async () => {
      const promise = client.list();
      rejectNotFound();
      await expect(promise).rejects.toThrow("bd not found on PATH");
    });

    it("resolves with raw string when output is not JSON", async () => {
      // Simulates bd commands that return plain text (e.g. bd update)
      const promise = client.list();
      process.nextTick(() => {
        mockProcess.stdout.emit("data", Buffer.from("not valid json"));
        mockProcess.emit("close", 0);
      });
      // Non-JSON output resolves instead of rejecting
      await expect(promise).resolves.toBeDefined();
    });
  });

  // ── listComments ─────────────────────────────────────────────

  describe("listComments", () => {
    it("returns comments from show response", async () => {
      const promise = client.listComments("b-1");
      resolveWith([{
        id: "b-1",
        title: "Test",
        status: "open",
        priority: 2,
        comments: [
          { id: 1, author: "alice", text: "A comment", created_at: "2026-01-01T00:00:00Z" },
        ],
      }]);
      const result = await promise;

      expect(result).toHaveLength(1);
      expect(result[0].author).toBe("alice");
    });

    it("returns empty array when no comments", async () => {
      const promise = client.listComments("b-1");
      resolveWith([{ id: "b-1", title: "Test", status: "open", priority: 2 }]);
      const result = await promise;
      expect(result).toEqual([]);
    });
  });

  // ── socketExists ─────────────────────────────────────────────

  describe("socketExists", () => {
    it("returns true when .beads dir exists", () => {
      expect(client.socketExists()).toBe(true);
    });
  });

  // ── findBeadsDir ─────────────────────────────────────────────

  describe("findBeadsDir", () => {
    it("is a static method", () => {
      expect(typeof BeadsCLIClient.findBeadsDir).toBe("function");
    });
  });

  // ── delete ───────────────────────────────────────────────────

  describe("delete", () => {
    it("calls bd delete <id> --force", async () => {
      const promise = client.delete("b-1");
      resolveEmpty();
      await promise;

      expect(lastSpawnArgs!.args).toEqual(["delete", "b-1", "--force"]);
    });

    it("throws on error", async () => {
      const promise = client.delete("b-1");
      rejectWith("issue not found");
      await expect(promise).rejects.toThrow("issue not found");
    });
  });

  // ── dispose ──────────────────────────────────────────────────

  describe("dispose", () => {
    it("stops mutation watch without error", () => {
      expect(() => client.dispose()).not.toThrow();
    });
  });
});
