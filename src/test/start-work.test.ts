
// ── Mock vscode ──────────────────────────────────────────────────

const mockShowInformationMessage = jest.fn();
const mockGetConfiguration = jest.fn();

jest.mock("vscode", () => ({
  window: {
    showInformationMessage: mockShowInformationMessage,
  },
  workspace: {
    getConfiguration: mockGetConfiguration,
  },
}), { virtual: true });

// ── Mock child_process.execFile ──────────────────────────────────

const mockExecFile = jest.fn();

jest.mock("child_process", () => ({
  execFile: mockExecFile,
}));

// ── Import after mocks ──────────────────────────────────────────

import { handleStartWork } from "../utils/startWork";

// ── Helpers ─────────────────────────────────────────────────────

function makeClient(issue: Record<string, unknown> | null = null) {
  return {
    show: jest.fn().mockResolvedValue(issue),
    update: jest.fn().mockResolvedValue(issue),
  };
}

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
}

function setupExecFile(responses: Record<string, { stdout?: string; err?: Error }>) {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const key = args.join(" ");
      for (const [pattern, response] of Object.entries(responses)) {
        if (key.includes(pattern)) {
          cb(response.err || null, response.stdout || "", "");
          return;
        }
      }
      // Default: no output, no error
      cb(null, "", "");
    }
  );
}

// ── Tests ───────────────────────────────────────────────────────

describe("handleStartWork", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfiguration.mockReturnValue({
      get: jest.fn().mockReturnValue("testuser"),
    });
  });

  it("does nothing when bead has no bugzillaId", async () => {
    const client = makeClient({
      id: "b-1",
      status: "in_progress",
      metadata: {},
    });
    const logger = makeLogger();

    await handleStartWork("b-1", client as never, logger as never);

    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("does nothing when bead is not found", async () => {
    const client = makeClient(null);
    const logger = makeLogger();

    await handleStartWork("b-missing", client as never, logger as never);

    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("offers to create branch when it does not exist", async () => {
    const client = makeClient({
      id: "b-1",
      status: "in_progress",
      metadata: { bugzilla_id: "42" },
    });
    const logger = makeLogger();

    // No branches exist
    setupExecFile({});

    mockShowInformationMessage.mockResolvedValue("Create Branch");

    await handleStartWork("b-1", client as never, logger as never);

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "Create branch `feature/BUG-42`?",
      "Create Branch",
      "Skip"
    );

    // Should run git checkout -b
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "feature/BUG-42"],
      expect.any(Function)
    );

    // Should auto-assign
    expect(client.update).toHaveBeenCalledWith({
      id: "b-1",
      assignee: "testuser",
    });
  });

  it("offers to switch when branch exists locally", async () => {
    const client = makeClient({
      id: "b-1",
      status: "in_progress",
      metadata: { bugzilla_id: "99" },
    });
    const logger = makeLogger();

    // Local branch exists
    setupExecFile({
      "--list feature/BUG-99": { stdout: "  feature/BUG-99\n" },
    });

    mockShowInformationMessage.mockResolvedValue("Switch Branch");

    await handleStartWork("b-1", client as never, logger as never);

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "Switch to branch `feature/BUG-99`?",
      "Switch Branch",
      "Skip"
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "feature/BUG-99"],
      expect.any(Function)
    );
  });

  it("offers to check out when branch exists only remotely", async () => {
    const client = makeClient({
      id: "b-1",
      status: "in_progress",
      metadata: { bugzilla_id: "7" },
    });
    const logger = makeLogger();

    // Local doesn't exist, remote does
    setupExecFile({
      "-r --list": { stdout: "  origin/feature/BUG-7\n" },
    });

    mockShowInformationMessage.mockResolvedValue("Check Out");

    await handleStartWork("b-1", client as never, logger as never);

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "Check out remote branch `feature/BUG-7`?",
      "Check Out",
      "Skip"
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "feature/BUG-7", "origin/feature/BUG-7"],
      expect.any(Function)
    );
  });

  it("does nothing when user clicks Skip", async () => {
    const client = makeClient({
      id: "b-1",
      status: "in_progress",
      metadata: { bugzilla_id: "42" },
    });
    const logger = makeLogger();

    setupExecFile({});
    mockShowInformationMessage.mockResolvedValue("Skip");

    await handleStartWork("b-1", client as never, logger as never);

    // Only the branch-check calls, no checkout call
    const checkoutCalls = mockExecFile.mock.calls.filter(
      (call: unknown[]) => (call[1] as string[])[0] === "checkout"
    );
    expect(checkoutCalls).toHaveLength(0);
    expect(client.update).not.toHaveBeenCalled();
  });
});
