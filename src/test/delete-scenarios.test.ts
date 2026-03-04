/**
 * Delete scenario tests for BeadsPanelViewProvider and BeadDetailsViewProvider.
 *
 * Scenarios:
 * 1. External deletion: bead deleted via CLI while extension is viewing it
 * 2. Extension deletion: bead deleted from the extension UI
 */

import { EventEmitter } from "events";

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

import { BeadsCLIClient, Issue } from "../backend/BeadsCLIClient";

// ── Helpers ──────────────────────────────────────────────────────

function createClient(): BeadsCLIClient {
  return new BeadsCLIClient("/test/project/.beads", { cwd: "/test/project" });
}

function resolveWith(data: unknown): void {
  const json = JSON.stringify(data);
  process.nextTick(() => {
    mockProcess.stdout.emit("data", Buffer.from(json));
    mockProcess.emit("close", 0);
  });
}

function resolveEmpty(): void {
  process.nextTick(() => {
    mockProcess.emit("close", 0);
  });
}

function rejectWith(stderr: string, code = 1): void {
  process.nextTick(() => {
    mockProcess.stderr.emit("data", Buffer.from(stderr));
    mockProcess.emit("close", code);
  });
}

const SAMPLE_ISSUE: Issue = {
  id: "bd-test-1",
  title: "Test bead",
  status: "open",
  priority: 2,
  issue_type: "task",
  created_at: "2026-03-04T00:00:00Z",
  updated_at: "2026-03-04T00:00:00Z",
};

// ── Tests ────────────────────────────────────────────────────────

describe("Delete scenarios", () => {
  let client: BeadsCLIClient;

  beforeEach(() => {
    lastSpawnArgs = null;
    client = createClient();
  });

  describe("Scenario 1: External deletion (bead deleted from CLI)", () => {
    it("show() returns null after bead is deleted externally", async () => {
      // First: bead exists
      const showPromise1 = client.show("bd-test-1");
      resolveWith([SAMPLE_ISSUE]);
      const result1 = await showPromise1;
      expect(result1).not.toBeNull();
      expect(result1!.id).toBe("bd-test-1");

      // Then: bead is deleted externally (CLI returns "not found")
      const showPromise2 = client.show("bd-test-1");
      rejectWith("issue not found");
      const result2 = await showPromise2;
      expect(result2).toBeNull();
    });

    it("list() excludes deleted bead", async () => {
      // Before deletion: bead appears in list
      const listPromise1 = client.list();
      resolveWith([SAMPLE_ISSUE, { ...SAMPLE_ISSUE, id: "bd-test-2", title: "Other bead" }]);
      const result1 = await listPromise1;
      expect(result1).toHaveLength(2);

      // After deletion: only one bead remains
      const listPromise2 = client.list();
      resolveWith([{ ...SAMPLE_ISSUE, id: "bd-test-2", title: "Other bead" }]);
      const result2 = await listPromise2;
      expect(result2).toHaveLength(1);
      expect(result2[0].id).toBe("bd-test-2");
    });

    it("mutation watcher fires after filesystem change", (done) => {
      jest.useFakeTimers();

      // Start watching
      client.startMutationWatch();

      // Listen for mutation event
      client.on("mutation", (event) => {
        expect(event.Type).toBe("update");
        expect(event.IssueID).toBe("*");
        jest.useRealTimers();
        done();
      });

      // Simulate filesystem change (mock fs.watch callback)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fsModule = require("fs");
      const watchCallback = fsModule.watch.mock.calls[0]?.[2];
      expect(watchCallback).toBeDefined();
      watchCallback("change", "some-file");
      // Advance past debounce (500ms)
      jest.advanceTimersByTime(600);
    });
  });

  describe("Scenario 2: Extension deletion (delete via client)", () => {
    it("delete then show returns null", async () => {
      // Delete the bead
      const deletePromise = client.delete("bd-test-1");
      resolveEmpty();
      await deletePromise;

      expect(lastSpawnArgs!.args).toEqual(["delete", "bd-test-1", "--force"]);

      // Show returns null (not found)
      const showPromise = client.show("bd-test-1");
      rejectWith("issue not found");
      const result = await showPromise;
      expect(result).toBeNull();
    });

    it("delete then list excludes bead", async () => {
      // Delete the bead
      const deletePromise = client.delete("bd-test-1");
      resolveEmpty();
      await deletePromise;

      // List no longer includes it
      const listPromise = client.list();
      resolveWith([]);
      const result = await listPromise;
      expect(result).toEqual([]);
    });

    it("delete non-existent bead throws error", async () => {
      const deletePromise = client.delete("bd-nonexistent");
      rejectWith("issue not found");
      await expect(deletePromise).rejects.toThrow("issue not found");
    });
  });

  describe("Details view: bead-not-found handling", () => {
    it("show() returns null for deleted bead (graceful handling)", async () => {
      // This simulates what BeadDetailsViewProvider.loadData() does:
      // It calls client.show(currentBeadId). If the bead was deleted,
      // show() returns null, and the view displays "Bead not found".
      const showPromise = client.show("bd-deleted");
      rejectWith("issue not found");
      const result = await showPromise;
      expect(result).toBeNull();
    });

    it("listComments() returns empty for deleted bead", async () => {
      // listComments calls show() internally - should handle not-found
      const commentsPromise = client.listComments("bd-deleted");
      rejectWith("issue not found");
      const result = await commentsPromise;
      expect(result).toEqual([]);
    });
  });

  describe("Command serialization during delete", () => {
    it("serializes delete with subsequent list", async () => {
      // Fire delete and list in quick succession
      const deletePromise = client.delete("bd-test-1");
      const listPromise = client.list();

      // Resolve delete first
      resolveEmpty();
      await deletePromise;

      // Then resolve list
      resolveWith([]);
      const listResult = await listPromise;
      expect(listResult).toEqual([]);
    });
  });
});
