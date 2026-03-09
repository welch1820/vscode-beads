/**
 * KanbanBoard
 *
 * Status-based board view for issues.
 * Supports drag-and-drop to change status.
 */

import React, { useState, useMemo, useEffect, useRef } from "react";
import { Bead, BeadStatus, BeadType, STATUS_LABELS, STATUS_COLORS, TYPE_COLORS } from "../types";
import { TypeIcon } from "../common/TypeIcon";
import { PriorityBadge } from "../common/PriorityBadge";
import { LabelBadge } from "../common/LabelBadge";
import { Icon } from "../common/Icon";
import { BlockedBadge } from "../common/BlockedBadge";
import { SourceBadge } from "../common/SourceBadge";
import { groupByBlockers } from "../common/groupByBlockers";

interface KanbanBoardProps {
  beads: Bead[];
  /** All beads (unfiltered) — used to populate the epic column regardless of active filters */
  allBeads?: Bead[];
  selectedBeadId: string | null;
  onSelectBead: (beadId: string) => void;
  onUpdateBead?: (beadId: string, updates: Partial<Bead>) => void;
  /** Whether any filters are active (affects empty state messaging) */
  hasActiveFilters?: boolean;
  /** Unfiltered counts per status (to show "0 of N" when filtering) */
  unfilteredCounts?: Record<BeadStatus, number>;
  /** Persisted sort order for within-column reordering (bead ID → order number) */
  sortOrder?: Record<string, number>;
  /** Callback when sort order changes from within-column drag */
  onSortOrderChange?: (sortOrder: Record<string, number>) => void;
  /** Whether the epic column is visible (controlled by parent) */
  epicViewEnabled?: boolean;
  /** IDs of currently selected epics for filtering (controlled by parent) */
  selectedEpicIds?: Set<string>;
  /** Callback when epic selection changes */
  onSelectedEpicIdsChange?: (ids: Set<string>) => void;
}

const ALL_COLUMNS: BeadStatus[] = ["open", "in_progress", "blocked", "closed"];
const COLUMNS: BeadStatus[] = ["open", "in_progress", "closed"];

