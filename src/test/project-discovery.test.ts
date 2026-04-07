// Tests for BeadsProjectManager.discoverProjects() subfolder scanning

// ── Mock vscode ──────────────────────────────────────────────────

const mockGetConfiguration = jest.fn();
const mockWorkspaceFolders: Array<{ uri: { fsPath: string }; name: string }> = [];
const mockFireProjectsChanged = jest.fn();
const mockFireActiveProjectChanged = jest.fn();
const mockFireDataChanged = jest.fn();
const mockFireMutation = jest.fn();

jest.mock(
  "vscode",
  () => ({
    workspace: {
      get workspaceFolders() {
        return mockWorkspaceFolders;
      },
      getConfiguration: mockGetConfiguration,
    },
    window: {},
    EventEmitter: class {
      fire = jest.fn();
      event = jest.fn();
      dispose = jest.fn();
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
  }),
  { virtual: true }
);

// ── Mock fs ──────────────────────────────────────────────────────

// Simulated filesystem: set of paths that exist as directories
let fsDirs: Set<string>;
// Simulated directory contents: path -> child Dirent entries
let fsDirContents: Map<string, Array<{ name: string; isDirectory: () => boolean }>>;
// Simulated file contents: path -> string content
let fsFileContents: Map<string, string>;

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(true),
    statSync: jest.fn().mockReturnValue({ isDirectory: () => true }),
    promises: {
      stat: jest.fn().mockImplementation(async (p: string) => {
        if (fsDirs.has(p)) {
          return { isDirectory: () => true };
        }
        throw new Error(`ENOENT: ${p}`);
      }),
      readdir: jest.fn().mockImplementation(async (dir: string) => {
        const entries = fsDirContents.get(dir);
        if (entries) return entries;
        throw new Error(`ENOENT: ${dir}`);
      }),
      readFile: jest.fn().mockImplementation(async (p: string) => {
        const content = fsFileContents.get(p);
        if (content !== undefined) return content;
        throw new Error(`ENOENT: ${p}`);
      }),
    },
  };
});

// ── Import after mocks ──────────────────────────────────────────

import { BeadsProjectManager } from "../backend/BeadsProjectManager";

// ── Helpers ─────────────────────────────────────────────────────

function makeLogger() {
  const child = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
  child.child.mockReturnValue(child);
  return child;
}

function makeContext() {
  return {
    workspaceState: {
      get: jest.fn(),
      update: jest.fn(),
    },
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
}

function dirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir };
}

/**
 * Build a simulated filesystem from a tree description.
 * Each key is a path; if it ends with '/' it's a directory,
 * otherwise it's a file. '.beads' dirs and 'dolt' subdirs
 * are handled automatically.
 */
function setupFs(tree: {
  dirs: string[];
  dirContents: Record<string, Array<{ name: string; isDirectory: () => boolean }>>;
  files?: Record<string, string>;
}) {
  fsDirs = new Set(tree.dirs);
  fsDirContents = new Map(Object.entries(tree.dirContents));
  fsFileContents = new Map(Object.entries(tree.files || {}));
}

function setWorkspaceFolders(...folders: Array<{ path: string; name: string }>) {
  mockWorkspaceFolders.length = 0;
  for (const f of folders) {
    mockWorkspaceFolders.push({ uri: { fsPath: f.path }, name: f.name });
  }
}

