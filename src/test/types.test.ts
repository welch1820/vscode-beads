import {
  normalizeStatus,
  normalizePriority,
  normalizeBead,
  issueToWebviewBead,
} from "../backend/types";

// ── normalizeStatus ──────────────────────────────────────────────

describe("normalizeStatus", () => {
  it("maps 'open' to 'open'", () => {
    expect(normalizeStatus("open")).toBe("open");
  });

  it("maps 'in_progress' to 'in_progress'", () => {
    expect(normalizeStatus("in_progress")).toBe("in_progress");
  });

  it("maps 'in-progress' to 'in_progress'", () => {
    expect(normalizeStatus("in-progress")).toBe("in_progress");
  });

  it("maps 'active' to 'in_progress'", () => {
    expect(normalizeStatus("active")).toBe("in_progress");
  });

  it("maps 'blocked' to 'blocked'", () => {
    expect(normalizeStatus("blocked")).toBe("blocked");
  });

  it("maps 'closed' to 'closed'", () => {
    expect(normalizeStatus("closed")).toBe("closed");
  });

  it("maps 'done' to 'closed'", () => {
    expect(normalizeStatus("done")).toBe("closed");
  });

  it("maps 'completed' to 'closed'", () => {
    expect(normalizeStatus("completed")).toBe("closed");
  });

  it("maps 'cancelled' to 'closed'", () => {
    expect(normalizeStatus("cancelled")).toBe("closed");
  });

  it("maps 'canceled' to 'closed'", () => {
    expect(normalizeStatus("canceled")).toBe("closed");
  });

  it("returns null for undefined", () => {
    expect(normalizeStatus(undefined)).toBeNull();
  });

  it("returns null for unknown status", () => {
    expect(normalizeStatus("foobar")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(normalizeStatus("OPEN")).toBe("open");
    expect(normalizeStatus("In-Progress")).toBe("in_progress");
    expect(normalizeStatus("BLOCKED")).toBe("blocked");
    expect(normalizeStatus("Closed")).toBe("closed");
  });
});

// ── normalizePriority ────────────────────────────────────────────

describe("normalizePriority", () => {
  it("returns the number as-is for 0-4", () => {
    expect(normalizePriority(0)).toBe(0);
    expect(normalizePriority(1)).toBe(1);
    expect(normalizePriority(2)).toBe(2);
    expect(normalizePriority(3)).toBe(3);
    expect(normalizePriority(4)).toBe(4);
  });

  it("defaults to 4 for undefined", () => {
    expect(normalizePriority(undefined)).toBe(4);
  });

  it("parses string numbers", () => {
    expect(normalizePriority("0")).toBe(0);
    expect(normalizePriority("2")).toBe(2);
  });

  it("clamps values > 4 to 4", () => {
    expect(normalizePriority(5)).toBe(4);
    expect(normalizePriority(100)).toBe(4);
  });

  it("returns 4 for negative values", () => {
    expect(normalizePriority(-1)).toBe(4);
  });

  it("returns 4 for NaN strings", () => {
    expect(normalizePriority("abc")).toBe(4);
  });
});

// ── normalizeBead ────────────────────────────────────────────────

describe("normalizeBead", () => {
  const baseBead = {
    id: "beads-abc",
    title: "Test bead",
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  };

  it("normalizes a basic bead", () => {
    const result = normalizeBead(baseBead);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("beads-abc");
    expect(result!.title).toBe("Test bead");
    expect(result!.status).toBe("open");
    expect(result!.priority).toBe(2);
  });

  it("returns null for invalid status", () => {
    expect(normalizeBead({ ...baseBead, status: "foobar" })).toBeNull();
  });

  it("returns null for missing status", () => {
    expect(normalizeBead({ ...baseBead, status: undefined })).toBeNull();
  });

  it("maps owner to assignee when assignee is missing", () => {
    const result = normalizeBead({ ...baseBead, owner: "alice" });
    expect(result!.assignee).toBe("alice");
  });

  it("prefers assignee over owner", () => {
    const result = normalizeBead({ ...baseBead, assignee: "bob", owner: "alice" });
    expect(result!.assignee).toBe("bob");
  });

  it("falls back to assigned_to", () => {
    const result = normalizeBead({ ...baseBead, assigned_to: "charlie" });
    expect(result!.assignee).toBe("charlie");
  });

  it("prefers owner over assigned_to", () => {
    const result = normalizeBead({ ...baseBead, owner: "alice", assigned_to: "charlie" });
    expect(result!.assignee).toBe("alice");
  });

  it("maps description field", () => {
    const result = normalizeBead({ ...baseBead, description: "A description" });
    expect(result!.description).toBe("A description");
  });

  it("falls back to body for description", () => {
    const result = normalizeBead({ ...baseBead, body: "Body text" });
    expect(result!.description).toBe("Body text");
  });

  it("maps labels array", () => {
    const result = normalizeBead({ ...baseBead, labels: ["ui", "backend"] });
    expect(result!.labels).toEqual(["ui", "backend"]);
  });

  it("falls back to tags for labels", () => {
    const result = normalizeBead({ ...baseBead, tags: ["frontend"] });
    expect(result!.labels).toEqual(["frontend"]);
  });

  it("maps timestamps with snake_case keys", () => {
    const result = normalizeBead(baseBead);
    expect(result!.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(result!.updatedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("maps timestamps with camelCase keys", () => {
    const result = normalizeBead({
      ...baseBead,
      created_at: undefined,
      updated_at: undefined,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-02T00:00:00Z",
    });
    expect(result!.createdAt).toBe("2026-03-01T00:00:00Z");
    expect(result!.updatedAt).toBe("2026-03-02T00:00:00Z");
  });
});

// ── issueToWebviewBead ───────────────────────────────────────────

describe("issueToWebviewBead", () => {
  const baseIssue = {
    id: "beads-xyz",
    title: "Test issue",
    status: "open",
    priority: 1,
    issue_type: "bug",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  };

  it("converts a basic issue to a bead", () => {
    const result = issueToWebviewBead(baseIssue);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("beads-xyz");
    expect(result!.title).toBe("Test issue");
    expect(result!.status).toBe("open");
    expect(result!.priority).toBe(1);
    expect(result!.type).toBe("bug");
  });

  it("returns null for invalid status", () => {
    expect(issueToWebviewBead({ ...baseIssue, status: "unknown_status" })).toBeNull();
  });

  it("maps owner to assignee when assignee is missing", () => {
    const result = issueToWebviewBead({ ...baseIssue, owner: "alice" });
    expect(result!.assignee).toBe("alice");
  });

  it("prefers assignee over owner", () => {
    const result = issueToWebviewBead({ ...baseIssue, assignee: "bob", owner: "alice" });
    expect(result!.assignee).toBe("bob");
  });

  it("returns undefined assignee when both are missing", () => {
    const result = issueToWebviewBead(baseIssue);
    expect(result!.assignee).toBeUndefined();
  });

  it("maps design notes and acceptance criteria", () => {
    const result = issueToWebviewBead({
      ...baseIssue,
      design: "Design notes",
      acceptance_criteria: "Must pass tests",
      notes: "Working notes",
    });
    expect(result!.design).toBe("Design notes");
    expect(result!.acceptanceCriteria).toBe("Must pass tests");
    expect(result!.notes).toBe("Working notes");
  });

  it("maps labels", () => {
    const result = issueToWebviewBead({ ...baseIssue, labels: ["ui", "critical"] });
    expect(result!.labels).toEqual(["ui", "critical"]);
  });

  it("maps estimated_minutes and external_ref", () => {
    const result = issueToWebviewBead({
      ...baseIssue,
      estimated_minutes: 60,
      external_ref: "gh-42",
    });
    expect(result!.estimatedMinutes).toBe(60);
    expect(result!.externalRef).toBe("gh-42");
  });

  it("maps closed_at", () => {
    const result = issueToWebviewBead({
      ...baseIssue,
      status: "closed",
      closed_at: "2026-01-05T00:00:00Z",
    });
    expect(result!.closedAt).toBe("2026-01-05T00:00:00Z");
  });

  it("maps dependencies to dependsOn", () => {
    const result = issueToWebviewBead({
      ...baseIssue,
      dependencies: [
        { id: "dep-1", dependency_type: "blocks", issue_type: "task", title: "Dep 1", status: "open", priority: 2 },
      ],
    });
    expect(result!.dependsOn).toHaveLength(1);
    expect(result!.dependsOn![0].id).toBe("dep-1");
    expect(result!.dependsOn![0].dependencyType).toBe("blocks");
    expect(result!.dependsOn![0].type).toBe("task");
  });

  it("maps dependents to blocks", () => {
    const result = issueToWebviewBead({
      ...baseIssue,
      dependents: [
        { id: "blk-1", dependency_type: "blocks", issue_type: "feature", title: "Blocker", status: "in_progress", priority: 1 },
      ],
    });
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks![0].id).toBe("blk-1");
    expect(result!.blocks![0].status).toBe("in_progress");
  });

  it("maps bugzilla_id from metadata to bugzillaId", () => {
    const result = issueToWebviewBead({
      ...baseIssue,
      metadata: { bugzilla_id: 123 },
    });
    expect(result!.bugzillaId).toBe(123);
  });

  it("parses bugzilla_id string from metadata as number", () => {
    const result = issueToWebviewBead({
      ...baseIssue,
      metadata: { bugzilla_id: "456" },
    });
    expect(result!.bugzillaId).toBe(456);
  });

  it("leaves bugzillaId undefined when metadata has no bugzilla_id", () => {
    const result = issueToWebviewBead({
      ...baseIssue,
      metadata: { other_key: "value" },
    });
    expect(result!.bugzillaId).toBeUndefined();
  });

  it("maps comments", () => {
    const result = issueToWebviewBead({
      ...baseIssue,
      comments: [
        { id: 1, author: "alice", text: "A comment", created_at: "2026-01-03T00:00:00Z" },
      ],
    });
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments![0].author).toBe("alice");
    expect(result!.comments![0].createdAt).toBe("2026-01-03T00:00:00Z");
  });
});