export function KanbanBoard({ beads, allBeads, selectedBeadId, onSelectBead, onUpdateBead, hasActiveFilters, unfilteredCounts, sortOrder = {}, onSortOrderChange, epicViewEnabled = false, selectedEpicIds: selectedEpicIdsProp, onSelectedEpicIdsChange }: KanbanBoardProps): React.ReactElement {
  // Track which columns are collapsed (blocked is collapsed by default since no beads use status:blocked)
  const [collapsedColumns, setCollapsedColumns] = useState<Set<BeadStatus>>(new Set(["blocked"]));
  // Track which column is being dragged over
  const [dragOverColumn, setDragOverColumn] = useState<BeadStatus | null>(null);
  // Track drop position within a column (index where card would be inserted)
  const [dropIndex, setDropIndex] = useState<{ column: BeadStatus; index: number } | null>(null);
  // Optimistic status overrides for instant visual feedback
  const [optimisticStatus, setOptimisticStatus] = useState<Map<string, BeadStatus>>(new Map());
  // Track which bead is being dragged
  const [draggedBeadId, setDraggedBeadId] = useState<string | null>(null);
  // Epic selection: use controlled props if provided, else internal state
  const [internalEpicIds, setInternalEpicIds] = useState<Set<string>>(new Set());
  const selectedEpicIds = selectedEpicIdsProp ?? internalEpicIds;
  const setSelectedEpicIds = onSelectedEpicIdsChange ?? setInternalEpicIds;

  // Epics come from allBeads (unfiltered) so table filters don't hide them;
  // status columns use the filtered beads with epics excluded
  const epicBeads = useMemo(() => (allBeads ?? beads).filter((b) => b.type === "epic"), [allBeads, beads]);
  const nonEpicBeads = useMemo(() => beads.filter((b) => b.type !== "epic"), [beads]);

  // Build set of bead IDs that are children of selected epics
  const epicChildIds = useMemo(() => {
    if (selectedEpicIds.size === 0) return null; // null = no filtering
    const childIds = new Set<string>();
    // From epic side: epic.blocks contains children
    for (const epic of epicBeads) {
      if (!selectedEpicIds.has(epic.id)) continue;
      if (epic.blocks) {
        for (const dep of epic.blocks) childIds.add(dep.id);
      }
    }
    // From child side: child.blockedBy contains epic IDs
    for (const bead of nonEpicBeads) {
      if (bead.blockedBy) {
        for (const blockerId of bead.blockedBy) {
          if (selectedEpicIds.has(blockerId)) {
            childIds.add(bead.id);
            break;
          }
        }
      }
    }
    return childIds;
  }, [epicBeads, nonEpicBeads, selectedEpicIds]);

  // Beads to show in status columns: always non-epic, optionally filtered by selected epics
  const visibleBeads = useMemo(() => {
    if (!epicChildIds) return nonEpicBeads;
    return nonEpicBeads.filter((b) => epicChildIds.has(b.id));
  }, [nonEpicBeads, epicChildIds]);

  const toggleEpic = (epicId: string) => {
    setSelectedEpicIds((prev) => {
      const next = new Set(prev);
      if (next.has(epicId)) next.delete(epicId);
      else next.add(epicId);
      return next;
    });
  };

  // Auto-expand collapsed column when selected bead is in it
  useEffect(() => {
    if (!selectedBeadId) return;
    const selectedBead = beads.find((b) => b.id === selectedBeadId);
    if (selectedBead && collapsedColumns.has(selectedBead.status)) {
      setCollapsedColumns((prev) => {
        const next = new Set(prev);
        next.delete(selectedBead.status);
        return next;
      });
    }
  }, [selectedBeadId, beads]);

  // Scroll selected card into view
  useEffect(() => {
    if (!selectedBeadId) return;
    // Delay slightly to allow column expansion to render
    const timer = setTimeout(() => {
      const el = document.querySelector(`.kanban-card.selected`);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedBeadId]);

  // Clean up optimistic overrides once the backend catches up
  useEffect(() => {
    if (optimisticStatus.size === 0) return;
    const resolved: string[] = [];
    for (const [id, status] of optimisticStatus) {
      const bead = beads.find((b) => b.id === id);
      if (bead && bead.status === status) resolved.push(id);
    }
    if (resolved.length > 0) {
      setOptimisticStatus((prev) => {
        const next = new Map(prev);
        for (const id of resolved) next.delete(id);
        return next;
      });
    }
  }, [beads, optimisticStatus]);

  // Apply optimistic status overrides to visible (non-epic) beads
  const effectiveBeads = useMemo(() => {
    if (optimisticStatus.size === 0) return visibleBeads;
    return visibleBeads.map((bead) => {
      const statusOverride = optimisticStatus.get(bead.id);
      if (statusOverride && bead.status !== statusOverride) {
        return { ...bead, status: statusOverride };
      }
      return bead;
    });
  }, [visibleBeads, optimisticStatus]);

  const toggleColumn = (status: BeadStatus) => {
    setCollapsedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  };

  // Drag handlers
  const handleDragStart = (e: React.DragEvent, beadId: string) => {
    e.dataTransfer.setData("text/plain", beadId);
    e.dataTransfer.effectAllowed = "move";
    setDraggedBeadId(beadId);
  };

  const handleDragEnd = () => {
    setDraggedBeadId(null);
    setDropIndex(null);
    setDragOverColumn(null);
  };

  const handleDragOver = (e: React.DragEvent, status: BeadStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverColumn(status);
  };

  const handleDragLeave = () => {
    setDragOverColumn(null);
    setDropIndex(null);
  };

  // Track position within a column's card list
  const handleCardDragOver = (e: React.DragEvent, status: BeadStatus, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";

    // Determine if cursor is in top or bottom half of card
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const insertIndex = e.clientY < midY ? index : index + 1;

    setDropIndex({ column: status, index: insertIndex });
    setDragOverColumn(status);
  };

  const handleDrop = (e: React.DragEvent, newStatus: BeadStatus) => {
    e.preventDefault();
    setDragOverColumn(null);

    // Use React state instead of dataTransfer — VS Code's sandboxed webview
    // iframe makes dataTransfer.getData() unreliable
    const beadId = draggedBeadId;
    // Clear drag state immediately to prevent "disabled" appearance if
    // a backend re-render arrives before the browser fires dragEnd
    setDraggedBeadId(null);
    if (!beadId || !onUpdateBead) {
      setDropIndex(null);
      return;
    }
    const bead = beads.find((b) => b.id === beadId);
    if (!bead) {
      setDropIndex(null);
      return;
    }

    const columnItems = grouped[newStatus];
    const sameColumn = bead.status === newStatus;

    if (sameColumn && dropIndex && dropIndex.column === newStatus) {
      // Within-column reorder: update local sortOrder (no CLI call needed)
      const targetIndex = dropIndex.index;
      // Filter out the dragged card to get the remaining items in order
      const others = columnItems.filter((b) => b.id !== beadId);
      // Adjust target index since we removed the dragged card
      const currentIndex = columnItems.findIndex((b) => b.id === beadId);
      const adjustedIndex = currentIndex < targetIndex ? targetIndex - 1 : targetIndex;

      let newOrder: number;
      const getSortOrder = (id: string) => effectiveSortOrder[id] ?? 0;

      if (others.length === 0) {
        newOrder = 0;
      } else if (adjustedIndex <= 0) {
        newOrder = getSortOrder(others[0].id) - 1000;
      } else if (adjustedIndex >= others.length) {
        newOrder = getSortOrder(others[others.length - 1].id) + 1000;
      } else {
        const above = getSortOrder(others[adjustedIndex - 1].id);
        const below = getSortOrder(others[adjustedIndex].id);
        newOrder = (above + below) / 2;
      }

      if (onSortOrderChange) {
        onSortOrderChange({ ...sortOrder, [beadId]: newOrder });
      }
    } else if (!sameColumn) {
      // Cross-column: update status (existing behavior)
      setOptimisticStatus((prev) => new Map(prev).set(beadId, newStatus));
      onUpdateBead(beadId, { status: newStatus });
    }

    setDropIndex(null);
  };

  // Assign initial sortOrder to cards that lack one
  const effectiveSortOrder = useMemo(() => {
    const result = { ...sortOrder };
    ALL_COLUMNS.forEach((status) => {
      const items = effectiveBeads.filter((b) => b.status === status);
      items.forEach((bead, idx) => {
        if (result[bead.id] === undefined) {
          result[bead.id] = idx * 1000;
        }
      });
    });
    return result;
  }, [effectiveBeads, sortOrder]);

  // Persist newly assigned sortOrder values via effect (not inside useMemo)
  const prevSortOrderRef = useRef(sortOrder);
  useEffect(() => {
    if (effectiveSortOrder !== sortOrder && onSortOrderChange) {
      // Check if there are actually new keys
      const hasNew = Object.keys(effectiveSortOrder).some((k) => sortOrder[k] === undefined);
      if (hasNew) {
        prevSortOrderRef.current = effectiveSortOrder;
        onSortOrderChange(effectiveSortOrder);
      }
    }
  }, [effectiveSortOrder, sortOrder, onSortOrderChange]);

  // Group beads by status, sorted by priority then sortOrder tiebreaker,
  // then apply blocker grouping so blocked beads nest under their blockers
  const { grouped, indentLevels } = useMemo(() => {
    const result = {} as Record<BeadStatus, Bead[]>;
    const levels = new Map<string, number>();

    for (const status of COLUMNS) {
      const sorted = effectiveBeads
        .filter((b) => b.status === status)
        .sort((a, b) => {
          if (status === "closed") {
            const aTime = a.closedAt ? new Date(a.closedAt).getTime() : 0;
            const bTime = b.closedAt ? new Date(b.closedAt).getTime() : 0;
            return bTime - aTime;
          }
          const priDiff = (a.priority ?? 2) - (b.priority ?? 2);
          if (priDiff !== 0) return priDiff;
          return (effectiveSortOrder[a.id] ?? 0) - (effectiveSortOrder[b.id] ?? 0);
        });

      const groupedItems = groupByBlockers(sorted);
      result[status] = groupedItems.map((g) => g.bead);
      for (const g of groupedItems) {
        levels.set(g.bead.id, g.indentLevel);
      }
    }

    return { grouped: result, indentLevels: levels };
  }, [effectiveBeads, effectiveSortOrder]);

  return (
    <div className="kanban-wrapper">
      <div className="kanban-board">
        {epicViewEnabled && (
          <div
            className="kanban-column kanban-column--epic"
            style={{ "--column-color": TYPE_COLORS.epic } as React.CSSProperties}
          >
            <div className="kanban-column-header">
              <span className="kanban-column-title">epics</span>
              <span className="kanban-column-count">{epicBeads.length}</span>
            </div>
            <div className="kanban-column-body">
              {epicBeads.map((epic) => (
                <div
                  key={epic.id}
                  className={`kanban-card kanban-card--epic ${selectedEpicIds.has(epic.id) ? "selected" : ""} ${epic.id === selectedBeadId ? "focused" : ""}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) {
                      // Cmd/Ctrl+click: select in detail panel
                      onSelectBead(epic.id);
                    } else {
                      toggleEpic(epic.id);
                    }
                  }}
                >
                  <div className="kanban-card-header">
                    <TypeIcon type="epic" size={12} />
                    <span className="kanban-card-id">{epic.id}</span>
                    <SourceBadge source={epic.source} />
                  </div>
                  <div className="kanban-card-title">{epic.title}</div>
                  <div className="kanban-card-meta">
                    {epic.priority !== undefined && <PriorityBadge priority={epic.priority} size="small" />}
                    <span className="kanban-epic-status">{STATUS_LABELS[epic.status]}</span>
                    {epic.blocks && epic.blocks.length > 0 && (
                      <span className="kanban-epic-child-count">{epic.blocks.length} items</span>
                    )}
                  </div>
                </div>
              ))}
              {epicBeads.length === 0 && (
                <div className="kanban-empty">No epics</div>
              )}
            </div>
          </div>
        )}
        {COLUMNS.map((status) => {
          const isCollapsed = collapsedColumns.has(status);
          const items = grouped[status] || [];
          const isDragOver = dragOverColumn === status;

          return (
            <div
              key={status}
              className={`kanban-column ${isCollapsed ? "collapsed" : ""} ${isDragOver ? "drag-over" : ""}`}
              style={{ "--column-color": STATUS_COLORS[status] } as React.CSSProperties}
              onDragOver={(e) => handleDragOver(e, status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, status)}
            >
              <div
                className="kanban-column-header"
                onClick={() => toggleColumn(status)}
              >
                <span className="kanban-column-title">{STATUS_LABELS[status]}</span>
                <span className="kanban-column-count">
                  {hasActiveFilters && unfilteredCounts && unfilteredCounts[status] !== items.length
                    ? `${items.length}/${unfilteredCounts[status]}`
                    : items.length}
                </span>
              </div>
              {!isCollapsed && (
                <div className="kanban-column-body">
                  {items.map((bead, idx) => (
                    <React.Fragment key={bead.id}>
                      {dropIndex && dropIndex.column === status && dropIndex.index === idx && draggedBeadId !== bead.id && (
                        <div className="kanban-drop-indicator" />
                      )}
                      <div
                        className={`kanban-card ${bead.id === selectedBeadId ? "selected" : ""} ${bead.id === draggedBeadId ? "dragging" : ""} ${(indentLevels.get(bead.id) ?? 0) > 0 ? "kanban-card--nested" : ""}`}
                        draggable={!!onUpdateBead && bead.source !== "bugzilla"}
                        onDragStart={(e) => handleDragStart(e, bead.id)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => handleCardDragOver(e, status, idx)}
                        onClick={() => onSelectBead(bead.id)}
                      >
                        <div className="kanban-card-header">
                          <TypeIcon type={(bead.type || "task") as BeadType} size={12} />
                          <span className="kanban-card-id">{bead.id}</span>
                          <SourceBadge source={bead.source} />
                        </div>
                        <div className="kanban-card-title">{bead.title}</div>
                        <div className="kanban-card-meta">
                          {bead.priority !== undefined && <PriorityBadge priority={bead.priority} size="small" />}
                          {bead.isBlocked && <BlockedBadge />}
                          {bead.assignee && (
                            <>
                              <Icon name="user" size={10} className="kanban-card-icon" />
                              <span className="kanban-card-assignee">{bead.assignee}</span>
                            </>
                          )}
                          {bead.labels && bead.labels.length > 0 && (
                            <>
                              <span className="kanban-card-spacer" />
                              <Icon name="tag" size={10} className="kanban-card-icon" />
                              {bead.labels.slice(0, 3).map((label) => (
                                <LabelBadge key={label} label={label} />
                              ))}
                              {bead.labels.length > 3 && (
                                <span className="kanban-card-labels-more">+{bead.labels.length - 3}</span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </React.Fragment>
                  ))}
                  {/* Drop indicator at end of list */}
                  {dropIndex && dropIndex.column === status && dropIndex.index >= items.length && items.length > 0 && (
                    <div className="kanban-drop-indicator" />
                  )}
                  {items.length === 0 && (
                    <div className="kanban-empty">
                      {hasActiveFilters && unfilteredCounts && unfilteredCounts[status] > 0
                        ? `No matches (${unfilteredCounts[status]} filtered)`
                        : epicChildIds
                          ? "No matches in selected epics"
                          : "No items"}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