function setScanDepth(depth: number) {
  mockGetConfiguration.mockReturnValue({
    get: jest.fn().mockReturnValue(depth),
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe("BeadsProjectManager.discoverProjects", () => {
  let manager: BeadsProjectManager;

  beforeEach(() => {
    jest.clearAllMocks();
    setScanDepth(3);
    manager = new BeadsProjectManager(makeContext(), makeLogger() as any);
  });

  it("finds a .beads project at workspace root", async () => {
    setWorkspaceFolders({ path: "/ws/myproject", name: "myproject" });
    setupFs({
      dirs: ["/ws/myproject/.beads", "/ws/myproject/.beads/dolt"],
      dirContents: {},
    });

    await manager.discoverProjects();
    const projects = manager.getProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("myproject");
    expect(projects[0].rootPath).toBe("/ws/myproject");
    expect(projects[0].status).toBe("connected");
  });

  it("finds .beads projects in subfolders", async () => {
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    setupFs({
      dirs: [
        "/ws/projectA/.beads",
        "/ws/projectA/.beads/dolt",
        "/ws/projectB/.beads",
        "/ws/projectB/.beads/dolt",
      ],
      dirContents: {
        "/ws": [dirent("projectA", true), dirent("projectB", true), dirent("README.md", false)],
        "/ws/projectA": [], // scanning stops here because .beads found
        "/ws/projectB": [],
      },
    });

    await manager.discoverProjects();
    const projects = manager.getProjects();

    expect(projects).toHaveLength(2);
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(["projectA", "projectB"]);
  });

  it("finds nested .beads projects at depth 2", async () => {
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    setupFs({
      dirs: ["/ws/org/repo/.beads", "/ws/org/repo/.beads/dolt"],
      dirContents: {
        "/ws": [dirent("org", true)],
        "/ws/org": [dirent("repo", true)],
        "/ws/org/repo": [],
      },
    });

    await manager.discoverProjects();
    const projects = manager.getProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("repo");
    expect(projects[0].rootPath).toBe("/ws/org/repo");
  });

  it("respects scanDepth=0 (root only, old behavior)", async () => {
    setScanDepth(0);
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    setupFs({
      dirs: ["/ws/sub/.beads", "/ws/sub/.beads/dolt"],
      dirContents: {
        "/ws": [dirent("sub", true)],
      },
    });

    await manager.discoverProjects();
    expect(manager.getProjects()).toHaveLength(0);
  });

  it("finds .beads at every depth including nested projects", async () => {
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    setupFs({
      dirs: [
        "/ws/parent/.beads",
        "/ws/parent/.beads/dolt",
        "/ws/parent/child/.beads",
        "/ws/parent/child/.beads/dolt",
      ],
      dirContents: {
        "/ws": [dirent("parent", true)],
        "/ws/parent": [dirent("child", true)],
        "/ws/parent/child": [],
      },
    });

    await manager.discoverProjects();
    const projects = manager.getProjects();

    expect(projects).toHaveLength(2);
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(["child", "parent"]);
  });

  it("skips node_modules and .git directories", async () => {
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    setupFs({
      dirs: [
        "/ws/node_modules/pkg/.beads",
        "/ws/node_modules/pkg/.beads/dolt",
      ],
      dirContents: {
        "/ws": [
          dirent("node_modules", true),
          dirent(".git", true),
          dirent("src", true),
        ],
        // These should never be read:
        "/ws/node_modules": [dirent("pkg", true)],
        "/ws/node_modules/pkg": [],
        "/ws/src": [],
      },
    });

    await manager.discoverProjects();
    expect(manager.getProjects()).toHaveLength(0);
  });

  it("skips dot-directories (hidden folders)", async () => {
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    setupFs({
      dirs: ["/ws/.hidden/proj/.beads", "/ws/.hidden/proj/.beads/dolt"],
      dirContents: {
        "/ws": [dirent(".hidden", true), dirent("visible", true)],
        "/ws/.hidden": [dirent("proj", true)],
        "/ws/visible": [],
      },
    });

    await manager.discoverProjects();
    expect(manager.getProjects()).toHaveLength(0);
  });

  it("reports not_initialized when .beads/dolt is missing", async () => {
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    setupFs({
      dirs: ["/ws/proj/.beads"], // no dolt subdir
      dirContents: {
        "/ws": [dirent("proj", true)],
      },
    });

    await manager.discoverProjects();
    const projects = manager.getProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].status).toBe("not_initialized");
  });

  it("handles multiple workspace folders", async () => {
    setWorkspaceFolders(
      { path: "/ws/folderA", name: "folderA" },
      { path: "/ws/folderB", name: "folderB" }
    );
    setupFs({
      dirs: [
        "/ws/folderA/.beads",
        "/ws/folderA/.beads/dolt",
        "/ws/folderB/sub/.beads",
        "/ws/folderB/sub/.beads/dolt",
      ],
      dirContents: {
        "/ws/folderB": [dirent("sub", true)],
      },
    });

    await manager.discoverProjects();
    const projects = manager.getProjects();

    expect(projects).toHaveLength(2);
    expect(projects[0].rootPath).toBe("/ws/folderA");
    expect(projects[1].rootPath).toBe("/ws/folderB/sub");
  });

  it("returns empty when no workspace folders exist", async () => {
    setWorkspaceFolders(); // none
    await manager.discoverProjects();
    expect(manager.getProjects()).toHaveLength(0);
  });

  it("handles unreadable directories gracefully", async () => {
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    setupFs({
      dirs: [], // no .beads anywhere
      dirContents: {
        "/ws": [dirent("locked", true)],
        // /ws/locked will throw on readdir (not in map)
      },
    });

    await manager.discoverProjects();
    expect(manager.getProjects()).toHaveLength(0);
  });

  it("finds .beads at workspace root AND in subfolders", async () => {
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    setupFs({
      dirs: [
        "/ws/.beads",
        "/ws/.beads/dolt",
        "/ws/projectA/.beads",
        "/ws/projectA/.beads/dolt",
        "/ws/projectB/.beads",
        "/ws/projectB/.beads/dolt",
      ],
      dirContents: {
        "/ws": [dirent("projectA", true), dirent("projectB", true)],
        "/ws/projectA": [],
        "/ws/projectB": [],
      },
    });

    await manager.discoverProjects();
    const projects = manager.getProjects();

    expect(projects).toHaveLength(3);
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(["projectA", "projectB", "workspace"]);
  });

  it("annotates duplicate projects sharing the same project_id", async () => {
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    const sharedId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    setupFs({
      dirs: [
        "/ws/clone1/.beads",
        "/ws/clone1/.beads/dolt",
        "/ws/clone2/.beads",
        "/ws/clone2/.beads/dolt",
        "/ws/different/.beads",
        "/ws/different/.beads/dolt",
      ],
      dirContents: {
        "/ws": [dirent("clone1", true), dirent("clone2", true), dirent("different", true)],
        "/ws/clone1": [],
        "/ws/clone2": [],
        "/ws/different": [],
      },
      files: {
        "/ws/clone1/.beads/metadata.json": JSON.stringify({ project_id: sharedId }),
        "/ws/clone2/.beads/metadata.json": JSON.stringify({ project_id: sharedId }),
        "/ws/different/.beads/metadata.json": JSON.stringify({ project_id: "unique-id" }),
      },
    });

    await manager.discoverProjects();
    const projects = manager.getProjects();

    expect(projects).toHaveLength(3);

    const clone1 = projects.find((p) => p.name === "clone1")!;
    const clone2 = projects.find((p) => p.name === "clone2")!;
    const different = projects.find((p) => p.name === "different")!;

    // clone1 and clone2 share a project_id — each should list the other
    expect(clone1.projectId).toBe(sharedId);
    expect(clone2.projectId).toBe(sharedId);
    expect(clone1.duplicatePaths).toEqual(["/ws/clone2"]);
    expect(clone2.duplicatePaths).toEqual(["/ws/clone1"]);

    // different has a unique project_id — no duplicates
    expect(different.projectId).toBe("unique-id");
    expect(different.duplicatePaths).toBeUndefined();
  });

  it("does not set duplicatePaths when metadata.json is missing", async () => {
    setWorkspaceFolders({ path: "/ws", name: "workspace" });
    setupFs({
      dirs: [
        "/ws/proj/.beads",
        "/ws/proj/.beads/dolt",
      ],
      dirContents: {
        "/ws": [dirent("proj", true)],
        "/ws/proj": [],
      },
      // no files — metadata.json missing
    });

    await manager.discoverProjects();
    const projects = manager.getProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].projectId).toBeUndefined();
    expect(projects[0].duplicatePaths).toBeUndefined();
  });
});
