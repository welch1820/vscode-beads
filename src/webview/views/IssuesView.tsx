/**
 * IssuesView
 *
 * Main table/list view for issues using TanStack Table v8.
 * Features:
 * - Multi-column sorting (shift+click for secondary sort)
 * - Column resizing
 * - Column reordering (drag & drop)
 * - Faceted filtering with counts
 * - Column visibility toggle
 * - State persistence (sort order, column visibility, column order survive reloads)
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  flexRender,
  createColumnHelper,
  ColumnFiltersState,
  ColumnResizeMode,
} from "@tanstack/react-table";
import {
  Bead,
  BeadsProject,
  BeadStatus,
  BeadPriority,
  BeadType,
  DependencyGraph,
  DependencyType,
  STATUS_LABELS,
  STATUS_COLORS,
  PRIORITY_COLORS,
  TYPE_LABELS,
  TYPE_COLORS,
  TYPE_SORT_ORDER,
  getTypeSortOrder,
  sortLabels,
  vscode,
} from "../types";
import { StatusBadge } from "../common/StatusBadge";
import { BlockedBadge } from "../common/BlockedBadge";
import { SourceBadge } from "../common/SourceBadge";
import { PriorityBadge } from "../common/PriorityBadge";
import { TypeBadge } from "../common/TypeBadge";
import { TypeIcon } from "../common/TypeIcon";
import { LabelBadge } from "../common/LabelBadge";
import { FilterChip } from "../common/FilterChip";
import { Table, Kanban, Network } from "lucide-react";
import { ErrorMessage } from "../common/ErrorMessage";
import { GraphView } from "./GraphView";
import { ProjectDropdown } from "../common/ProjectDropdown";
import { Dropdown, DropdownItem } from "../common/Dropdown";
import { Timestamp, timestampSortingFn } from "../common/Timestamp";
import { AutocompleteInput, AutocompleteOption } from "../common/AutocompleteInput";
import { Markdown } from "../common/Markdown";
import { groupByBlockers } from "../common/groupByBlockers";
import { getLabelColorStyle } from "../utils/label-colors";
import { useClickOutside } from "../hooks/useClickOutside";
import { useColumnState } from "../hooks/useColumnState";
import { KanbanBoard } from "./KanbanBoard";

interface IssuesViewProps {
  beads: Bead[];
  loading: boolean;
  error: string | null;
  selectedBeadId: string | null;
  projects: BeadsProject[];
  activeProject: BeadsProject | null;
  tooltipHoverDelay: number; // 0 = disabled
  onSelectProject: (projectId: string) => void;
  onSelectBead: (beadId: string) => void;
  onUpdateBead: (beadId: string, updates: Partial<Bead>) => void;
  onRetry: () => void;
}

// Issue types sorted by TYPE_SORT_ORDER (epic first)
const ISSUE_TYPES = Object.keys(TYPE_SORT_ORDER).sort(
  (a, b) => getTypeSortOrder(a) - getTypeSortOrder(b)
);

// Custom sorting function for type columns (epic first)
const typeSortingFn = (rowA: { getValue: (id: string) => unknown }, rowB: { getValue: (id: string) => unknown }) => {
  const a = getTypeSortOrder(rowA.getValue("type") as string | undefined);
  const b = getTypeSortOrder(rowB.getValue("type") as string | undefined);
  return a - b;
};

// Filter presets
interface FilterPreset {
  id: string;
  label: string;
  statuses: BeadStatus[];
  /** Relationship-based filter applied after status filtering */
  relationship?: "blocked" | "blocking";
}

const FILTER_PRESETS: FilterPreset[] = [
  { id: "all", label: "All", statuses: [] },
  { id: "not-closed", label: "Not Closed", statuses: ["open", "in_progress", "blocked"] },
  { id: "active", label: "Active", statuses: ["in_progress", "blocked"] },
  { id: "blocked", label: "Blocked", statuses: [], relationship: "blocked" },
  { id: "blocking", label: "Blocking", statuses: [], relationship: "blocking" },
  { id: "closed", label: "Closed", statuses: ["closed"] },
];

const columnHelper = createColumnHelper<Bead>();

