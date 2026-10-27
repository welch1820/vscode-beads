/**
 * JiraClient - Fetches issues from a Jira Cloud REST API and normalizes them to Bead objects.
 *
 * Reads are normalized to Beads. The only supported write is status changes, applied via
 * Jira workflow transitions (transitionIssue).
 *
 * Configuration sources (in order of priority):
 * 1. VS Code settings (beads.jira.url, beads.jira.email, beads.jira.apiToken)
 * 2. Environment (JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN)
 */

import { Bead, BeadStatus, BeadPriority } from "./types";

export interface JiraConfig {
  url: string;
  email: string;
  apiToken: string;
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name: string; statusCategory?: { key: string } };
    priority?: { name: string } | null;
    issuetype?: { name: string };
    assignee?: { displayName?: string; emailAddress?: string } | null;
    created?: string;
    updated?: string;
    resolutiondate?: string | null;
    labels?: string[];
  };
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
  errorMessages?: string[];
}

interface JiraTransition {
  id: string;
  name: string;
  to?: { statusCategory?: { key: string } };
}

// A Bead status maps to the Jira status categories that can satisfy it.
// Kanban only surfaces open/in_progress/closed columns; blocked reuses in_progress.
const STATUS_CATEGORY_TARGETS: Record<BeadStatus, string[]> = {
  open: ["new", "undefined"],
  in_progress: ["indeterminate"],
  blocked: ["indeterminate"],
  closed: ["done"],
};

/**
 * Build a complete JiraConfig by merging VS Code settings with environment fallbacks.
 */
export function resolveConfig(vsCodeConfig: JiraConfig): JiraConfig {
  return {
    url: vsCodeConfig.url || process.env.JIRA_URL || "",
    email: vsCodeConfig.email || process.env.JIRA_USERNAME || "",
    apiToken: vsCodeConfig.apiToken || process.env.JIRA_API_TOKEN || "",
  };
}

// Map Jira's status category (stable across custom workflows) to a Bead status.
function normalizeStatus(issue: JiraIssue): BeadStatus {
  switch (issue.fields.status?.statusCategory?.key) {
    case "done": return "closed";
    case "indeterminate": return "in_progress";
    default: return "open";
  }
}

function normalizePriority(priority: string | undefined): BeadPriority {
  switch ((priority || "").toLowerCase()) {
    case "highest": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
    case "lowest": return 4;
    default: return 2;
  }
}

function normalizeType(issuetype: string | undefined): string {
  switch ((issuetype || "").toLowerCase()) {
    case "bug": return "bug";
    case "epic": return "epic";
    case "story": return "feature";
    default: return "task";
  }
}

function issueToBead(issue: JiraIssue, baseUrl: string): Bead {
  const f = issue.fields;
  return {
    id: `jira-${issue.key}`,
    title: f.summary,
    type: normalizeType(f.issuetype?.name),
    priority: normalizePriority(f.priority?.name),
    status: normalizeStatus(issue),
    assignee: f.assignee?.displayName || f.assignee?.emailAddress || "",
    labels: f.labels ?? [],
    source: "jira",
    externalRef: `${baseUrl}/browse/${issue.key}`,
    createdAt: f.created,
    updatedAt: f.updated,
    closedAt: f.resolutiondate ?? undefined,
  };
}

const FIELDS = "summary,status,priority,issuetype,assignee,created,updated,resolutiondate,labels";
// Issues assigned to the authenticated user that are still open.
const ASSIGNED_JQL = "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";

export class JiraClient {
  private readonly config: JiraConfig;

  constructor(config: JiraConfig) {
    this.config = config;
  }

  static isConfigured(config: JiraConfig): boolean {
    return !!(config.url && config.email && config.apiToken);
  }

  private headers(): Record<string, string> {
    const token = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64");
    return { Accept: "application/json", Authorization: `Basic ${token}` };
  }

  async fetchAssignedIssues(): Promise<Bead[]> {
    const baseUrl = this.config.url.replace(/\/+$/, "");
    const params = new URLSearchParams({ jql: ASSIGNED_JQL, fields: FIELDS, maxResults: "100" });

    const response = await fetch(`${baseUrl}/rest/api/3/search/jql?${params}`, {
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as JiraSearchResponse;
    if (data.errorMessages?.length) {
      throw new Error(`Jira API: ${data.errorMessages.join("; ")}`);
    }
    return (data.issues ?? []).map((issue) => issueToBead(issue, baseUrl));
  }

  async fetchIssue(key: string): Promise<Bead | null> {
    const baseUrl = this.config.url.replace(/\/+$/, "");
    const params = new URLSearchParams({ fields: FIELDS });

    const response = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?${params}`, {
      headers: this.headers(),
    });

    if (!response.ok) {
      return null;
    }

    const issue = (await response.json()) as JiraIssue;
    if (!issue?.key) {
      return null;
    }
    return issueToBead(issue, baseUrl);
  }

  /**
   * Move an issue to the workflow status matching the given Bead status.
   *
   * Jira has no "set status" API — status changes go through named workflow
   * transitions. We fetch the transitions available from the issue's current
   * status and pick the first one landing in the target status category.
   */
  async transitionIssue(key: string, targetStatus: BeadStatus): Promise<void> {
    const baseUrl = this.config.url.replace(/\/+$/, "");
    const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;

    const listResponse = await fetch(url, { headers: this.headers() });
    if (!listResponse.ok) {
      throw new Error(`Jira transitions error: ${listResponse.status} ${listResponse.statusText}`);
    }

    const { transitions = [] } = (await listResponse.json()) as { transitions?: JiraTransition[] };
    const wanted = STATUS_CATEGORY_TARGETS[targetStatus] ?? [];
    const match = transitions.find(
      (t) => t.to?.statusCategory?.key && wanted.includes(t.to.statusCategory.key)
    );
    if (!match) {
      throw new Error(`No Jira transition to "${targetStatus}" is available for ${key}`);
    }

    const postResponse = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    if (!postResponse.ok) {
      const detail = await postResponse.text().catch(() => "");
      throw new Error(`Jira transition failed: ${postResponse.status} ${postResponse.statusText} ${detail}`.trim());
    }
  }
}
