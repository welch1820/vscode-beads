/**
 * DetailsView
 *
 * Full view/edit of a single issue with:
 * - Inline click-to-edit fields
 * - Dependency management
 * - Metadata display
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  Bead,
  BeadStatus,
  BeadPriority,
  BeadDependency,
  DependencyType,
  BeadType,
  STATUS_LABELS,
  PRIORITY_COLORS,
  STATUS_COLORS,
  TYPE_COLORS,
  TYPE_LABELS,
  getTypeSortOrder,
  sortLabels,
} from "../types";
import { Timestamp } from "../common/Timestamp";
import { StatusPriorityPill } from "../common/StatusPriorityPill";
import { BlockedBadge } from "../common/BlockedBadge";

/**
 * Detects if a string looks like a URL
 */
function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Renders external ref - as link if URL, plain text otherwise
 */
function ExternalRefValue({ value }: { value?: string }) {
  if (!value) {
    return <span className="value muted">-</span>;
  }

  if (isUrl(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="external-link"
        title={value}
      >
        <span className="external-link-text">{value}</span>
        <Icon name="external-link" size={10} className="external-link-icon" />
      </a>
    );
  }

  return <span className="value">{value}</span>;
}

// Dependency direction: "forward" = this bead depends on target, "reverse" = target depends on this bead
type DependencyDirection = "forward" | "reverse";

// Options for adding dependencies (type + direction)
const DEPENDENCY_TYPE_OPTIONS: { value: DependencyType; direction: DependencyDirection; label: string }[] = [
  { value: "blocks", direction: "forward", label: "Blocked By" },
  { value: "blocks", direction: "reverse", label: "Blocks" },
  { value: "parent-child", direction: "forward", label: "Parent" },
  { value: "parent-child", direction: "reverse", label: "Child" },
  { value: "related", direction: "forward", label: "Related" },
  { value: "discovered-from", direction: "forward", label: "Discovered From" },
  { value: "discovered-from", direction: "reverse", label: "Spawned" },
];

// Labels for dependency sections based on array (direction) and type
const DEPENDENCY_LABELS: Record<"dependsOn" | "blocks", Record<DependencyType, string>> = {
  dependsOn: {
    "blocks": "Blocked By",
    "parent-child": "Parent",
    "discovered-from": "Discovered From",
    "related": "Related To",
  },
  blocks: {
    "blocks": "Blocks",
    "parent-child": "Children",
    "discovered-from": "Spawned",
    "related": "Related From",
  },
};

// Group dependencies by their relationship type
function groupDependenciesByType(deps: BeadDependency[]): Record<DependencyType, BeadDependency[]> {
  const groups: Record<DependencyType, BeadDependency[]> = {
    "blocks": [],
    "parent-child": [],
    "discovered-from": [],
    "related": [],
  };
  for (const dep of deps) {
    const depType = dep.dependencyType || "blocks"; // fallback to blocks if unknown
    if (groups[depType]) {
      groups[depType].push(dep);
    } else {
      // Unknown dependency type - fallback to related
      groups["related"].push(dep);
    }
  }
  return groups;
}

// Sort order for dependency status: blocked first, closed last
const STATUS_SORT_ORDER: Record<BeadStatus, number> = {
  blocked: 0,
  in_progress: 1,
  open: 2,
  closed: 3,
};

function sortDependencies(deps: BeadDependency[]): BeadDependency[] {
  return [...deps].sort((a, b) => {
    // Primary: status (blocked first, closed last)
    const aStatusOrder = a.status ? STATUS_SORT_ORDER[a.status] : 4;
    const bStatusOrder = b.status ? STATUS_SORT_ORDER[b.status] : 4;
    if (aStatusOrder !== bStatusOrder) {
      return aStatusOrder - bStatusOrder;
    }
    // Secondary: priority (P0 first, P4 last)
    const aPriority = a.priority ?? 4;
    const bPriority = b.priority ?? 4;
    return aPriority - bPriority;
  });
}
import { LabelBadge } from "../common/LabelBadge";
import { StatusBadge } from "../common/StatusBadge";
import { PriorityBadge } from "../common/PriorityBadge";
import { TypeBadge } from "../common/TypeBadge";
import { TypeIcon } from "../common/TypeIcon";
import { Icon } from "../common/Icon";
import { Markdown } from "../common/Markdown";
import { useToast } from "../common/Toast";
import { ColoredSelect, ColoredSelectOption } from "../common/ColoredSelect";
import { Dropdown, DropdownItem } from "../common/Dropdown";