export function IssuesView({
  beads,
  loading,
  error,
  selectedBeadId,
  projects,
  activeProject,
  tooltipHoverDelay,
  onSelectProject,
  onSelectBead,
  onUpdateBead,
  onRetry,
}: IssuesViewProps): React.ReactElement {

  // Persisted column state (sorting, visibility, order)
  const defaultVisibility = {
    labels: false,
    assignee: false,
    estimate: false,
  };
  const {
    sorting,
    setSorting,
    columnVisibility,
    setColumnVisibility,
    columnOrder,
    setColumnOrder,
    kanbanSortOrder,
    setKanbanSortOrder,
    resetVisibility,
  } = useColumnState({
    defaultSorting: [{ id: "updatedAt", desc: true }],
    defaultVisibility,
  });

  // Non-persisted TanStack state
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([
    { id: "status", value: ["open", "in_progress", "blocked"] }, // Default: Not Closed
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  // UI state
  const [viewMode, setViewMode] = useState<"table" | "board" | "graph">("table");
  const [activePreset, setActivePreset] = useState<string>("not-closed");
  const [relationshipFilter, setRelationshipFilter] = useState<"blocked" | "blocking" | null>(null);
  // Increments on any filter change so GraphView can auto-fit
  const filterVersionRef = useRef(0);
  const filterVersion = useMemo(() => {
    filterVersionRef.current += 1;
    return filterVersionRef.current;
  }, [columnFilters, globalFilter, relationshipFilter]);
  const [filterBarOpen, setFilterBarOpen] = useState(true);
  const [filterMenuOpen, setFilterMenuOpen] = useState<string | null>(null);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  // Epic view state (board mode only)
  const [epicViewEnabled, setEpicViewEnabled] = useState(false);
  const [selectedEpicIds, setSelectedEpicIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const columnMenuRef = useRef<HTMLTableCellElement>(null);

  // Auto-include selected bead's status in filters and scroll into view
  useEffect(() => {
    if (!selectedBeadId) return;
    const bead = beads.find((b) => b.id === selectedBeadId);
    if (!bead) return;

    // If the bead's status is filtered out, add it to the status filter
    const statusFilter = columnFilters.find((f) => f.id === "status");
    if (statusFilter && Array.isArray(statusFilter.value)) {
      const activeStatuses = statusFilter.value as string[];
      if (!activeStatuses.includes(bead.status)) {
        setColumnFilters((prev) =>
          prev.map((f) =>
            f.id === "status" ? { ...f, value: [...activeStatuses, bead.status] } : f
          )
        );
      }
    }

    // Scroll selected row into view (delay for filter/render updates)
    const timer = setTimeout(() => {
      const el = document.querySelector(`.bead-row.selected`);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedBeadId]);

  // Tooltip state
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null);
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Get hovered bead content for tooltip
  const hoveredBead = useMemo(() => {
    if (!hoveredRowId) return null;
    return beads.find((b) => b.id === hoveredRowId);
  }, [hoveredRowId, beads]);

  const handleRowMouseEnter = useCallback((e: React.MouseEvent<HTMLTableRowElement>, beadId: string) => {
    // Skip if tooltips are disabled
    if (tooltipHoverDelay === 0) return;

    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const tooltipWidth = 300;
    const tooltipMaxHeight = 200;
    const padding = 8;

    // Position below the row, left-aligned with some offset
    let left = rect.left + 20;
    let top = rect.bottom + padding;

    // Keep tooltip within viewport horizontally
    if (left + tooltipWidth > window.innerWidth - padding) {
      left = window.innerWidth - tooltipWidth - padding;
    }

    // Check if tooltip would overflow below viewport
    const spaceBelow = window.innerHeight - rect.bottom - padding;
    const spaceAbove = rect.top - padding;

    if (spaceBelow < tooltipMaxHeight && spaceAbove > spaceBelow) {
      // Position above the row when there's more space above
      top = rect.top - tooltipMaxHeight - padding;
      // Clamp to viewport top
      if (top < padding) {
        top = padding;
      }
    }

    tooltipTimeoutRef.current = setTimeout(() => {
      setHoveredRowId(beadId);
      setTooltipPosition({ top, left });
    }, tooltipHoverDelay);
  }, [tooltipHoverDelay]);

  const handleRowMouseLeave = useCallback(() => {
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
    setHoveredRowId(null);
    setTooltipPosition(null);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
      }
    };
  }, []);

  // Click outside to close menus
  useClickOutside(filterMenuRef, () => setFilterMenuOpen(null), !!filterMenuOpen);
  useClickOutside(columnMenuRef, () => setColumnMenuOpen(false), columnMenuOpen);

  // Column definitions
  const columns = useMemo(
    () => [
      columnHelper.accessor("type", {
        id: "icon",
        header: "",
        size: 28,
        minSize: 28,
        maxSize: 28,
        enableResizing: false,
        cell: (info) =>
          info.getValue() ? (
            <TypeIcon type={info.getValue() as BeadType} size={16} />
          ) : null,
        sortingFn: typeSortingFn,
      }),
      columnHelper.accessor("type", {
        header: "Type",
        size: 70,
        minSize: 30,
        cell: (info) =>
          info.getValue() ? (
            <TypeBadge type={info.getValue() as BeadType} size="small" />
          ) : null,
        sortingFn: typeSortingFn,
        filterFn: (row, columnId, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const val = row.getValue(columnId) as string | undefined;
          return val !== undefined && filterValue.includes(val);
        },
      }),
      columnHelper.accessor("title", {
        header: "Title",
        size: 200,
        minSize: 100,
        cell: (info) => (
          <>
            <span
              className={`bead-id ${copiedId === info.row.original.id ? "copied" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                handleCopyId(info.row.original.id);
                onSelectBead(info.row.original.id);
              }}
              title={copiedId === info.row.original.id ? "Copied!" : "Click to copy"}
            >
              {info.row.original.id}
            </span>
            <SourceBadge source={info.row.original.source} />
            <span className="bead-title">{info.getValue()}</span>
          </>
        ),
      }),
      columnHelper.accessor("status", {
        header: "Status",
        size: 80,
        minSize: 30,
        cell: (info) => (
          <>
            <StatusBadge status={info.getValue()} size="small" />
            {info.row.original.isBlocked && <BlockedBadge />}
          </>
        ),
        filterFn: (row, columnId, filterValue: BeadStatus[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          return filterValue.includes(row.getValue(columnId));
        },
      }),
      columnHelper.accessor("priority", {
        header: "Priority",
        size: 70,
        minSize: 30,
        cell: (info) =>
          info.getValue() !== undefined ? (
            <PriorityBadge priority={info.getValue()!} size="small" />
          ) : null,
        filterFn: (row, columnId, filterValue: BeadPriority[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const val = row.getValue(columnId) as BeadPriority | undefined;
          return val !== undefined && filterValue.includes(val);
        },
      }),
      columnHelper.accessor("labels", {
        header: "Labels",
        size: 100,
        minSize: 30,
        enableSorting: false,
        cell: (info) => (
          <>
            {sortLabels(info.getValue()).map((label) => (
              <LabelBadge key={label} label={label} />
            ))}
          </>
        ),
        filterFn: (row, columnId, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const labels = row.getValue(columnId) as string[] | undefined;
          if (!labels || labels.length === 0) {
            // Special handling for "Unlabeled" filter
            return filterValue.includes("__unlabeled__");
          }
          // Match if any of the issue's labels are in the filter
          return labels.some((label) => filterValue.includes(label));
        },
      }),
      columnHelper.accessor("assignee", {
        header: "Assignee",
        size: 80,
        minSize: 30,
        cell: (info) => info.getValue() || "-",
        filterFn: (row, columnId, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const val = row.getValue(columnId) as string | undefined;
          // Special handling for "Unassigned" filter
          if (filterValue.includes("__unassigned__")) {
            if (!val) return true;
          }
          return val !== undefined && filterValue.includes(val);
        },
      }),
      columnHelper.accessor("estimatedMinutes", {
        id: "estimate",
        header: "Estimate",
        size: 70,
        minSize: 30,
        cell: (info) => (info.getValue() ? `${info.getValue()}m` : "-"),
      }),
      columnHelper.accessor("updatedAt", {
        header: "Updated",
        size: 80,
        minSize: 30,
        cell: (info) => <Timestamp value={info.getValue()} format="auto" />,
        sortingFn: timestampSortingFn,
      }),
      columnHelper.accessor("createdAt", {
        header: "Created",
        size: 80,
        minSize: 30,
        cell: (info) => <Timestamp value={info.getValue()} format="auto" />,
        sortingFn: timestampSortingFn,
      }),
    ],
    [copiedId]
  );

  const table = useReactTable({
    data: beads,
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility,
      columnOrder,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    globalFilterFn: (row, _columnId, filterValue: string) => {
      const search = filterValue.toLowerCase();
      const bead = row.original;
      return (
        bead.id.toLowerCase().includes(search) ||
        bead.title.toLowerCase().includes(search) ||
        (bead.description?.toLowerCase().includes(search) ?? false) ||
        (bead.labels?.some((l) => l.toLowerCase().includes(search)) ?? false)
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    columnResizeMode: "onChange" as ColumnResizeMode,
    enableColumnResizing: true,
  });

  const handleCopyId = useCallback((beadId: string) => {
    vscode.postMessage({ type: "copyBeadId", beadId });
    setCopiedId(beadId);
    setTimeout(() => setCopiedId(null), 1500);
  }, []);

  // Filter helpers
  const statusFilter = (columnFilters.find((f) => f.id === "status")?.value || []) as BeadStatus[];
  const priorityFilter = (columnFilters.find((f) => f.id === "priority")?.value || []) as BeadPriority[];
  const typeFilter = (columnFilters.find((f) => f.id === "type")?.value || []) as string[];
  const assigneeFilter = (columnFilters.find((f) => f.id === "assignee")?.value || []) as string[];
  const labelFilter = (columnFilters.find((f) => f.id === "labels")?.value || []) as string[];
  const hasActiveFilters = statusFilter.length > 0 || priorityFilter.length > 0 || typeFilter.length > 0 || assigneeFilter.length > 0 || labelFilter.length > 0 || relationshipFilter !== null;

  const applyPreset = (presetId: string) => {
    const preset = FILTER_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setColumnFilters((prev) =>
        prev
          .filter((f) => f.id !== "status")
          .concat(preset.statuses.length > 0 ? [{ id: "status", value: preset.statuses }] : [])
      );
      setRelationshipFilter(preset.relationship ?? null);
      setActivePreset(presetId);
    }
  };

  const addStatusFilter = (status: BeadStatus) => {
    if (!statusFilter.includes(status)) {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "status");
        return [...others, { id: "status", value: [...statusFilter, status] }];
      });
      setRelationshipFilter(null);
      setActivePreset("");
    }
    setFilterMenuOpen(null);
  };

  const removeStatusFilter = (status: BeadStatus) => {
    const newStatuses = statusFilter.filter((s) => s !== status);
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "status");
      return newStatuses.length > 0
        ? [...others, { id: "status", value: newStatuses }]
        : others;
    });
    setRelationshipFilter(null);
    setActivePreset("");
  };

  const addPriorityFilter = (priority: BeadPriority) => {
    if (!priorityFilter.includes(priority)) {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "priority");
        return [...others, { id: "priority", value: [...priorityFilter, priority] }];
      });
      setActivePreset("");
    }
    setFilterMenuOpen(null);
  };

  const addTypeFilter = (type: string) => {
    if (!typeFilter.includes(type)) {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "type");
        return [...others, { id: "type", value: [...typeFilter, type] }];
      });
      setActivePreset("");
    }
    setFilterMenuOpen(null);
  };

  const removePriorityFilter = (priority: BeadPriority) => {
    const newPriorities = priorityFilter.filter((p) => p !== priority);
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "priority");
      return newPriorities.length > 0
        ? [...others, { id: "priority", value: newPriorities }]
        : others;
    });
    setActivePreset("");
  };

  const removeTypeFilter = (type: string) => {
    const newTypes = typeFilter.filter((t) => t !== type);
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "type");
      return newTypes.length > 0
        ? [...others, { id: "type", value: newTypes }]
        : others;
    });
    setActivePreset("");
  };

  const addAssigneeFilter = (assignee: string) => {
    if (!assigneeFilter.includes(assignee)) {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "assignee");
        return [...others, { id: "assignee", value: [...assigneeFilter, assignee] }];
      });
      setActivePreset("");
    }
    setFilterMenuOpen(null);
  };

  const removeAssigneeFilter = (assignee: string) => {
    const newAssignees = assigneeFilter.filter((a) => a !== assignee);
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "assignee");
      return newAssignees.length > 0
        ? [...others, { id: "assignee", value: newAssignees }]
        : others;
    });
    setActivePreset("");
  };

  const addLabelFilter = (label: string) => {
    if (!labelFilter.includes(label)) {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "labels");
        return [...others, { id: "labels", value: [...labelFilter, label] }];
      });
      setActivePreset("");
    }
    setFilterMenuOpen(null);
  };

  const removeLabelFilter = (label: string) => {
    const newLabels = labelFilter.filter((l) => l !== label);
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "labels");
      return newLabels.length > 0
        ? [...others, { id: "labels", value: newLabels }]
        : others;
    });
    setActivePreset("");
  };

  const clearAllFilters = () => {
    setColumnFilters([]);
    setGlobalFilter("");
    setRelationshipFilter(null);
    setActivePreset("all");
  };

  // Get faceted counts for filters (counts based on OTHER active filters, not this column)
  const statusFacets = table.getColumn("status")?.getFacetedUniqueValues() ?? new Map();
  const priorityFacets = table.getColumn("priority")?.getFacetedUniqueValues() ?? new Map();
  const typeFacets = table.getColumn("type")?.getFacetedUniqueValues() ?? new Map();
  const assigneeFacets = table.getColumn("assignee")?.getFacetedUniqueValues() ?? new Map();

  // Unfiltered counts per status (for kanban empty state messaging)
  const unfilteredStatusCounts = useMemo(() => {
    const counts: Record<BeadStatus, number> = { open: 0, in_progress: 0, blocked: 0, closed: 0 };
    for (const bead of beads) {
      if (bead.status in counts) {
        counts[bead.status as BeadStatus]++;
      }
    }
    return counts;
  }, [beads]);

  // IDs of beads that block other beads (used by "Blocking" filter)
  const blockingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const bead of beads) {
      if (bead.blockedBy) {
        for (const id of bead.blockedBy) ids.add(id);
      }
    }
    return ids;
  }, [beads]);

  // IDs of beads that are blocked by dependencies (used by "Blocked" filter)
  const blockedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const bead of beads) {
      if (bead.isBlocked) ids.add(bead.id);
    }
    return ids;
  }, [beads]);

  // Build dependency graph from beads for graph view
  const filteredBeads = useMemo(() => {
    const rows = table.getFilteredRowModel().rows.map((r) => r.original);
    if (relationshipFilter === "blocking") {
      return rows.filter((b) => blockingIds.has(b.id));
    }
    if (relationshipFilter === "blocked") {
      return rows.filter((b) => blockedIds.has(b.id));
    }
    return rows;
  }, [table.getFilteredRowModel().rows, relationshipFilter, blockingIds, blockedIds]);

  const filteredCount = filteredBeads.length;
  const totalCount = beads.length;

  // Build dependency graph from filtered beads. For relationship filters
  // (blocked/blocking), include connected beads for context in the graph.
  const dependencyGraph = useMemo((): DependencyGraph => {
    const beadMap = new Map(beads.map((b) => [b.id, b]));
    const primaryIds = new Set(filteredBeads.map((b) => b.id));

    // For relationship filters, add connected beads so edges remain visible
    const graphIds = new Set(primaryIds);
    if (relationshipFilter) {
      for (const bead of filteredBeads) {
        if (bead.dependsOn) {
          for (const dep of bead.dependsOn) {
            if (beadMap.has(dep.id)) graphIds.add(dep.id);
          }
        }
        if (bead.blocks) {
          for (const dep of bead.blocks) {
            if (beadMap.has(dep.id)) graphIds.add(dep.id);
          }
        }
      }
    }

    const graphBeads = [...graphIds].map((id) => beadMap.get(id)!).filter(Boolean);
    const nodeIds = new Set(graphBeads.map((b) => b.id));
    const edgeSet = new Set<string>();
    const edges: DependencyGraph["edges"] = [];

    for (const bead of graphBeads) {
      if (bead.dependsOn) {
        for (const dep of bead.dependsOn) {
          if (!nodeIds.has(dep.id)) continue;
          const key = `${dep.id}->${bead.id}:${dep.dependencyType || "blocks"}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({
              from: dep.id,
              to: bead.id,
              type: (dep.dependencyType as DependencyType) || "blocks",
            });
          }
        }
      }
      if (bead.blocks) {
        for (const dep of bead.blocks) {
          if (!nodeIds.has(dep.id)) continue;
          const key = `${bead.id}->${dep.id}:${dep.dependencyType || "blocks"}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({
              from: bead.id,
              to: dep.id,
              type: (dep.dependencyType as DependencyType) || "blocks",
            });
          }
        }
      }
    }

    return { nodes: graphBeads, edges };
  }, [beads, filteredBeads, relationshipFilter]);

  // Group table rows so blocked beads appear under their blockers
  const groupedTableRows = useMemo(() => {
    let rows = table.getRowModel().rows;
    if (relationshipFilter === "blocking") {
      rows = rows.filter((r) => blockingIds.has(r.original.id));
    } else if (relationshipFilter === "blocked") {
      rows = rows.filter((r) => blockedIds.has(r.original.id));
    }
    const beadList = rows.map((r) => r.original);
    const grouped = groupByBlockers(beadList);
    // Build a lookup from bead ID to row
    const rowMap = new Map(rows.map((r) => [r.original.id, r]));
    return grouped.map((g) => ({
      row: rowMap.get(g.bead.id)!,
      indentLevel: g.indentLevel,
    }));
  }, [table.getRowModel().rows, relationshipFilter, blockingIds, blockedIds]);

  // Get unique assignees from facets for filter menu
  const uniqueAssignees = useMemo(() => {
    const assignees = Array.from(assigneeFacets.keys()).filter((a): a is string => typeof a === "string" && a !== "");
    return assignees.sort();
  }, [assigneeFacets]);

  // Count unassigned issues
  const unassignedCount = useMemo(() => {
    // Count null/undefined/empty assignees
    let count = 0;
    for (const [key, value] of assigneeFacets.entries()) {
      if (!key || key === "") {
        count += value;
      }
    }
    return count;
  }, [assigneeFacets]);

  // Get unique labels and counts from filtered rows (labels are arrays, so facets don't work directly)
  const { uniqueLabels, labelCounts, unlabeledCount } = useMemo(() => {
    const counts = new Map<string, number>();
    let unlabeled = 0;
    const filteredRows = table.getFilteredRowModel().rows;
    for (const row of filteredRows) {
      const labels = row.original.labels;
      if (!labels || labels.length === 0) {
        unlabeled++;
      } else {
        for (const label of labels) {
          counts.set(label, (counts.get(label) || 0) + 1);
        }
      }
    }
    const sorted = Array.from(counts.keys()).sort();
    return { uniqueLabels: sorted, labelCounts: counts, unlabeledCount: unlabeled };
  }, [table.getFilteredRowModel().rows]);

  // Build label autocomplete options
  const labelOptions = useMemo((): AutocompleteOption[] => {
    const options: AutocompleteOption[] = [];
    // Add "Unlabeled" option first if available
    if (!labelFilter.includes("__unlabeled__") && unlabeledCount > 0) {
      options.push({
        value: "__unlabeled__",
        label: "Unlabeled",
        count: unlabeledCount,
      });
    }
    // Add all unique labels not already filtered
    for (const label of uniqueLabels) {
      if (!labelFilter.includes(label)) {
        options.push({
          value: label,
          label: label,
          count: labelCounts.get(label) ?? 0,
          render: () => (
            <>
              <LabelBadge label={label} />
              <span className="autocomplete-option-count">({labelCounts.get(label) ?? 0})</span>
            </>
          ),
        });
      }
    }
    return options;
  }, [uniqueLabels, labelCounts, unlabeledCount, labelFilter]);

  return (
    <div className="beads-panel">
      {/* Row 1: project + search + filter toggle */}
      <div className="panel-toolbar-compact">
        <ProjectDropdown
          projects={projects}
          activeProject={activeProject}
          onSelectProject={onSelectProject}
        />
        <div className="search-input-wrapper">
          <input
            type="text"
            className="search-input-compact"
            placeholder="Search..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
          />
          {globalFilter && (
            <button
              className="search-clear-btn"
              onClick={() => setGlobalFilter("")}
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <button
          className={`filter-toggle ${filterBarOpen || hasActiveFilters ? "active" : ""}`}
          onClick={() => setFilterBarOpen(!filterBarOpen)}
          title="Filter"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6 10.5v-1h4v1H6zm-2-3v-1h8v1H4zm-2-3v-1h12v1H2z" />
          </svg>
        </button>
        <div className="view-toggle">
          <button
            className={viewMode === "table" ? "active" : ""}
            onClick={() => setViewMode("table")}
            title="Table view"
          >
            <Table size={14} />
          </button>
          <button
            className={viewMode === "board" ? "active" : ""}
            onClick={() => setViewMode("board")}
            title="Board view"
          >
            <Kanban size={14} />
          </button>
          <button
            className={viewMode === "graph" ? "active" : ""}
            onClick={() => setViewMode("graph")}
            title="Graph view"
          >
            <Network size={14} />
          </button>
        </div>
      </div>

      {/* Row 2: Filter bar */}
      {(filterBarOpen || hasActiveFilters) && (
        <div className="filter-bar">
          <Dropdown
            trigger={FILTER_PRESETS.find((p) => p.id === activePreset)?.label || "Custom"}
            className="preset-dropdown"
            triggerClassName="preset-dropdown-btn"
            menuClassName="preset-dropdown-menu"
          >
            {FILTER_PRESETS.map((preset) => (
              <DropdownItem
                key={preset.id}
                className="preset-option"
                active={activePreset === preset.id}
                onClick={() => applyPreset(preset.id)}
              >
                {preset.label}
              </DropdownItem>
            ))}
          </Dropdown>

          {/* Active filter chips */}
          {relationshipFilter && (
            <FilterChip
              key={`relationship-${relationshipFilter}`}
              label={relationshipFilter === "blocking" ? "Blocking" : "Blocked"}
              accentColor="var(--vscode-charts-red)"
              onRemove={() => { setRelationshipFilter(null); setActivePreset(""); }}
            />
          )}
          {statusFilter.map((status) => (
            <FilterChip
              key={`status-${status}`}
              label={STATUS_LABELS[status]}
              accentColor={STATUS_COLORS[status]}
              onRemove={() => removeStatusFilter(status)}
            />
          ))}
          {priorityFilter.map((priority) => (
            <FilterChip
              key={`priority-${priority}`}
              label={`p${priority}`}
              accentColor={PRIORITY_COLORS[priority]}
              onRemove={() => removePriorityFilter(priority)}
            />
          ))}
          {typeFilter.map((type) => (
            <FilterChip
              key={`type-${type}`}
              label={TYPE_LABELS[type as BeadType] || type}
              accentColor={TYPE_COLORS[type as BeadType]}
              onRemove={() => removeTypeFilter(type)}
            />
          ))}
          {assigneeFilter.map((assignee) => (
            <FilterChip
              key={`assignee-${assignee}`}
              label={assignee === "__unassigned__" ? "Unassigned" : assignee}
              accentColor="#6b7280"
              onRemove={() => removeAssigneeFilter(assignee)}
            />
          ))}
          {labelFilter.map((label) => (
            <FilterChip
              key={`label-${label}`}
              label={label === "__unlabeled__" ? "Unlabeled" : label}
              accentColor={label === "__unlabeled__" ? "#6b7280" : getLabelColorStyle(label).backgroundColor}
              onRemove={() => removeLabelFilter(label)}
            />
          ))}

          {/* Add filter dropdown with faceted counts */}
          <div className="filter-add-wrapper" ref={filterMenuRef}>
            <button
              className="filter-add-btn"
              onClick={() => setFilterMenuOpen(filterMenuOpen === "main" ? null : "main")}
            >
              + Filter
            </button>

            {filterMenuOpen === "main" && (
              <div className="filter-menu">
                <button onClick={() => setFilterMenuOpen("status")}>Status <span className="menu-chevron">›</span></button>
                <button onClick={() => setFilterMenuOpen("priority")}>Priority <span className="menu-chevron">›</span></button>
                <button onClick={() => setFilterMenuOpen("type")}>Type <span className="menu-chevron">›</span></button>
                <button onClick={() => setFilterMenuOpen("assignee")}>Assignee <span className="menu-chevron">›</span></button>
                <button onClick={() => setFilterMenuOpen("label")}>Label <span className="menu-chevron">›</span></button>
              </div>
            )}

            {filterMenuOpen === "status" && (
              <div className="filter-menu">
                {(Object.keys(STATUS_LABELS) as BeadStatus[])
                  .filter((s) => !statusFilter.includes(s))
                  .map((status) => {
                    const count = statusFacets.get(status) ?? 0;
                    return (
                      <button key={status} onClick={() => addStatusFilter(status)}>
                        <StatusBadge status={status} size="small" />
                        <span className="facet-count">({count})</span>
                      </button>
                    );
                  })}
                <button className="back-btn" onClick={() => setFilterMenuOpen("main")}>← Back</button>
              </div>
            )}

            {filterMenuOpen === "priority" && (
              <div className="filter-menu">
                {([0, 1, 2, 3, 4] as BeadPriority[])
                  .filter((p) => !priorityFilter.includes(p))
                  .map((priority) => {
                    const count = priorityFacets.get(priority) ?? 0;
                    return (
                      <button key={priority} onClick={() => addPriorityFilter(priority)}>
                        <PriorityBadge priority={priority} size="small" />
                        <span className="facet-count">({count})</span>
                      </button>
                    );
                  })}
                <button className="back-btn" onClick={() => setFilterMenuOpen("main")}>← Back</button>
              </div>
            )}

            {filterMenuOpen === "type" && (
              <div className="filter-menu">
                {ISSUE_TYPES
                  .filter((t) => !typeFilter.includes(t))
                  .map((type) => {
                    const count = typeFacets.get(type) ?? 0;
                    return (
                      <button key={type} onClick={() => addTypeFilter(type)}>
                        <TypeBadge type={type as BeadType} size="small" />
                        <span className="facet-count">({count})</span>
                      </button>
                    );
                  })}
                <button className="back-btn" onClick={() => setFilterMenuOpen("main")}>← Back</button>
              </div>
            )}

            {filterMenuOpen === "assignee" && (
              <div className="filter-menu">
                {!assigneeFilter.includes("__unassigned__") && unassignedCount > 0 && (
                  <button onClick={() => addAssigneeFilter("__unassigned__")}>
                    <span className="assignee-name">Unassigned</span>
                    <span className="facet-count">({unassignedCount})</span>
                  </button>
                )}
                {uniqueAssignees
                  .filter((a) => !assigneeFilter.includes(a))
                  .map((assignee) => {
                    const count = assigneeFacets.get(assignee) ?? 0;
                    return (
                      <button key={assignee} onClick={() => addAssigneeFilter(assignee)}>
                        <span className="assignee-name">{assignee}</span>
                        <span className="facet-count">({count})</span>
                      </button>
                    );
                  })}
                {uniqueAssignees.length === 0 && unassignedCount === 0 && (
                  <span className="filter-menu-empty">No assignees</span>
                )}
                <button className="back-btn" onClick={() => setFilterMenuOpen("main")}>← Back</button>
              </div>
            )}

            {filterMenuOpen === "label" && (
              <div className="filter-menu filter-menu-label">
                <AutocompleteInput
                  placeholder="Search labels..."
                  options={labelOptions}
                  onSelect={(value) => {
                    addLabelFilter(value);
                    setFilterMenuOpen(null);
                  }}
                  autoFocus
                  showAllOnFocus
                />
                <button className="back-btn" onClick={() => setFilterMenuOpen("main")}>← Back</button>
              </div>
            )}
          </div>

          {hasActiveFilters && (
            <button className="filter-reset" onClick={clearAllFilters}>
              Clear
            </button>
          )}

          {/* Epic toggle — board mode only */}
          {viewMode === "board" && (
            <>
              <span className="filter-bar-separator" />
              <button
                className={`kanban-epic-toggle ${epicViewEnabled ? "active" : ""}`}
                onClick={() => {
                  setEpicViewEnabled((v) => !v);
                  if (epicViewEnabled) setSelectedEpicIds(new Set());
                }}
                title={epicViewEnabled ? "Hide epic column" : "Show epic column"}
              >
                <TypeIcon type="epic" size={12} />
                <span>Epics</span>
              </button>
              {epicViewEnabled && selectedEpicIds.size > 0 && (
                <button
                  className="kanban-epic-clear"
                  onClick={() => setSelectedEpicIds(new Set())}
                  title="Clear epic selection"
                >
                  Clear
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <ErrorMessage
          message={error}
          onRetry={onRetry}
        />
      )}

      {/* Table */}
      {!error && viewMode === "table" && (
        <div className="beads-table-wrapper">
          <div className={`beads-table-container ${table.getState().columnSizingInfo.isResizingColumn ? "resizing" : ""}`}>
            <table
              className="beads-table"
              style={{ minWidth: table.getCenterTotalSize() }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        style={{ width: header.getSize() }}
                        className={`${header.column.getCanSort() ? "sortable" : ""} ${draggedColumn === header.id ? "dragging" : ""} ${dragOverColumn === header.id && draggedColumn !== header.id ? "drag-over" : ""}`}
                        onClick={header.column.getToggleSortingHandler()}
                        draggable={!isResizing}
                        onDragStart={(e) => {
                          if (isResizing) {
                            e.preventDefault();
                            return;
                          }
                          setDraggedColumn(header.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (draggedColumn && draggedColumn !== header.id) {
                            setDragOverColumn(header.id);
                          }
                        }}
                        onDragLeave={() => {
                          setDragOverColumn(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (draggedColumn && draggedColumn !== header.id) {
                            const currentOrder = table.getAllLeafColumns().map((c) => c.id);
                            const dragIdx = currentOrder.indexOf(draggedColumn);
                            const dropIdx = currentOrder.indexOf(header.id);
                            const newOrder = [...currentOrder];
                            newOrder.splice(dragIdx, 1);
                            newOrder.splice(dropIdx, 0, draggedColumn);
                            setColumnOrder(newOrder);
                          }
                          setDraggedColumn(null);
                          setDragOverColumn(null);
                        }}
                        onDragEnd={() => {
                          setDraggedColumn(null);
                          setDragOverColumn(null);
                        }}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() && (
                          <span className="sort-indicator">
                            {header.column.getIsSorted() === "asc" ? "▲" : "▼"}
                          </span>
                        )}
                        <span
                          className="resize-handle"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setIsResizing(true);
                            const resizeHandler = header.getResizeHandler();
                            resizeHandler(e);
                            // Clear resizing state on mouseup
                            const handleMouseUp = () => {
                              setIsResizing(false);
                              document.removeEventListener("mouseup", handleMouseUp);
                            };
                            document.addEventListener("mouseup", handleMouseUp);
                          }}
                          onTouchStart={(e) => {
                            e.stopPropagation();
                            setIsResizing(true);
                            const resizeHandler = header.getResizeHandler();
                            resizeHandler(e);
                            const handleTouchEnd = () => {
                              setIsResizing(false);
                              document.removeEventListener("touchend", handleTouchEnd);
                            };
                            document.addEventListener("touchend", handleTouchEnd);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </th>
                    ))}
                    <th className="col-menu-th" ref={columnMenuRef}>
                      <button
                        className="col-menu-btn"
                        onClick={() => setColumnMenuOpen(!columnMenuOpen)}
                        title="Show/hide columns"
                      >
                        ⋮
                      </button>
                      {columnMenuOpen && (
                        <div className="col-menu">
                          {table.getAllLeafColumns().map((column) => (
                            <label key={column.id}>
                              <input
                                type="checkbox"
                                checked={column.getIsVisible()}
                                onChange={column.getToggleVisibilityHandler()}
                              />
                              {typeof column.columnDef.header === "string"
                                ? column.columnDef.header
                                : column.id}
                            </label>
                          ))}
                          <hr className="col-menu-divider" />
                          <button
                            className="col-menu-reset"
                            onClick={() => {
                              resetVisibility();
                              setColumnMenuOpen(false);
                            }}
                          >
                            Reset to defaults
                          </button>
                        </div>
                      )}
                    </th>
                  </tr>
                ))}
              </thead>
              <tbody>
                {groupedTableRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={table.getVisibleLeafColumns().length + 1}
                      className="empty-row"
                    >
                      {loading ? "Loading..." : "No issues matching filter"}
                    </td>
                  </tr>
                ) : (
                  groupedTableRows.map(({ row, indentLevel }) => (
                    <tr
                      key={row.id}
                      onClick={() => onSelectBead(row.original.id)}
                      className={`bead-row ${row.original.id === selectedBeadId ? "selected" : ""} ${indentLevel > 0 ? "bead-row--nested" : ""}`}
                      onMouseEnter={(e) => handleRowMouseEnter(e, row.original.id)}
                      onMouseLeave={handleRowMouseLeave}
                    >
                      {row.getVisibleCells().map((cell, cellIdx) => (
                        <td
                          key={cell.id}
                          className={`${cell.column.id}-cell`}
                          style={{
                            width: cell.column.getSize(),
                            paddingLeft: cellIdx === 0 && indentLevel > 0 ? `${indentLevel * 20 + 8}px` : undefined,
                          }}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                      <td className="row-spacer" />
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {/* Filtered count overlay */}
          {(hasActiveFilters || globalFilter) && filteredCount !== totalCount && (
            <div className="filter-count-overlay">
              {filteredCount} of {totalCount}
            </div>
          )}
        </div>
      )}

      {/* Kanban Board */}
      {!error && viewMode === "board" && (
        <KanbanBoard
          beads={filteredBeads}
          allBeads={beads}
          selectedBeadId={selectedBeadId}
          onSelectBead={onSelectBead}
          onUpdateBead={onUpdateBead}
          hasActiveFilters={hasActiveFilters}
          unfilteredCounts={unfilteredStatusCounts}
          sortOrder={kanbanSortOrder}
          onSortOrderChange={setKanbanSortOrder}
          epicViewEnabled={epicViewEnabled}
          selectedEpicIds={selectedEpicIds}
          onSelectedEpicIdsChange={setSelectedEpicIds}
        />
      )}

      {/* Dependency Graph */}
      {!error && viewMode === "graph" && (
        <GraphView
          graph={dependencyGraph}
          filterVersion={filterVersion}
          loading={loading}
          error={null}
          highlightedBeadId={selectedBeadId}
          onSelectBead={onSelectBead}
          onAddDependency={(sourceId, targetId, dependencyType, reverse) =>
            vscode.postMessage({ type: "addDependency", beadId: sourceId, targetId, dependencyType, reverse })
          }
          onRemoveDependency={(beadId, dependsOnId) =>
            vscode.postMessage({ type: "removeDependency", beadId, dependsOnId })
          }
          onReverseDependency={(removeFrom, removeTo, addFrom, addTo, depType) =>
            vscode.postMessage({ type: "reverseDependency", removeFrom, removeTo, addFrom, addTo, depType })
          }
        />
      )}

      {/* Markdown tooltip */}
      {hoveredBead && tooltipPosition && (hoveredBead.description || hoveredBead.title) &&
        createPortal(
          <div
            className="markdown-tooltip"
            style={{
              top: tooltipPosition.top,
              left: tooltipPosition.left,
            }}
          >
            <Markdown
              content={hoveredBead.description || hoveredBead.title}
              className="markdown-tooltip-content"
            />
          </div>,
          document.body
        )}
    </div>
  );
}
