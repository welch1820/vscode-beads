/**
 * PWA Backend Server
 *
 * Lightweight Bun HTTP + WebSocket server that bridges the React webview
 * to the bd CLI. Serves static files and handles the same WebviewMessage
 * protocol as the VS Code extension host.
 *
 * Usage: bun run src/pwa/server.ts [--port 3000] [--dolt-host 127.0.0.1] [--dolt-port 3307]
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve, dirname, extname } from "path";
import { tmpdir } from "os";
import { issueToWebviewBead } from "../backend/types";
import type { Issue, IssueComment } from "../backend/BeadsCLIClient";

// ── Types (match webview protocol) ──────────────────────────────────

interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

interface ExtensionMessage {
  type: string;
  [key: string]: unknown;
}

// ── CLI wrapper (simplified from BeadsCLIClient) ────────────────────

// Set by selectDatabase() — tells bd which .beads dir to use
let activeBeadsDir = "";

function bd(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (activeBeadsDir) env.BEADS_DIR = activeBeadsDir;
    const proc = spawn("bd", args, { env, timeout: 30000 });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d; });
    proc.stderr.on("data", (d: Buffer) => { stderr += d; });
    proc.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `bd exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

async function bdJson<T>(args: string[]): Promise<T> {
  const out = await bd([...args, "--json"]);
  return JSON.parse(out);
}

// ── Dolt database discovery ─────────────────────────────────────────

interface DoltDatabase {
  name: string;
}

async function discoverDatabases(host: string, port: number): Promise<DoltDatabase[]> {
  try {
    const proc = spawn("dolt", [
      "--host", host,
      "--port", String(port),
      "--user", "root",
      "--no-tls",
      "sql", "-q", "SHOW DATABASES", "-r", "csv",
    ], { env: { ...process.env, DOLT_CLI_PASSWORD: "" } });

    let stdout = "";
    await new Promise<void>((resolve, reject) => {
      proc.stdout.on("data", (d: Buffer) => { stdout += d; });
      proc.on("close", (code: number | null) => code === 0 ? resolve() : reject());
      proc.on("error", reject);
    });

    return stdout
      .split("\n")
      .slice(1) // skip header
      .map(l => l.trim())
      .filter(l => l && l !== "information_schema" && l !== "mysql")
      .map(name => ({ name }));
  } catch {
    return [];
  }
}

/**
 * Create a minimal .beads config dir that tells bd to connect to a
 * specific database on the central Dolt server. One dir per database,
 * reused across restarts.
 */
function ensureBeadsDirForDatabase(dbName: string, host: string, port: number): string {
  const dir = join(tmpdir(), "beads-pwa", dbName, ".beads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `server-host: "${host}"\nserver-port: ${port}\n`);

  const metaPath = join(dir, "metadata.json");
  writeFileSync(metaPath, JSON.stringify({
    database: "dolt",
    backend: "dolt",
    dolt_mode: "server",
    dolt_server_host: host,
    dolt_database: dbName,
  }));

  // bd reads this file to know which port to connect to
  writeFileSync(join(dir, "dolt-server.port"), String(port));

  return dir;
}

// ── Message handler ─────────────────────────────────────────────────

// Serialization queue — bd CLI can't handle concurrent Dolt access
let commandQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const p = commandQueue.then(fn, fn);
  commandQueue = p.catch(() => {});
  return p;
}

async function handleMessage(
  msg: WebviewMessage,
  send: (m: ExtensionMessage) => void,
): Promise<void> {
  switch (msg.type) {
    case "ready":
      await initializeView(send);
      break;

    case "refresh":
      await loadData(send);
      break;

    case "selectProject":
      if (msg.projectId) {
        const dbName = String(msg.projectId);
        selectDatabase(dbName);
        send({ type: "setProject", project: {
          id: dbName, name: dbName, rootPath: "", beadsDir: "", status: "connected",
        }});
        await loadData(send);
      }
      break;

    case "selectBead":
    case "openBeadDetails":
      await loadBeadDetails(msg.beadId as string, send);
      break;

    case "updateBead":
      await serialize(async () => {
        const args = buildUpdateArgs(msg.beadId as string, msg.updates as Record<string, unknown>);
        await bd(["update", ...args]);
      });
      break;

    case "createBead":
      await serialize(async () => {
        const data = msg.data as Record<string, unknown>;
        const args: string[] = [];
        if (data.title) args.push("--title", String(data.title));
        if (data.description) args.push("--description", String(data.description));
        if (data.type) args.push("--type", String(data.type));
        if (data.priority !== undefined) args.push("--priority", String(data.priority));
        await bd(["create", ...args]);
      });
      break;

    case "deleteBead":
      await serialize(async () => {
        await bd(["delete", msg.beadId as string, "--yes"]);
      });
      break;

    case "addDependency":
      await serialize(async () => {
        const fromId = msg.reverse ? msg.targetId : msg.beadId;
        const toId = msg.reverse ? msg.beadId : msg.targetId;
        await bd(["dep", "add", String(fromId), String(toId), "--type", String(msg.dependencyType)]);
        await loadData(send);
      });
      break;

    case "removeDependency":
      await serialize(async () => {
        await bd(["dep", "remove", String(msg.beadId), String(msg.dependsOnId)]);
        await loadData(send);
      });
      break;

    case "addComment":
      await serialize(async () => {
        const author = process.env.USER || "pwa";
        await bd(["comments", "add", String(msg.beadId), "--author", author, "--text", String(msg.text)]);
        await loadBeadDetails(msg.beadId as string, send);
      });
      break;

    case "copyBeadId":
      // No-op in PWA — browser handles clipboard
      break;

    case "openFile":
      // No-op in PWA — no editor
      break;

    case "viewInGraph":
      send({ type: "highlightNode", beadId: msg.beadId });
      break;
  }
}

