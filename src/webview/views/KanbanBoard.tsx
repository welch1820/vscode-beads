/**
 * KanbanBoard
 *
 * Status-based board view for issues.
 * Supports drag-and-drop to change status.
 */

import React, { useState, useMemo, useEffect, useRef } from "react";
import { Bead, BeadStatus, BeadType, STATUS_LABELS, STATUS_COLORS } from "../types";
import { TypeIcon } from "../common/TypeIcon";
import { PriorityBadge } from "../common/PriorityBadge";
import { LabelBadge } from "../common/LabelBadge";
import { Icon } from "../common/Icon";
import { BlockedBadge } from "../common/BlockedBadge";
import { groupByBlockers } from "../common/groupByBlockers";

interface KanbanBoardProps {
  beads: Bead[];
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
}

const COLUMNS: BeadStatus[] = ["open", "in_progress", "blocked", "closed"];

export function KanbanBoard({ beads, selectedBeadId, onSelectBead, onUpdateBead, hasActiveFilters, unfilteredCounts, sortOrder = {}, onSortOrderChange }: KanbanBoardProps): React.ReactElement {
  // Track which columns are collapsed (closed is collapsed by default)
  const [collapsedColumns, setCollapsedColumns] = useState<Set<BeadStatus>>(new Set(["closed"]));
  // Track which column is being dragged over
  const [dragOverColumn, setDragOverColumn] = useState<BeadStatus | null>(null);
  // Track drop position within a column (index where card would be inserted)
  const [dropIndex, setDropIndex] = useState<{ column: BeadStatus; index: number } | null>(null);
  // Optimistic status overrides for instant visual feedback
  const [optimisticStatus, setOptimisticStatus] = useState<Map<string, BeadStatus>>(new Map());
  // Track which bead is being dragged
  const [draggedBeadId, setDraggedBeadId] = useState<string | null>(null);

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

  // Apply optimistic status overrides to beads
  const effectiveBeads = useMemo(() => {
    if (optimisticStatus.size === 0) return beads;
    return beads.map((bead) => {
      const statusOverride = optimisticStatus.get(bead.id);
      if (statusOverride && bead.status !== statusOverride) {
        return { ...bead, status: statusOverride };
      }
      return bead;
    });
  }, [beads, optimisticStatus]);

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
    COLUMNS.forEach((status) => {
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
    <div className="kanban-board">
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
                      draggable={!!onUpdateBead}
                      onDragStart={(e) => handleDragStart(e, bead.id)}
                      onDragEnd={handleDragEnd}
                      onDragOver={(e) => handleCardDragOver(e, status, idx)}
                      onClick={() => onSelectBead(bead.id)}
                    >
                      <div className="kanban-card-header">
                        <TypeIcon type={(bead.type || "task") as BeadType} size={12} />
                        <span className="kanban-card-id">{bead.id}</span>
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
                      : "No items"}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
