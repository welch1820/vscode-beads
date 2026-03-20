// Copyright (c) 2026 Starten Systems
// Author: Bill Welch
//
// This source code is the property of Starten Systems.
// Unauthorized copying, modification, or distribution of this file, via any medium, is strictly prohibited without prior written consent.
// All rights reserved.
//

import type { Bead } from "../types";

/**
 * Build set of bead IDs that are children of the selected epics.
 * Returns null when no epics are selected (no filtering).
 */
export function buildEpicChildIds(
  epicBeads: Bead[],
  nonEpicBeads: Bead[],
  selectedEpicIds: Set<string>,
): Set<string> | null {
  if (selectedEpicIds.size === 0) return null;
  const childIds = new Set<string>();
  // From epic side: epic.blocks contains children
  for (const epic of epicBeads) {
    if (!selectedEpicIds.has(epic.id)) continue;
    if (epic.blocks) {
      for (const dep of epic.blocks) childIds.add(dep.id);
    }
  }
  // From child side: check blockedBy (blocks deps) and dependsOn (parent-child deps)
  for (const bead of nonEpicBeads) {
    if (bead.blockedBy) {
      for (const blockerId of bead.blockedBy) {
        if (selectedEpicIds.has(blockerId)) {
          childIds.add(bead.id);
          break;
        }
      }
    }
    if (!childIds.has(bead.id) && bead.dependsOn) {
      for (const dep of bead.dependsOn) {
        if (dep.dependencyType === "parent-child" && selectedEpicIds.has(dep.id)) {
          childIds.add(bead.id);
          break;
        }
      }
    }
  }
  return childIds;
}

/**
 * Single-select epic toggle: clicking the already-selected epic deselects it;
 * clicking a different epic replaces the selection.
 */
export function toggleEpicSelection(
  current: Set<string>,
  epicId: string,
): Set<string> {
  if (current.has(epicId) && current.size === 1) {
    return new Set();
  }
  return new Set([epicId]);
}