// ── Data loading (mirrors BaseViewProvider + BeadsPanelViewProvider) ─

async function initializeView(send: (m: ExtensionMessage) => void): Promise<void> {
  send({ type: "setViewType", viewType: "beadsPanel" });

  // Discover databases on the central Dolt server
  const databases = await discoverDatabases(doltHost, doltPort);

  // Build project list from discovered databases
  const projects = databases.map(db => ({
    id: db.name,
    name: db.name,
    rootPath: "",
    beadsDir: "",
    status: "connected" as string,
  }));
  send({ type: "setProjects", projects });

  // Auto-select first database if none active
  if (!activeDbName && databases.length > 0) {
    selectDatabase(databases[0].name);
  }
  if (activeDbName) {
    send({ type: "setProject", project: projects.find(p => p.id === activeDbName) || projects[0] });
  }

  send({ type: "setSettings", settings: { renderMarkdown: true, userId: process.env.USER || "pwa", tooltipHoverDelay: 1000 } });
  send({ type: "setTeamMembers", members: [] });
  await loadData(send);
}

async function loadData(send: (m: ExtensionMessage) => void): Promise<void> {
  send({ type: "setLoading", loading: true });
  send({ type: "setError", error: null });

  if (!activeBeadsDir) {
    send({ type: "setError", error: "No database selected. Pick one from the dropdown." });
    send({ type: "setBeads", beads: [] });
    send({ type: "setLoading", loading: false });
    return;
  }

  try {
    const [issues, blockedOutput] = await serialize(() =>
      Promise.all([
        bdJson<Issue[]>(["list", "--flat", "--status=all", "--limit=0"]),
        bd(["blocked", "--json"]).then(out => JSON.parse(out) as string[]).catch(() => [] as string[]),
      ])
    );

    const blockedSet = new Set(blockedOutput);
    const beads = issues
      .map(issueToWebviewBead)
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .map(b => {
        b.source = "beads";
        if (blockedSet.has(b.id)) b.isBlocked = true;
        return b;
      });

    // Enrich epics
    const epics = beads.filter(b => b.type === "epic");
    if (epics.length > 0) {
      const childResults = await serialize(() =>
        Promise.all(epics.map(epic => bdJson<Array<{ id: string; dependency_type?: string }>>(
          ["dep", "list", epic.id, "--direction=up"]
        ).catch(() => [])))
      );
      for (let i = 0; i < epics.length; i++) {
        const children = childResults[i];
        if (children.length > 0) {
          epics[i].blocks = children.map(c => ({ id: c.id, dependencyType: (c.dependency_type || "parent-child") as "parent-child" }));
        }
      }
    }

    send({ type: "setBeads", beads });
  } catch (err) {
    send({ type: "setError", error: String(err) });
    send({ type: "setBeads", beads: [] });
  } finally {
    send({ type: "setLoading", loading: false });
  }
}

async function loadBeadDetails(beadId: string, send: (m: ExtensionMessage) => void): Promise<void> {
  send({ type: "setLoading", loading: true });
  try {
    const [issue, comments] = await serialize(() =>
      Promise.all([
        bdJson<Issue>(["show", beadId]),
        bdJson<IssueComment[]>(["comments", "list", beadId]).catch(() => []),
      ])
    );
    if (issue) {
      const issueWithComments = { ...issue, comments };
      const bead = issueToWebviewBead(issueWithComments);
      send({ type: "setBead", bead });
    } else {
      send({ type: "setBead", bead: null });
    }
  } catch (err) {
    send({ type: "setError", error: String(err) });
    send({ type: "setBead", bead: null });
  } finally {
    send({ type: "setLoading", loading: false });
  }
}

