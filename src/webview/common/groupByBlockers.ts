import { Bead } from "../types";

export interface GroupedBead {
  bead: Bead;
  indentLevel: number;
}

/**
 * Reorders beads so that blocked beads (open/in_progress) appear immediately
 * after their primary blocker. If blocked by multiple beads, appears under the
 * highest-priority (lowest number) blocker that's in the list.
 */
export function groupByBlockers(beads: Bead[]): GroupedBead[] {
  const beadMap = new Map(beads.map((b) => [b.id, b]));

  // Build map: blocked bead ID → primary blocker ID (highest priority visible blocker)
  const primaryBlocker = new Map<string, string>();
  for (const bead of beads) {
    if (!bead.isBlocked || !bead.blockedBy || bead.blockedBy.length === 0) continue;
    if (bead.status !== "open" && bead.status !== "in_progress") continue;

    let bestId: string | null = null;
    let bestPriority = Infinity;
    for (const blockerId of bead.blockedBy) {
      const blocker = beadMap.get(blockerId);
      if (!blocker) continue;
      const p = blocker.priority ?? 4;
      if (p < bestPriority || (p === bestPriority && bestId === null)) {
        bestPriority = p;
        bestId = blockerId;
      }
    }
    if (bestId) {
      primaryBlocker.set(bead.id, bestId);
    }
  }

  // Build reverse map: blocker ID → list of blocked bead IDs (in original order)
  const children = new Map<string, string[]>();
  for (const [blockedId, blockerId] of primaryBlocker) {
    const list = children.get(blockerId) || [];
    list.push(blockedId);
    children.set(blockerId, list);
  }

  // Walk the original order, inserting children after each parent
  const placed = new Set<string>();
  const result: GroupedBead[] = [];

  for (const bead of beads) {
    if (placed.has(bead.id)) continue;
    // Skip beads that will be placed under a blocker
    if (primaryBlocker.has(bead.id)) continue;

    placed.add(bead.id);
    result.push({ bead, indentLevel: 0 });

    // Insert blocked children
    const blockedIds = children.get(bead.id);
    if (blockedIds) {
      for (const childId of blockedIds) {
        if (placed.has(childId)) continue;
        const child = beadMap.get(childId);
        if (!child) continue;
        placed.add(childId);
        result.push({ bead: child, indentLevel: 1 });
      }
    }
  }

  // Safety: add any beads not yet placed (e.g., blocker not in list)
  for (const bead of beads) {
    if (!placed.has(bead.id)) {
      result.push({ bead, indentLevel: 0 });
    }
  }

  return result;
}
