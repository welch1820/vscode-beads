/**
 * KanbanBoard
 *
 * Status-based board view for issues.
 * Supports drag-and-drop to change status.
 */

import React, { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
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
  /** Callback when a bead is dropped onto an epic (creates dependency) */
  onAddDependency?: (sourceId: string, targetId: string, dependencyType: string, reverse: boolean) => void;
}

const ALL_COLUMNS: BeadStatus[] = ["open", "in_progress", "blocked", "closed"];
const COLUMNS: BeadStatus[] = ["open", "in_progress", "closed"];

export function KanbanBoard({ beads, allBeads, selectedBeadId, onSelectBead, onUpdateBead, hasActiveFilters, unfilteredCounts, sortOrder = {}, onSortOrderChange, epicViewEnabled = false, selectedEpicIds: selectedEpicIdsProp, onSelectedEpicIdsChange, onAddDependency }: KanbanBoardProps): React.ReactElement {
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
  // Ref mirrors draggedBeadId for use in drag event handlers (state is stale in closures during drag)
  const draggedBeadIdRef = useRef<string | null>(null);
  // Track which epic card is being dragged over (for drop-onto-epic)
  const [dragOverEpicId, setDragOverEpicId] = useState<string | null>(null);
  // Ref preserves dragOverEpicId across dragleave→dragend race (dragleave clears state before dragend reads it)
  const dragOverEpicIdRef = useRef<string | null>(null);
  // Refs preserve dragOverColumn/dropIndex across the same dragleave→dragend race
  // (VS Code's sandboxed webview iframe doesn't fire drop events reliably, so we handle drops in dragEnd)
  const dragOverColumnRef = useRef<BeadStatus | null>(null);
  const dropIndexRef = useRef<{ column: BeadStatus; index: number } | null>(null);
  // Whether handleDrop already processed this drag (skip duplicate handling in dragEnd)
  const dropHandledRef = useRef(false);
  // Shift+drag activates epic assignment mode; plain drag moves between lanes
  const shiftDragRef = useRef(false);
  // Track shift key state via every event type that carries modifier info.
  // Keyboard events alone are unreliable in VS Code webview (focus timing issues).
  // pointermove/pointerdown fire before drag starts; dragover fires continuously during drag.
  const shiftKeyDownRef = useRef(false);
  useEffect(() => {
    const track = (e: Event) => { shiftKeyDownRef.current = (e as KeyboardEvent | MouseEvent).shiftKey; };
    const events = ["keydown", "keyup", "pointerdown", "pointermove", "dragover"] as const;
    for (const evt of events) document.addEventListener(evt, track, true);
    return () => { for (const evt of events) document.removeEventListener(evt, track, true); };
  }, []);
  // Track mouse position and source card center for arrow overlay (viewport coords)
  const [dragMousePos, setDragMousePos] = useState<{ x: number; y: number } | null>(null);
  const [dragSourceRect, setDragSourceRect] = useState<{ x: number; y: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  // Epic selection: use controlled props if provided, else internal state
  const [internalEpicIds, setInternalEpicIds] = useState<Set<string>>(new Set());
  const selectedEpicIds = selectedEpicIdsProp ?? internalEpicIds;
  const setSelectedEpicIds = onSelectedEpicIdsChange ?? setInternalEpicIds;

  // Epics come from allBeads (unfiltered) so table filters don't hide them;
  // status columns use the filtered beads with epics excluded
  const epicBeads = useMemo(() => (allBeads ?? beads).filter((b) => b.type === "epic" && b.status !== "closed"), [allBeads, beads]);
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

  // Helper: update drag mouse position in viewport coords (called from all dragOver handlers)
  const updateDragMousePos = (e: React.DragEvent) => {
    if (!draggedBeadIdRef.current || !epicViewEnabled) return;
    // Detect shift mid-drag (fallback for environments where dragstart misses shiftKey)
    if (!shiftDragRef.current && (e.shiftKey || shiftKeyDownRef.current)) {
      shiftDragRef.current = true;
    }
    if (!shiftDragRef.current) return;
    setDragMousePos({ x: e.clientX, y: e.clientY });
  };

  // Drag handlers
  const handleDragStart = (e: React.DragEvent, beadId: string) => {
    e.dataTransfer.setData("text/plain", beadId);
    e.dataTransfer.effectAllowed = "move";
    setDraggedBeadId(beadId);
    draggedBeadIdRef.current = beadId;
    shiftDragRef.current = e.shiftKey || shiftKeyDownRef.current;

    const card = e.currentTarget as HTMLElement;
    const cardRect = card.getBoundingClientRect();

    if (epicViewEnabled && shiftDragRef.current) {
      // Use transparent drag image so the card stays in place (like graph view)
      const img = new Image();
      img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      e.dataTransfer.setDragImage(img, 0, 0);
    } else {
      // Clone card to document.body so it's not clipped by overflow ancestors
      const clone = card.cloneNode(true) as HTMLElement;
      clone.style.position = "fixed";
      clone.style.top = "-9999px";
      clone.style.left = "-9999px";
      clone.style.width = `${cardRect.width}px`;
      clone.style.zIndex = "-1";
      document.body.appendChild(clone);
      e.dataTransfer.setDragImage(clone, e.clientX - cardRect.left, e.clientY - cardRect.top);
      requestAnimationFrame(() => document.body.removeChild(clone));
    }

    // Record source card center in viewport coords
    setDragSourceRect({
      x: cardRect.left + cardRect.width / 2,
      y: cardRect.top + cardRect.height / 2,
    });
  };

  const handleDragEnd = () => {
    // Use ref (not state) — state is stale in drag event closures
    const beadId = draggedBeadIdRef.current;

    // Epic assignment: check first — if dropped on an epic card, assign regardless of Shift
    const epicId = dragOverEpicIdRef.current;
    if (beadId && epicId && onAddDependency && beadId !== epicId) {
      onAddDependency(beadId, epicId, "parent-child", false);
    } else if (!dropHandledRef.current && beadId && onUpdateBead) {
      // VS Code's sandboxed webview iframe doesn't fire drop events reliably,
      // so we handle lane drops here using refs (same pattern as epic drops).
      const newStatus = dragOverColumnRef.current;
      if (newStatus) {
        const bead = beads.find((b) => b.id === beadId) ?? epicBeads.find((b) => b.id === beadId);
        if (bead) {
          if (bead.type === "epic") {
            if (bead.status !== newStatus) {
              onUpdateBead(beadId, { status: newStatus });
              setOptimisticStatus((prev) => new Map(prev).set(beadId!, newStatus));
            }
          } else {
            const sameColumn = bead.status === newStatus;
            const currentDropIndex = dropIndexRef.current;
            if (sameColumn && currentDropIndex && currentDropIndex.column === newStatus) {
              // Within-column reorder
              const columnItems = grouped[newStatus];
              const targetIndex = currentDropIndex.index;
              const others = columnItems.filter((b) => b.id !== beadId);
              const currentIndex = columnItems.findIndex((b) => b.id === beadId);
              const adjustedIndex = currentIndex < targetIndex ? targetIndex - 1 : targetIndex;
              const getSortOrder = (id: string) => effectiveSortOrder[id] ?? 0;
              let newOrder: number;
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
                onSortOrderChange({ ...sortOrder, [beadId!]: newOrder });
              }
            } else if (!sameColumn) {
              setOptimisticStatus((prev) => new Map(prev).set(beadId!, newStatus));
              onUpdateBead(beadId, { status: newStatus });
            }
          }
        }
      }
    }
    // Reset all drag state
    dropHandledRef.current = false;
    setDraggedBeadId(null);
    draggedBeadIdRef.current = null;
    setDropIndex(null);
    dropIndexRef.current = null;
    setDragOverColumn(null);
    dragOverColumnRef.current = null;
    setDragOverEpicId(null);
    dragOverEpicIdRef.current = null;
    shiftDragRef.current = false;
    setDragMousePos(null);
    setDragSourceRect(null);
  };

  const handleDragOver = (e: React.DragEvent, status: BeadStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverColumn(status);
    dragOverColumnRef.current = status;
    updateDragMousePos(e);
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

    const di = { column: status, index: insertIndex };
    setDropIndex(di);
    dropIndexRef.current = di;
    setDragOverColumn(status);
    dragOverColumnRef.current = status;
    updateDragMousePos(e);
  };

  const handleDrop = (e: React.DragEvent, newStatus: BeadStatus) => {
    e.preventDefault();
    dropHandledRef.current = true;
    setDragOverColumn(null);
    dragOverColumnRef.current = null;

    // Use React state instead of dataTransfer — VS Code's sandboxed webview
    // iframe makes dataTransfer.getData() unreliable
    const beadId = draggedBeadId;
    // Clear drag state immediately to prevent "disabled" appearance if
    // a backend re-render arrives before the browser fires dragEnd
    setDraggedBeadId(null);
    draggedBeadIdRef.current = null;
    if (!beadId || !onUpdateBead) {
      setDropIndex(null);
      dropIndexRef.current = null;
      return;
    }
    const bead = beads.find((b) => b.id === beadId) ?? epicBeads.find((b) => b.id === beadId);
    if (!bead) {
      setDropIndex(null);
      dropIndexRef.current = null;
      return;
    }

    // Epic dragged to a status column — just update status, no reorder logic
    if (bead.type === "epic") {
      if (bead.status !== newStatus) {
        onUpdateBead(beadId, { status: newStatus });
        setOptimisticStatus((prev) => new Map(prev).set(beadId, newStatus));
      }
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
    dropIndexRef.current = null;
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
      <div
        className="kanban-board"
        ref={boardRef}
        onDragOver={(e) => updateDragMousePos(e)}
      >
        {epicViewEnabled && (
          <div
            className="kanban-column kanban-column--epic"
            style={{ "--column-color": TYPE_COLORS.epic } as React.CSSProperties}
            onDragOver={(e) => {
              if (draggedBeadIdRef.current && onAddDependency) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "link";
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const beadId = draggedBeadIdRef.current;
              if (beadId && dragOverEpicId && onAddDependency && beadId !== dragOverEpicId) {
                onAddDependency(beadId, dragOverEpicId, "parent-child", false);
              }
              setDraggedBeadId(null);
              draggedBeadIdRef.current = null;
              setDragOverEpicId(null);
              dragOverEpicIdRef.current = null;
              setDropIndex(null);
              setDragOverColumn(null);
            }}
          >
            <div className="kanban-column-header">
              <span className="kanban-column-title">epics</span>
              <span className="kanban-column-count">{epicBeads.length}</span>
            </div>
            <div className="kanban-column-body">
              {epicBeads.map((epic) => (
                <div
                  key={epic.id}
                  className={`kanban-card kanban-card--epic ${selectedEpicIds.has(epic.id) ? "selected" : ""} ${epic.id === selectedBeadId ? "focused" : ""} ${dragOverEpicId === epic.id ? "epic-drop-target" : ""}`}
                  draggable={!!onUpdateBead}
                  onDragStart={(e) => handleDragStart(e, epic.id)}
                  onDragEnd={handleDragEnd}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) {
                      // Cmd/Ctrl+click: select in detail panel
                      onSelectBead(epic.id);
                    } else {
                      toggleEpic(epic.id);
                    }
                  }}
                  onDragOver={(e) => {
                    const beadId = draggedBeadIdRef.current;
                    if (beadId && onAddDependency && beadId !== epic.id) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "link";
                      setDragOverEpicId(epic.id);
                      dragOverEpicIdRef.current = epic.id;
                      updateDragMousePos(e);
                    }
                  }}
                  onDragLeave={() => {
                    setDragOverEpicId((prev) => prev === epic.id ? null : prev);
                    // Don't clear ref here — handleDragEnd needs it (dragleave fires before dragend)
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const beadId = draggedBeadIdRef.current;
                    if (beadId && onAddDependency && beadId !== epic.id) {
                      dropHandledRef.current = true;
                      onAddDependency(beadId, epic.id, "parent-child", false);
                    }
                    setDraggedBeadId(null);
                    draggedBeadIdRef.current = null;
                    setDragOverEpicId(null);
                    dragOverEpicIdRef.current = null;
                    setDropIndex(null);
                    setDragOverColumn(null);
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
                  {dragOverEpicId === epic.id && (
                    <div className="kanban-epic-drop-label">blocks</div>
                  )}
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
      {/* Drag line overlay: rendered via portal to escape overflow clipping from kanban-board/column-body */}
      {draggedBeadId && epicViewEnabled && dragSourceRect && dragMousePos && createPortal(
        <svg
          width={window.innerWidth}
          height={window.innerHeight}
          viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}
          style={{ position: "fixed", top: 0, left: 0, pointerEvents: "none", zIndex: 10000 }}
        >
          <line
            x1={dragSourceRect.x} y1={dragSourceRect.y}
            x2={dragMousePos.x} y2={dragMousePos.y}
            stroke={dragOverEpicId ? "#3b82f6" : "#fbbf24"}
            strokeWidth={2}
            strokeDasharray="6 3"
          />
        </svg>,
        document.body
      )}
    </div>
  );
}