// ── Update args builder ─────────────────────────────────────────────

function buildUpdateArgs(beadId: string, updates: Record<string, unknown>): string[] {
  const args = [beadId];
  const fieldMap: Record<string, string> = {
    title: "--title",
    description: "--description",
    status: "--status",
    priority: "--priority",
    design: "--design",
    notes: "--notes",
    assignee: "--assignee",
  };
  for (const [key, flag] of Object.entries(fieldMap)) {
    if (updates[key] !== undefined) args.push(flag, String(updates[key]));
  }
  if (updates.type !== undefined) args.push("--type", String(updates.type));
  if (updates.labels !== undefined) {
    const labels = updates.labels as string[];
    args.push("--set-labels", labels.join(","));
  }
  if (updates.externalRef !== undefined) args.push("--external-ref", String(updates.externalRef));
  if (updates.acceptanceCriteria !== undefined) args.push("--acceptance-criteria", String(updates.acceptanceCriteria));
  if (updates.estimatedMinutes !== undefined) args.push("--estimated-minutes", String(updates.estimatedMinutes));
  return args;
}

// ── Static file serving ─────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ── Database selection ───────────────────────────────────────────────

let discoveredDatabases: DoltDatabase[] = [];
let activeDbName = "";

function selectDatabase(dbName: string): void {
  activeBeadsDir = ensureBeadsDirForDatabase(dbName, doltHost, doltPort);
  activeDbName = dbName;
  console.log(`  switched to: ${dbName}`);
}

// ── Main ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let port = 3000;
let doltHost = "127.0.0.1";
let doltPort = 3307;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) port = parseInt(args[i + 1], 10);
  if (args[i] === "--dolt-host" && args[i + 1]) doltHost = args[i + 1];
  if (args[i] === "--dolt-port" && args[i + 1]) doltPort = parseInt(args[i + 1], 10);
}

// import.meta.dir is src/pwa/, project root is two levels up
const distDir = resolve(dirname(dirname(import.meta.dir)), "dist", "pwa");

console.log(`Beads PWA Server`);
console.log(`  dolt:    ${doltHost}:${doltPort}`);
console.log(`  dist:    ${distDir}`);
console.log(`  port:    ${port}`);

// Discover databases on startup
discoveredDatabases = await discoverDatabases(doltHost, doltPort);
if (discoveredDatabases.length > 0) {
  console.log(`  databases: ${discoveredDatabases.map(d => d.name).join(", ")}`);
  selectDatabase(discoveredDatabases[0].name);
} else {
  console.log(`  warning: no databases found on ${doltHost}:${doltPort}`);
}

const connectedClients = new Set<{ send: (m: ExtensionMessage) => void }>();

Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // REST: database discovery
    if (url.pathname === "/api/databases") {
      return discoverDatabases(doltHost, doltPort).then(dbs =>
        Response.json(dbs)
      );
    }

    // REST: health check
    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", doltHost, doltPort, activeBeadsDir });
    }

    // Static files
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const fullPath = join(distDir, filePath);

    // Security: prevent path traversal
    if (!fullPath.startsWith(distDir)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const content = readFileSync(fullPath);
      const mime = MIME_TYPES[extname(filePath)] || "application/octet-stream";
      return new Response(content, { headers: { "Content-Type": mime } });
    } catch {
      // SPA fallback: serve index.html for non-file routes
      try {
        const index = readFileSync(join(distDir, "index.html"));
        return new Response(index, { headers: { "Content-Type": "text/html" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
  },

  websocket: {
    open(ws) {
      const client = {
        send: (m: ExtensionMessage) => {
          try { ws.send(JSON.stringify(m)); } catch { /* client disconnected */ }
        },
      };
      (ws as unknown as { _client: typeof client })._client = client;
      connectedClients.add(client);
    },
    async message(ws, raw) {
      const client = (ws as unknown as { _client: { send: (m: ExtensionMessage) => void } })._client;
      try {
        const msg = JSON.parse(String(raw)) as WebviewMessage;
        await handleMessage(msg, client.send);
      } catch (err) {
        client.send({ type: "setError", error: String(err) });
      }
    },
    close(ws) {
      const client = (ws as unknown as { _client: { send: (m: ExtensionMessage) => void } })._client;
      connectedClients.delete(client);
    },
  },
});

console.log(`\n  → http://localhost:${port}\n`);
