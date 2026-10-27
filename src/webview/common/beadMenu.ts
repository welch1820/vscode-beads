/**
 * buildBeadMenuItems
 *
 * Builds the state-appropriate context-menu entries for a bead, shared by the
 * kanban, graph, and table views. Status actions depend on the bead's current
 * status; read-only sources get a reduced set.
 *
 * Source rules:
 *   - bugzilla: read-only — only Open details / Copy ID.
 *   - jira:     status actions allowed (updateBead routes them to a Jira
 *               transition); no Delete (would not delete the Jira issue).
 *   - native:   full set.
 */

import { Bead, BeadStatus } from "../types";
import { ContextMenuEntry } from "./ContextMenu";

export interface BeadMenuHandlers {
  onOpenDetails?: (id: string) => void;
  onViewInGraph?: (id: string) => void;
  onUpdateStatus?: (id: string, status: BeadStatus) => void;
  onCopyId?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function buildBeadMenuItems(bead: Bead, h: BeadMenuHandlers): ContextMenuEntry[] {
  const isBugzilla = bead.source === "bugzilla";
  const isJira = bead.source === "jira";
  const canWriteStatus = !!h.onUpdateStatus && !isBugzilla;

  const nav: ContextMenuEntry[] = [];
  if (h.onOpenDetails) {
    nav.push({ label: "Open details", onClick: () => h.onOpenDetails!(bead.id) });
  }
  if (h.onViewInGraph) {
    nav.push({ label: "View in graph", onClick: () => h.onViewInGraph!(bead.id) });
  }

  const status: ContextMenuEntry[] = [];
  if (canWriteStatus) {
    if (bead.status !== "in_progress" && bead.status !== "closed") {
      status.push({ label: "Start work", onClick: () => h.onUpdateStatus!(bead.id, "in_progress") });
    }
    if (bead.status === "in_progress") {
      status.push({ label: "Stop work", onClick: () => h.onUpdateStatus!(bead.id, "open") });
    }
    if (bead.status === "closed") {
      status.push({ label: "Reopen", onClick: () => h.onUpdateStatus!(bead.id, "open") });
    } else {
      status.push({ label: "Close", onClick: () => h.onUpdateStatus!(bead.id, "closed") });
    }
  }

  const tail: ContextMenuEntry[] = [];
  if (h.onCopyId) {
    tail.push({ label: "Copy ID", onClick: () => h.onCopyId!(bead.id) });
  }
  if (h.onDelete && !isBugzilla && !isJira) {
    tail.push({ label: "Delete", danger: true, onClick: () => h.onDelete!(bead.id) });
  }

  // Join the non-empty groups with separators.
  const groups = [nav, status, tail].filter((g) => g.length > 0);
  const items: ContextMenuEntry[] = [];
  groups.forEach((g, i) => {
    if (i > 0) {
      items.push("separator");
    }
    items.push(...g);
  });
  return items;
}
