// Copyright (c) 2026 Starten Systems
// Author: Bill Welch
//
// This source code is the property of Starten Systems.
// Unauthorized copying, modification, or distribution of this file, via any medium, is strictly prohibited without prior written consent.
// All rights reserved.
//

import { buildEpicChildIds, toggleEpicSelection } from "../webview/common/epic-filter";
import type { Bead } from "../webview/types";

/** Minimal bead helper — only fields needed by buildEpicChildIds */
function bead(id: string, overrides: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", ...overrides };
}

describe("buildEpicChildIds", () => {
  it("returns null when no epics are selected", () => {
    const epics = [bead("epic-1", { type: "epic" })];
    const children = [bead("child-1")];
    expect(buildEpicChildIds(epics, children, new Set())).toBeNull();
  });

  it("finds children via epic.blocks", () => {
    const epics = [bead("epic-1", {
      type: "epic",
      blocks: [{ id: "child-1" }, { id: "child-2" }],
    })];
    const children = [bead("child-1"), bead("child-2"), bead("child-3")];
    const result = buildEpicChildIds(epics, children, new Set(["epic-1"]));
    expect(result).toEqual(new Set(["child-1", "child-2"]));
  });

  it("finds children via bead.blockedBy", () => {
    const epics = [bead("epic-1", { type: "epic" })];
    const children = [
      bead("child-1", { blockedBy: ["epic-1"] }),
      bead("child-2"),
    ];
    const result = buildEpicChildIds(epics, children, new Set(["epic-1"]));
    expect(result).toEqual(new Set(["child-1"]));
  });

  it("finds children via dependsOn with parent-child type", () => {
    const epics = [bead("epic-1", { type: "epic" })];
    const children = [
      bead("child-1", {
        dependsOn: [{ id: "epic-1", dependencyType: "parent-child" }],
      }),
      bead("child-2"),
    ];
    const result = buildEpicChildIds(epics, children, new Set(["epic-1"]));
    expect(result).toEqual(new Set(["child-1"]));
  });

  it("ignores dependsOn with non-parent-child type", () => {
    const epics = [bead("epic-1", { type: "epic" })];
    const children = [
      bead("child-1", {
        dependsOn: [{ id: "epic-1", dependencyType: "related" }],
      }),
    ];
    const result = buildEpicChildIds(epics, children, new Set(["epic-1"]));
    expect(result).toEqual(new Set());
  });

  it("combines all three sources without duplicates", () => {
    const epics = [bead("epic-1", {
      type: "epic",
      blocks: [{ id: "child-1" }],
    })];
    const children = [
      bead("child-1", {
        blockedBy: ["epic-1"],
        dependsOn: [{ id: "epic-1", dependencyType: "parent-child" }],
      }),
      bead("child-2", {
        dependsOn: [{ id: "epic-1", dependencyType: "parent-child" }],
      }),
    ];
    const result = buildEpicChildIds(epics, children, new Set(["epic-1"]));
    expect(result).toEqual(new Set(["child-1", "child-2"]));
  });

  it("only returns children of selected epics, not all epics", () => {
    const epics = [
      bead("epic-1", { type: "epic", blocks: [{ id: "child-1" }] }),
      bead("epic-2", { type: "epic", blocks: [{ id: "child-2" }] }),
    ];
    const children = [bead("child-1"), bead("child-2")];
    const result = buildEpicChildIds(epics, children, new Set(["epic-1"]));
    expect(result).toEqual(new Set(["child-1"]));
  });

  it("returns empty set when selected epic has no children", () => {
    const epics = [bead("epic-1", { type: "epic" })];
    const children = [bead("child-1"), bead("child-2")];
    const result = buildEpicChildIds(epics, children, new Set(["epic-1"]));
    expect(result).toEqual(new Set());
  });

  it("handles empty epic and child arrays", () => {
    expect(buildEpicChildIds([], [], new Set(["epic-1"]))).toEqual(new Set());
  });
});

describe("toggleEpicSelection", () => {
  it("selects an epic from empty selection", () => {
    const result = toggleEpicSelection(new Set(), "epic-1");
    expect(result).toEqual(new Set(["epic-1"]));
  });

  it("deselects the only selected epic", () => {
    const result = toggleEpicSelection(new Set(["epic-1"]), "epic-1");
    expect(result).toEqual(new Set());
  });

  it("replaces selection when clicking a different epic", () => {
    const result = toggleEpicSelection(new Set(["epic-1"]), "epic-2");
    expect(result).toEqual(new Set(["epic-2"]));
  });

  it("replaces multi-selection with single epic (legacy state)", () => {
    const result = toggleEpicSelection(new Set(["epic-1", "epic-2"]), "epic-1");
    expect(result).toEqual(new Set(["epic-1"]));
  });

  it("replaces multi-selection when clicking a new epic", () => {
    const result = toggleEpicSelection(new Set(["epic-1", "epic-2"]), "epic-3");
    expect(result).toEqual(new Set(["epic-3"]));
  });
});
