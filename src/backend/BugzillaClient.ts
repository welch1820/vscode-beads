/**
 * BugzillaClient - Fetches bugs from a Bugzilla REST API and normalizes them to Bead objects.
 *
 * Read-only: no mutations are sent back to Bugzilla.
 *
 * Configuration sources (in order of priority):
 * 1. VS Code settings (beads.bugzilla.url, apiKey, username)
 * 2. ~/.bugzillarc (INI format used by python-bugzilla CLI)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Bead, BeadStatus, BeadPriority } from "./types";

export interface BugzillaConfig {
  url: string;
  apiKey: string;
  username: string;
}

interface BugzillaBug {
  id: number;
  summary: string;
  status: string;
  resolution: string;
  priority: string;
  severity: string;
  assigned_to: string;
  component: string;
  product: string;
  keywords: string[];
  creation_time: string;
  last_change_time: string;
  cf_last_closed?: string;
  blocks: number[];
  depends_on: number[];
}

interface BugzillaResponse {
  bugs: BugzillaBug[];
  error?: boolean;
  message?: string;
}

/**
 * Parse ~/.bugzillarc (INI format) to extract URL and API key.
 * Format:
 *   [https://bugzilla.example.com]
 *   api_key=...
 */
function parseBugzillarc(): { url: string; apiKey: string } | null {
  // python-bugzilla CLI stores config in ~/.config/python-bugzilla/bugzillarc
  // Also check ~/.bugzillarc as a fallback
  const candidates = [
    path.join(os.homedir(), ".config", "python-bugzilla", "bugzillarc"),
    path.join(os.homedir(), ".bugzillarc"),
  ];
  for (const rcPath of candidates) {
    try {
      const content = fs.readFileSync(rcPath, "utf-8");
      const urlMatch = content.match(/^\[(.+?)\]\s*$/m);
      const keyMatch = content.match(/^api_key\s*=\s*(.+?)\s*$/m);
      if (urlMatch && keyMatch) {
        return { url: urlMatch[1], apiKey: keyMatch[1] };
      }
    } catch {
      // File doesn't exist or isn't readable
    }
  }
  return null;
}

/**
 * Build a complete BugzillaConfig by merging VS Code settings with ~/.bugzillarc fallbacks.
 */
export function resolveConfig(vsCodeConfig: BugzillaConfig): BugzillaConfig {
  const rc = parseBugzillarc();
  return {
    url: vsCodeConfig.url || rc?.url || "",
    apiKey: vsCodeConfig.apiKey || rc?.apiKey || "",
    username: vsCodeConfig.username || "",
  };
}

function normalizeStatus(status: string, resolution: string): BeadStatus {
  const s = status.toUpperCase();
  if (s === "RESOLVED" || s === "VERIFIED" || s === "CLOSED") return "closed";
  if (resolution && resolution !== "---") return "closed";
  if (s === "IN_PROGRESS" || s === "ASSIGNED") return "in_progress";
  return "open";
}

function normalizePriority(priority: string): BeadPriority {
  switch (priority) {
    case "P1": return 0;
    case "P2": return 1;
    case "P3": return 2;
    case "P4": return 3;
    case "P5": return 4;
    default: return 2;
  }
}

function normalizeType(severity: string): string {
  const s = severity.toLowerCase();
  if (s === "enhancement") return "feature";
  if (s === "blocker" || s === "critical" || s === "major" || s === "minor" || s === "trivial" || s === "normal") return "bug";
  return "task";
}

function bugToBead(bug: BugzillaBug, baseUrl: string): Bead {
  return {
    id: `bz-${bug.id}`,
    title: bug.summary,
    description: `${bug.product} / ${bug.component}`,
    type: normalizeType(bug.severity),
    priority: normalizePriority(bug.priority),
    status: normalizeStatus(bug.status, bug.resolution),
    assignee: bug.assigned_to,
    labels: bug.keywords,
    bugzillaId: bug.id,
    source: "bugzilla",
    externalRef: `${baseUrl}/show_bug.cgi?id=${bug.id}`,
    createdAt: bug.creation_time,
    updatedAt: bug.last_change_time,
    closedAt: bug.cf_last_closed,
    dependsOn: bug.depends_on.map((id) => ({
      id: `bz-${id}`,
      dependencyType: "blocks" as const,
    })),
    blocks: bug.blocks.map((id) => ({
      id: `bz-${id}`,
      dependencyType: "blocks" as const,
    })),
  };
}

export class BugzillaClient {
  private readonly config: BugzillaConfig;

  constructor(config: BugzillaConfig) {
    this.config = config;
  }

  static isConfigured(config: BugzillaConfig): boolean {
    return !!(config.url && config.apiKey && config.username);
  }

  async fetchAssignedBugs(): Promise<Bead[]> {
    const { url, apiKey, username } = this.config;
    const baseUrl = url.replace(/\/+$/, "");

    const params = new URLSearchParams({
      assigned_to: username,
      include_fields: "id,summary,status,resolution,priority,severity,assigned_to,component,product,keywords,creation_time,last_change_time,cf_last_closed,blocks,depends_on",
      api_key: apiKey,
    });
    // Unresolved bugs use "---" or "" depending on Bugzilla configuration
    params.append("resolution", "---");
    params.append("resolution", "");

    const response = await fetch(`${baseUrl}/rest.cgi/bug?${params}`, {
      headers: { "Accept": "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Bugzilla API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as BugzillaResponse;
    if (data.error) {
      throw new Error(`Bugzilla API: ${data.message || "Unknown error"}`);
    }
    return data.bugs.map((bug) => bugToBead(bug, baseUrl));
  }

  async fetchBug(bugId: number): Promise<Bead | null> {
    const { url, apiKey } = this.config;
    const baseUrl = url.replace(/\/+$/, "");

    const params = new URLSearchParams({
      include_fields: "id,summary,status,resolution,priority,severity,assigned_to,component,product,keywords,creation_time,last_change_time,cf_last_closed,blocks,depends_on",
      api_key: apiKey,
    });

    const response = await fetch(`${baseUrl}/rest.cgi/bug/${bugId}?${params}`, {
      headers: { "Accept": "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as BugzillaResponse;
    if (data.error || !data.bugs.length) {
      return null;
    }
    return bugToBead(data.bugs[0], baseUrl);
  }
}