// Build options for ColoredSelect dropdowns (sorted by TYPE_SORT_ORDER)
const TYPE_OPTIONS: ColoredSelectOption<BeadType>[] = (Object.keys(TYPE_LABELS) as BeadType[])
  .sort((a, b) => getTypeSortOrder(a) - getTypeSortOrder(b))
  .map((t) => ({
    value: t,
    label: TYPE_LABELS[t],
    color: TYPE_COLORS[t],
  }));

const STATUS_OPTIONS: ColoredSelectOption<BeadStatus>[] = (Object.keys(STATUS_LABELS) as BeadStatus[]).map((s) => ({
  value: s,
  label: STATUS_LABELS[s],
  color: STATUS_COLORS[s],
}));

const PRIORITY_OPTIONS: ColoredSelectOption<BeadPriority>[] = ([0, 1, 2, 3, 4] as BeadPriority[]).map((p) => ({
  value: p,
  label: `P${p}`,
  color: PRIORITY_COLORS[p],
  textColor: p === 2 ? "#1a1a1a" : "#ffffff", // dark text on yellow
}));

/**
 * Assignee dropdown with search/autocomplete.
 * Shows all known assignees when focused, filters as you type.
 */
function AssigneeDropdown({
  assignee,
  userId,
  knownAssignees,
  onAssign,
}: {
  assignee?: string;
  userId: string;
  knownAssignees: string[];
  onAssign: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on window blur
  useEffect(() => {
    const handler = () => { setOpen(false); setSearch(""); };
    window.addEventListener("blur", handler);
    return () => window.removeEventListener("blur", handler);
  }, []);

  const handleSelect = (value: string) => {
    onAssign(value);
    setOpen(false);
    setSearch("");
  };

  const query = search.toLowerCase();
  const filtered = knownAssignees
    .filter((a) => a !== assignee)
    .filter((a) => !query || a.toLowerCase().includes(query));

  const exactMatch = knownAssignees.some((a) => a.toLowerCase() === query);

  return (
    <div className="dropdown assignee-menu" ref={wrapperRef}>
      <button
        className="dropdown-trigger assignee-menu-trigger"
        onClick={() => {
          setOpen(!open);
          if (!open) {
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
      >
        <span className="assignee-trigger">
          <Icon name="user" size={10} className="person-icon" />
          <span className={`assignee-name ${!assignee ? "muted" : ""}`}>
            {assignee || "Unassigned"}
          </span>
        </span>
      </button>

      {open && (
        <div className="dropdown-menu assignee-search-menu">
          <div className="assignee-search-row">
            <input
              ref={inputRef}
              type="text"
              className="assignee-search-input"
              placeholder="Search or type a name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && search.trim()) {
                  handleSelect(search.trim());
                } else if (e.key === "Escape") {
                  setOpen(false);
                  setSearch("");
                }
              }}
            />
          </div>
          {!search && userId && assignee !== userId && (
            <button className="dropdown-item" onClick={() => handleSelect(userId)}>
              Assign to me
            </button>
          )}
          {!search && assignee && (
            <button className="dropdown-item" onClick={() => handleSelect("")}>
              Unassign
            </button>
          )}
          {!search && (userId || assignee) && filtered.length > 0 && (
            <div className="dropdown-divider" />
          )}
          <div className="assignee-results">
            {filtered.map((a) => (
              <button key={a} className="dropdown-item" onClick={() => handleSelect(a)}>
                {a}
              </button>
            ))}
          </div>
          {search.trim() && !exactMatch && (
            <>
              {filtered.length > 0 && <div className="dropdown-divider" />}
              <button className="dropdown-item assignee-custom" onClick={() => handleSelect(search.trim())}>
                Set as &ldquo;{search.trim()}&rdquo;
              </button>
            </>
          )}
          {search.trim() && filtered.length === 0 && exactMatch && null}
        </div>
      )}
    </div>
  );
}

interface DetailsViewProps {
  bead: Bead | null;
  allBeads?: Bead[];
  loading: boolean;
  renderMarkdown?: boolean;
  userId?: string;
  knownAssignees?: string[];
  onUpdateBead: (beadId: string, updates: Partial<Bead>) => void;
  onAddDependency: (beadId: string, targetId: string, dependencyType: DependencyType, reverse: boolean) => void;
  onRemoveDependency: (beadId: string, dependsOnId: string) => void;
  onAddComment?: (beadId: string, text: string) => void;
  onViewInGraph: (beadId: string) => void;
  onSelectBead?: (beadId: string) => void;
  onCopyId?: (beadId: string) => void;
  onDeleteBead?: (beadId: string) => void;
}

// Helper to render text content - markdown or plain
function TextContent({ content, renderMarkdown }: { content: string; renderMarkdown: boolean }) {
  if (renderMarkdown) {
    return <Markdown content={content} className="description-text" />;
  }
  return <p className="description-text">{content}</p>;
}

export function DetailsView({
  bead,
  allBeads = [],
  loading,
  renderMarkdown = true,
  userId = "",
  knownAssignees = [],
  onUpdateBead,
  onAddDependency,
  onRemoveDependency,
  onAddComment,
  onViewInGraph: _onViewInGraph,
  onSelectBead,
  onCopyId,
  onDeleteBead,
}: DetailsViewProps): React.ReactElement {
  // Toast and onViewInGraph kept for potential future use
  const { showToast: _showToast } = useToast();
  void _onViewInGraph;
  void _showToast;
  const [editedBead, setEditedBead] = useState<Partial<Bead>>({});
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newDepOptionIndex, setNewDepOptionIndex] = useState(0); // Index into DEPENDENCY_TYPE_OPTIONS
  const [depPickerOpen, setDepPickerOpen] = useState(false);
  const [depSearchQuery, setDepSearchQuery] = useState("");
  const depPickerRef = useRef<HTMLDivElement>(null);
  const depSearchRef = useRef<HTMLInputElement>(null);
  const [newComment, setNewComment] = useState("");

  // Ref to track pending edit for auto-save on bead switch
  const pendingEditRef = useRef<{ field: string; value: string; beadId: string } | null>(null);

  // Keep ref in sync with editing state
  useEffect(() => {
    if (editingField && bead) {
      pendingEditRef.current = { field: editingField, value: editingValue, beadId: bead.id };
    } else {
      pendingEditRef.current = null;
    }
  });

  // Auto-save pending edit and reset state when bead changes
  useEffect(() => {
    const pending = pendingEditRef.current;
    if (pending && pending.beadId && pending.beadId !== bead?.id) {
      onUpdateBead(pending.beadId, { [pending.field]: pending.value });
      pendingEditRef.current = null;
    }
    setEditingField(null);
    setEditedBead({});
  }, [bead?.id]);

  // Clear pending edits when bead data updates (e.g., after save + mutation)
  useEffect(() => {
    if (!editingField && Object.keys(editedBead).length > 0) {
      setEditedBead({});
    }
  }, [bead?.updatedAt]);

  // Inline update - saves immediately, optimistically updates local state
  const handleInlineUpdate = useCallback(
    (field: keyof Bead, value: unknown) => {
      if (bead) {
        setEditedBead((prev) => ({ ...prev, [field]: value }));
        onUpdateBead(bead.id, { [field]: value });
      }
    },
    [bead, onUpdateBead]
  );

  // Start editing a text field
  const startEditing = useCallback((field: string, value: string) => {
    setEditingField(field);
    setEditingValue(value);
  }, []);

  // Save current editing field
  const saveEditing = useCallback(() => {
    if (editingField) {
      handleInlineUpdate(editingField as keyof Bead, editingValue);
      setEditingField(null);
    }
  }, [editingField, editingValue, handleInlineUpdate]);

  // Cancel current editing field
  const cancelEditing = useCallback(() => {
    setEditingField(null);
  }, []);

  const handleAddLabel = useCallback(() => {
    if (newLabel.trim() && bead) {
      const currentLabels = editedBead.labels || bead.labels || [];
      if (!currentLabels.includes(newLabel.trim())) {
        handleInlineUpdate("labels", [...currentLabels, newLabel.trim()]);
      }
      setNewLabel("");
    }
  }, [newLabel, bead, editedBead.labels, handleInlineUpdate]);

  const handleRemoveLabel = useCallback(
    (label: string) => {
      if (bead) {
        const currentLabels = editedBead.labels || bead.labels || [];
        handleInlineUpdate(
          "labels",
          currentLabels.filter((l) => l !== label)
        );
      }
    },
    [bead, editedBead.labels, handleInlineUpdate]
  );

  const handleAddDependencyById = useCallback((targetId: string) => {
    if (targetId && bead) {
      const option = DEPENDENCY_TYPE_OPTIONS[newDepOptionIndex];
      onAddDependency(bead.id, targetId, option.value, option.direction === "reverse");
      setDepPickerOpen(false);
      setDepSearchQuery("");
    }
  }, [newDepOptionIndex, bead, onAddDependency]);

  // Close dep picker on click outside
  useEffect(() => {
    if (!depPickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (depPickerRef.current && !depPickerRef.current.contains(e.target as Node)) {
        setDepPickerOpen(false);
        setDepSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [depPickerOpen]);

  // Focus search input when picker opens
  useEffect(() => {
    if (depPickerOpen && depSearchRef.current) {
      depSearchRef.current.focus();
    }
  }, [depPickerOpen]);

  // Filter beads for the dependency picker: exclude current bead + already linked beads
  const availableBeadsForPicker = React.useMemo(() => {
    if (!bead) return [];
    const linkedIds = new Set<string>();
    linkedIds.add(bead.id);
    for (const dep of bead.dependsOn || []) linkedIds.add(dep.id);
    for (const dep of bead.blocks || []) linkedIds.add(dep.id);

    const query = depSearchQuery.toLowerCase();
    return allBeads
      .filter((b) => !linkedIds.has(b.id))
      .filter((b) => b.status !== "closed")
      .filter((b) => {
        if (!query) return true;
        return b.id.toLowerCase().includes(query) || b.title.toLowerCase().includes(query);
      })
      .slice(0, 20); // Limit results for performance
  }, [bead, allBeads, depSearchQuery]);

  if (loading && !bead) {
    return <div className="details-loading">Loading...</div>;
  }

  if (!bead) {
    return (
      <div className="details-empty">
        <p>Select a bead to view details</p>
      </div>
    );
  }

  const displayBead = { ...bead, ...editedBead };

  // Common key handler for editable textareas
  const editKeyHandler = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      cancelEditing();
    }
  };

  // Common key handler for editable single-line inputs (Enter saves)
  const editInputKeyHandler = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      saveEditing();
    } else if (e.key === "Escape") {
      cancelEditing();
    }
  };

  return (
    <div className="bead-details">
      {/* Header with icon and ID */}
      <div className="details-header">
        <TypeIcon type={(displayBead.type || "task") as BeadType} size={20} />
        <span
          className="bead-id-badge clickable"
          onClick={() => {
            if (onCopyId) {
              onCopyId(bead.id);
            } else {
              navigator.clipboard.writeText(bead.id);
            }
          }}
          title="Click to copy ID"
        >
          {bead.id}
        </span>
        <span className="header-spacer" />
        {onDeleteBead && (
          <button
            className="delete-bead-btn"
            onClick={() => onDeleteBead(bead.id)}
            title="Delete this bead"
          >
            Delete
          </button>
        )}
      </div>

      {/* Title - click to edit */}
      <div className="details-title">
        {editingField === "title" ? (
          <input
            type="text"
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            className="title-input"
            autoFocus
            onBlur={saveEditing}
            onKeyDown={editInputKeyHandler}
          />
        ) : (
          <h2
            className="editable-text"
            onClick={() => startEditing("title", displayBead.title)}
          >
            {displayBead.title}
          </h2>
        )}
      </div>

      {/* Type/Status/Priority/Assignee badges + Labels */}
      <div className="details-badges">
        <ColoredSelect
          value={(displayBead.type || "task") as BeadType}
          options={TYPE_OPTIONS}
          onChange={(v) => handleInlineUpdate("type", v)}
          renderTrigger={() => <TypeBadge type={(displayBead.type || "task") as BeadType} size="small" />}
          renderOption={(opt) => <TypeBadge type={opt.value as BeadType} size="small" />}
          showChevron={false}
        />
        <ColoredSelect
          value={displayBead.status}
          options={STATUS_OPTIONS}
          onChange={(v) => handleInlineUpdate("status", v)}
          renderTrigger={() => <StatusBadge status={displayBead.status} size="small" />}
          renderOption={(opt) => <StatusBadge status={opt.value as BeadStatus} size="small" />}
          showChevron={false}
        />
        <ColoredSelect
          value={displayBead.priority ?? 4}
          options={PRIORITY_OPTIONS}
          onChange={(v) => handleInlineUpdate("priority", v)}
          renderTrigger={() => <PriorityBadge priority={displayBead.priority ?? 4} size="small" />}
          renderOption={(opt) => <PriorityBadge priority={opt.value as BeadPriority} size="small" />}
          showChevron={false}
        />
        {displayBead.isBlocked && <BlockedBadge />}
        <AssigneeDropdown
          assignee={displayBead.assignee}
          userId={userId}
          knownAssignees={knownAssignees}
          onAssign={(value) => handleInlineUpdate("assignee", value)}
        />
        {/* Labels - always visible with add input */}
        <span className="badges-spacer" />
        <Icon name="tag" size={10} className="labels-icon" title="Labels" />
        <div className="add-label-inline">
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="+ label"
            onKeyDown={(e) => e.key === "Enter" && handleAddLabel()}
          />
        </div>
        {sortLabels(displayBead.labels).map((label) => (
          <LabelBadge
            key={label}
            label={label}
            onRemove={() => handleRemoveLabel(label)}
          />
        ))}
      </div>

      {/* Description - click to edit */}
      <div className="details-section">
        <h4>Description</h4>
        {editingField === "description" ? (
          <textarea
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            className="description-input"
            rows={4}
            autoFocus
            onBlur={saveEditing}
            onKeyDown={editKeyHandler}
          />
        ) : displayBead.description ? (
          <div className="editable-text" onClick={() => startEditing("description", displayBead.description || "")}>
            <TextContent content={displayBead.description} renderMarkdown={renderMarkdown} />
          </div>
        ) : (
          <p className="editable-placeholder" onClick={() => startEditing("description", "")}>
            Add description...
          </p>
        )}
      </div>

      {/* Bugzilla ID - display only when set */}
      {displayBead.bugzillaId && (
        <div className="details-section compact">
          <h4>Bugzilla ID</h4>
          <a
            href={displayBead.externalRef || `#`}
            target="_blank"
            rel="noopener noreferrer"
            className="external-link"
            title={`Bugzilla #${displayBead.bugzillaId}`}
          >
            <span className="external-link-text">#{displayBead.bugzillaId}</span>
            <Icon name="external-link" size={10} className="external-link-icon" />
          </a>
        </div>
      )}

      {/* External Reference - display only when set */}
      {displayBead.externalRef && (
        <div className="details-section compact">
          <h4>External Reference</h4>
          <ExternalRefValue value={displayBead.externalRef} />
        </div>
      )}

      {/* Estimate - display only when set */}
      {displayBead.estimatedMinutes && (
        <div className="details-section compact">
          <h4>Estimate (minutes)</h4>
          <span className="estimate-value">
            {Math.floor(displayBead.estimatedMinutes / 60)}h {displayBead.estimatedMinutes % 60}m
          </span>
        </div>
      )}

      {/* Design Notes - click to edit */}
      <div className="details-section">
        <h4>Design Notes</h4>
        {editingField === "design" ? (
          <textarea
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            className="description-input"
            rows={3}
            autoFocus
            onBlur={saveEditing}
            onKeyDown={editKeyHandler}
          />
        ) : displayBead.design ? (
          <div className="editable-text" onClick={() => startEditing("design", displayBead.design || "")}>
            <TextContent content={displayBead.design} renderMarkdown={renderMarkdown} />
          </div>
        ) : (
          <p className="editable-placeholder" onClick={() => startEditing("design", "")}>
            Add design notes...
          </p>
        )}
      </div>

      {/* Acceptance Criteria - click to edit */}
      <div className="details-section">
        <h4>Acceptance Criteria</h4>
        {editingField === "acceptanceCriteria" ? (
          <textarea
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            className="description-input"
            rows={3}
            autoFocus
            onBlur={saveEditing}
            onKeyDown={editKeyHandler}
          />
        ) : displayBead.acceptanceCriteria ? (
          <div className="editable-text" onClick={() => startEditing("acceptanceCriteria", displayBead.acceptanceCriteria || "")}>
            <TextContent content={displayBead.acceptanceCriteria} renderMarkdown={renderMarkdown} />
          </div>
        ) : (
          <p className="editable-placeholder" onClick={() => startEditing("acceptanceCriteria", "")}>
            Add acceptance criteria...
          </p>
        )}
      </div>

      {/* Working Notes - click to edit */}
      <div className="details-section">
        <h4>Working Notes</h4>
        {editingField === "notes" ? (
          <textarea
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            className="description-input"
            rows={3}
            autoFocus
            onBlur={saveEditing}
            onKeyDown={editKeyHandler}
          />
        ) : displayBead.notes ? (
          <div className="editable-text" onClick={() => startEditing("notes", displayBead.notes || "")}>
            <TextContent content={displayBead.notes} renderMarkdown={renderMarkdown} />
          </div>
        ) : (
          <p className="editable-placeholder" onClick={() => startEditing("notes", "")}>
            Add working notes...
          </p>
        )}
      </div>

      {/* Dependencies grouped by relationship type */}
      {(() => {
        const dependsOnGroups = groupDependenciesByType(displayBead.dependsOn || []);
        const blocksGroups = groupDependenciesByType(displayBead.blocks || []);

        // Define rendering order: hierarchy first, then workflow, then provenance, then related
        const typeOrder: DependencyType[] = ["parent-child", "blocks", "discovered-from", "related"];

        // Helper to render a dependency item
        const renderDepItem = (dep: BeadDependency, direction: "dependsOn" | "blocks") => (
          <div
            key={dep.id}
            className={`dep-item dep-type-${dep.type || "task"} ${onSelectBead ? "clickable" : ""}`}
            onClick={() => onSelectBead?.(dep.id)}
          >
            <span className="dep-id">{dep.id}</span>
            {dep.title && <span className="dep-title">{dep.title}</span>}
            <StatusPriorityPill status={dep.status} priority={dep.priority} />
            <button
              className="dep-remove"
              onClick={(e) => {
                e.stopPropagation();
                // "dependsOn": bead depends on dep → remove(bead, dep)
                // "blocks": dep depends on bead → remove(dep, bead)
                if (direction === "dependsOn") {
                  onRemoveDependency(bead.id, dep.id);
                } else {
                  onRemoveDependency(dep.id, bead.id);
                }
              }}
            >
              ×
            </button>
          </div>
        );

        return (
          <>
            {/* Render dependencies interleaved by type */}
            {typeOrder.map((depType) => {
              const dependsOnDeps = dependsOnGroups[depType];
              const blocksDeps = blocksGroups[depType];
              if (dependsOnDeps.length === 0 && blocksDeps.length === 0) return null;
              return (
                <React.Fragment key={depType}>
                  {dependsOnDeps.length > 0 && (
                    <div className="details-section">
                      <h4>{DEPENDENCY_LABELS.dependsOn[depType]}</h4>
                      <div className="deps-list">
                        {sortDependencies(dependsOnDeps).map((dep) => renderDepItem(dep, "dependsOn"))}
                      </div>
                    </div>
                  )}
                  {blocksDeps.length > 0 && (
                    <div className="details-section">
                      <h4>{DEPENDENCY_LABELS.blocks[depType]}</h4>
                      <div className="deps-list">
                        {sortDependencies(blocksDeps).map((dep) => renderDepItem(dep, "blocks"))}
                      </div>
                    </div>
                  )}
                </React.Fragment>
              );
            })}

            {/* Add dependency - always visible */}
            <div className="details-section">
              <h4>Add Dependency</h4>
              <div className="add-inline add-dependency-row">
                <Dropdown
                  trigger={
                    <span className="dep-type-trigger">
                      {DEPENDENCY_TYPE_OPTIONS[newDepOptionIndex].label}
                    </span>
                  }
                  className="dep-type-dropdown"
                  menuClassName="dep-type-menu"
                >
                  {DEPENDENCY_TYPE_OPTIONS.map((opt, idx) => (
                    <DropdownItem
                      key={`${opt.value}-${opt.direction}`}
                      onClick={() => setNewDepOptionIndex(idx)}
                      active={idx === newDepOptionIndex}
                    >
                      {opt.label}
                    </DropdownItem>
                  ))}
                </Dropdown>
                <div className="dep-picker" ref={depPickerRef}>
                  <input
                    ref={depSearchRef}
                    type="text"
                    value={depSearchQuery}
                    onChange={(e) => {
                      setDepSearchQuery(e.target.value);
                      if (!depPickerOpen) setDepPickerOpen(true);
                    }}
                    onFocus={() => setDepPickerOpen(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setDepPickerOpen(false);
                        setDepSearchQuery("");
                      }
                    }}
                    placeholder="Search beads..."
                  />
                  {depPickerOpen && (
                    <div className="dep-picker-menu">
                      {availableBeadsForPicker.length === 0 ? (
                        <div className="dep-picker-empty">No matching beads</div>
                      ) : (
                        availableBeadsForPicker.map((b) => (
                          <button
                            key={b.id}
                            className="dep-picker-item"
                            onClick={() => handleAddDependencyById(b.id)}
                          >
                            <StatusPriorityPill status={b.status} priority={b.priority} />
                            <span className="dep-picker-id">{b.id}</span>
                            <span className="dep-picker-title">{b.title}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        );
      })()}

      {/* Comments */}
      <div className="details-section">
        <h4>Comments ({(displayBead.comments || []).length})</h4>
        {(displayBead.comments || []).length > 0 && (
          <div className="comments-list">
            {(displayBead.comments || []).map((comment) => (
              <div key={comment.id} className="comment">
                <div className="comment-header">
                  <span className="comment-author">{comment.author}</span>
                  <span className="comment-date">
                    <Timestamp value={comment.createdAt} />
                  </span>
                </div>
                <div className="comment-text">
                  <TextContent content={comment.text} renderMarkdown={renderMarkdown} />
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Comment input - always shown if callback provided */}
        {onAddComment && (
          <div className="add-comment">
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Add a comment..."
              rows={2}
            />
            <button
              className="btn btn-sm"
              onClick={() => {
                if (newComment.trim() && bead) {
                  onAddComment(bead.id, newComment.trim());
                  setNewComment("");
                }
              }}
              disabled={!newComment.trim()}
            >
              Add
            </button>
          </div>
        )}
      </div>

      {/* Metadata footer */}
      <div className="details-meta">
        <span title={displayBead.createdAt ? new Date(displayBead.createdAt).toLocaleString() : undefined}>
          Created <Timestamp value={displayBead.createdAt} format="relative" />
        </span>
        <span title={displayBead.updatedAt ? new Date(displayBead.updatedAt).toLocaleString() : undefined}>
          Updated <Timestamp value={displayBead.updatedAt} format="relative" />
        </span>
        {displayBead.closedAt && (
          <span title={new Date(displayBead.closedAt).toLocaleString()}>
            Closed <Timestamp value={displayBead.closedAt} format="relative" />
          </span>
        )}
      </div>
    </div>
  );
}
