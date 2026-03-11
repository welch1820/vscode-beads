import { useState, useEffect, useMemo } from "react";
import { SortingState, VisibilityState, ColumnOrderState } from "@tanstack/react-table";
import { transport } from "../transport";

/**
 * Persisted column state for TanStack Table.
 */
export interface ColumnState {
  sorting: SortingState;
  columnVisibility: VisibilityState;
  columnOrder: ColumnOrderState;
}

interface PersistedState {
  sorting?: SortingState;
  columnVisibility?: VisibilityState;
  columnOrder?: ColumnOrderState;
  kanbanSortOrder?: Record<string, number>;
}

interface UseColumnStateOptions {
  /** Default sorting if none persisted */
  defaultSorting?: SortingState;
  /** Default column visibility if none persisted */
  defaultVisibility?: VisibilityState;
  /** Default column order if none persisted */
  defaultOrder?: ColumnOrderState;
}

interface UseColumnStateReturn {
  sorting: SortingState;
  setSorting: React.Dispatch<React.SetStateAction<SortingState>>;
  columnVisibility: VisibilityState;
  setColumnVisibility: React.Dispatch<React.SetStateAction<VisibilityState>>;
  columnOrder: ColumnOrderState;
  setColumnOrder: React.Dispatch<React.SetStateAction<ColumnOrderState>>;
  kanbanSortOrder: Record<string, number>;
  setKanbanSortOrder: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  /** Reset visibility to defaults */
  resetVisibility: () => void;
}

/**
 * Hook to manage TanStack Table column state with VS Code webview persistence.
 *
 * - Loads saved state from transport.getState() on mount
 * - Merges with defaults for new columns
 * - Saves to transport.setState() on changes
 *
 * @example
 * const {
 *   sorting, setSorting,
 *   columnVisibility, setColumnVisibility,
 *   columnOrder, setColumnOrder,
 *   resetVisibility,
 * } = useColumnState({
 *   defaultSorting: [{ id: "updatedAt", desc: true }],
 *   defaultVisibility: { labels: false, assignee: false },
 * });
 */
export function useColumnState(options: UseColumnStateOptions = {}): UseColumnStateReturn {
  const {
    defaultSorting = [],
    defaultVisibility = {},
    defaultOrder = [],
  } = options;

  // Load persisted state once on mount
  const savedState = useMemo(() => transport.getState() as PersistedState | undefined, []);

  const [sorting, setSorting] = useState<SortingState>(
    savedState?.sorting ?? defaultSorting
  );

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    savedState?.columnVisibility ?? defaultVisibility
  );

  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(
    savedState?.columnOrder ?? defaultOrder
  );

  const [kanbanSortOrder, setKanbanSortOrder] = useState<Record<string, number>>(
    savedState?.kanbanSortOrder ?? {}
  );

  // Persist state changes to VS Code
  useEffect(() => {
    transport.setState({ sorting, columnVisibility, columnOrder, kanbanSortOrder });
  }, [sorting, columnVisibility, columnOrder, kanbanSortOrder]);

  const resetVisibility = () => {
    setColumnVisibility(defaultVisibility);
  };

  return {
    sorting,
    setSorting,
    columnVisibility,
    setColumnVisibility,
    columnOrder,
    setColumnOrder,
    kanbanSortOrder,
    setKanbanSortOrder,
    resetVisibility,
  };
}
