import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ELK, { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import { DependencyGraph, DependencyType, Bead, BeadType, STATUS_COLORS } from "../types";
import { Loading } from "../common/Loading";
import { PriorityBadge } from "../common/PriorityBadge";
import { TypeIcon } from "../common/TypeIcon";
import { LabelBadge } from "../common/LabelBadge";
import { Icon } from "../common/Icon";
import { BlockedBadge } from "../common/BlockedBadge";
import { SourceBadge } from "../common/SourceBadge";

// Layout constants
const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;
const PADDING = 40;

// Edge colors by dependency type
const EDGE_COLORS: Record<DependencyType, string> = {
  "blocks": "#ef4444",
  "parent-child": "#3b82f6",
  "related": "#8b5cf6",
  "discovered-from": "#6b7280",
};

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  bead: Bead;
}

interface LayoutEdge {
  id: string;
  points: { x: number; y: number }[];
  type: DependencyType;
}

type DropSide = "left" | "right";

interface GraphViewProps {
  graph: DependencyGraph | null;
  loading: boolean;
  error: string | null;
  highlightedBeadId: string | null;
  filterVersion: number;
  onSelectBead: (beadId: string) => void;
  onAddDependency?: (sourceId: string, targetId: string, dependencyType: DependencyType, reverse: boolean) => void;
  onRemoveDependency?: (beadId: string, dependsOnId: string) => void;
  onReverseDependency?: (removeFrom: string, removeTo: string, addFrom: string, addTo: string, depType: DependencyType) => void;
  onDeleteBead?: (beadId: string) => void;
}

// ELK layout hook
// Compute a stable fingerprint of graph structure (node IDs + edge connections)
function graphFingerprint(graph: DependencyGraph | null): string {
  if (!graph || graph.nodes.length === 0) return "";
  const nodeIds = graph.nodes.map((n) => n.id).sort().join(",");
  const edgeKeys = graph.edges.map((e) => `${e.from}->${e.to}:${e.type}`).sort().join(",");
  return `${nodeIds}|${edgeKeys}`;
}

function useElkLayout(graph: DependencyGraph | null) {
  const [nodes, setNodes] = useState<LayoutNode[]>([]);
  const [edges, setEdges] = useState<LayoutEdge[]>([]);
  const [graphWidth, setGraphWidth] = useState(0);
  const [graphHeight, setGraphHeight] = useState(0);
  const [layoutDone, setLayoutDone] = useState(false);
  const [layoutId, setLayoutId] = useState(0);

  // Only re-layout when graph structure actually changes, not on every object reference change
  const fingerprint = useMemo(() => graphFingerprint(graph), [graph]);
  const prevFingerprintRef = useRef("");

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setNodes([]);
      setEdges([]);
      setGraphWidth(0);
      setGraphHeight(0);
      setLayoutDone(true);
      prevFingerprintRef.current = "";
      return;
    }

    // Skip re-layout if structure hasn't changed (just a data refresh)
    if (fingerprint === prevFingerprintRef.current) {
      // Still update bead data in existing nodes without re-running ELK
      const beadMap = new Map<string, Bead>();
      for (const bead of graph.nodes) beadMap.set(bead.id, bead);
      setNodes((prev) => prev.map((n) => ({ ...n, bead: beadMap.get(n.id) || n.bead })));
      return;
    }
    prevFingerprintRef.current = fingerprint;

    setLayoutDone(false);

    const elk = new ELK();

    const beadMap = new Map<string, Bead>();
    for (const bead of graph.nodes) {
      beadMap.set(bead.id, bead);
    }

    const elkGraph: ElkNode = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.spacing.nodeNode": "30",
        "elk.layered.spacing.nodeNodeBetweenLayers": "50",
      },
      children: graph.nodes.map((bead) => ({
        id: bead.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
      edges: graph.edges.map((edge, i) => ({
        id: `e${i}`,
        sources: [edge.from],
        targets: [edge.to],
      })),
    };

    elk.layout(elkGraph).then((result) => {
      const layoutNodes: LayoutNode[] = (result.children || []).map((child) => ({
        id: child.id,
        x: child.x || 0,
        y: child.y || 0,
        width: child.width || NODE_WIDTH,
        height: child.height || NODE_HEIGHT,
        bead: beadMap.get(child.id)!,
      }));

      const layoutEdges: LayoutEdge[] = ((result.edges || []) as ElkExtendedEdge[]).map((edge, i) => {
        const points: { x: number; y: number }[] = [];
        for (const section of edge.sections || []) {
          points.push(section.startPoint);
          if (section.bendPoints) {
            points.push(...section.bendPoints);
          }
          points.push(section.endPoint);
        }
        return {
          id: edge.id,
          points,
          type: graph.edges[i]?.type || "blocks",
        };
      });

      setNodes(layoutNodes);
      setEdges(layoutEdges);
      setGraphWidth(result.width || 0);
      setGraphHeight(result.height || 0);
      setLayoutId((prev) => prev + 1);
      setLayoutDone(true);
    }).catch((err) => {
      console.error("ELK layout failed:", err);
      setLayoutDone(true);
    });
  }, [graph, fingerprint]);

  return { nodes, edges, graphWidth, graphHeight, layoutDone, layoutId };
}

// SVG Graph Node using foreignObject for rich HTML content
function GraphNode({
  node,
  highlighted,
  dropSide,
  isDragSource,
  onClick,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDeleteBead,
}: {
  node: LayoutNode;
  highlighted: boolean;
  dropSide: DropSide | null;
  isDragSource: boolean;
  onClick: () => void;
  onDragStart?: () => void;
  onDragOver?: (side: DropSide) => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
  onDeleteBead?: (beadId: string) => void;
}) {
  const statusColor = STATUS_COLORS[node.bead.status] || "#6b7280";
  const idText = node.bead.id;

  // Determine stroke for drop target feedback
  let stroke = highlighted ? "#fbbf24" : "var(--vscode-panel-border, #3c3c3c)";
  let strokeWidth = highlighted ? 2 : 1;
  if (dropSide) {
    stroke = dropSide === "left" ? "#ef4444" : "#3b82f6"; // red = blocks, blue = depends on
    strokeWidth = 2.5;
  }

  return (
    <g
      className={`graph-node${highlighted ? " graph-node--highlighted" : ""}${isDragSource ? " graph-node--dragging" : ""}`}
      transform={`translate(${node.x}, ${node.y})`}
      onClick={onClick}
      style={{ cursor: onDragStart ? "grab" : "pointer", opacity: isDragSource ? 0.4 : 1 }}
    >
      <rect
        width={node.width}
        height={node.height}
        rx={4}
        ry={4}
        fill="var(--vscode-editor-background, #1e1e1e)"
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      {/* Left/right drop zone indicators with labels */}
      {dropSide === "left" && (
        <>
          <rect x={0} y={0} width={node.width / 2} height={node.height} rx={4} fill="rgba(239,68,68,0.15)" />
          <text x={node.width / 4} y={node.height - 4} textAnchor="middle" fill="#ef4444" fontSize={9} fontWeight="bold" pointerEvents="none">blocked by</text>
        </>
      )}
      {dropSide === "right" && (
        <>
          <rect x={node.width / 2} y={0} width={node.width / 2} height={node.height} rx={4} fill="rgba(59,130,246,0.15)" />
          <text x={node.width * 3 / 4} y={node.height - 4} textAnchor="middle" fill="#3b82f6" fontSize={9} fontWeight="bold" pointerEvents="none">blocks</text>
        </>
      )}
      {/* Status color bar */}
      <rect
        x={0}
        y={0}
        width={4}
        height={node.height}
        rx={2}
        fill={statusColor}
      />
      {/* Invisible drag/drop interaction overlay */}
      <rect
        width={node.width}
        height={node.height}
        fill="transparent"
        onMouseDown={(e) => {
          if (onDragStart && e.button === 0) {
            e.stopPropagation();
            onDragStart();
          }
        }}
        onMouseMove={(e) => {
          if (onDragOver) {
            const rect = (e.target as SVGRectElement).getBoundingClientRect();
            const relX = e.clientX - rect.left;
            const side: DropSide = relX < rect.width / 2 ? "left" : "right";
            onDragOver(side);
          }
        }}
        onMouseLeave={() => onDragLeave?.()}
        onMouseUp={() => onDrop?.()}
      />
      <foreignObject x={8} y={4} width={node.width - 12} height={node.height - 8} style={{ pointerEvents: highlighted ? "auto" : "none" }}>
        <div className="graph-node-content">
          <div className="kanban-card-header">
            <TypeIcon type={(node.bead.type || "task") as BeadType} size={12} />
            <span className="kanban-card-id">{idText}</span>
            <SourceBadge source={node.bead.source} />
            {onDeleteBead && highlighted && (
              <button
                className="kanban-card-delete"
                title="Delete bead"
                style={{ opacity: 0.8, pointerEvents: "auto" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteBead(node.bead.id);
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            )}
          </div>
          <div className="graph-node-title">{node.bead.title}</div>
          <div className="kanban-card-meta">
            {node.bead.priority !== undefined && <PriorityBadge priority={node.bead.priority} size="small" />}
            {node.bead.isBlocked && <BlockedBadge />}
            {node.bead.assignee && (
              <>
                <Icon name="user" size={10} className="kanban-card-icon" />
                <span className="kanban-card-assignee">{node.bead.assignee}</span>
              </>
            )}
            {node.bead.labels && node.bead.labels.length > 0 && (
              <>
                <span className="kanban-card-spacer" />
                <Icon name="tag" size={10} className="kanban-card-icon" />
                {node.bead.labels.slice(0, 2).map((label) => (
                  <LabelBadge key={label} label={label} />
                ))}
                {node.bead.labels.length > 2 && (
                  <span className="kanban-card-labels-more">+{node.bead.labels.length - 2}</span>
                )}
              </>
            )}
          </div>
        </div>
      </foreignObject>
    </g>
  );
}

// SVG Graph Edge
function GraphEdge({ edge }: { edge: LayoutEdge }) {
  if (edge.points.length < 2) return null;
  const color = EDGE_COLORS[edge.type] || EDGE_COLORS.blocks;
  const d = edge.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <path
      className="graph-edge"
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      markerEnd={`url(#arrow-${edge.type})`}
    />
  );
}

export function GraphView({ graph, loading, error, highlightedBeadId, filterVersion, onSelectBead, onAddDependency, onReverseDependency, onDeleteBead }: GraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { nodes, edges, graphWidth, graphHeight, layoutDone, layoutId } = useElkLayout(graph);

  // ViewBox state for zoom/pan
  const viewBoxRef = useRef({ x: 0, y: 0, w: 800, h: 600 });
  const [viewBox, setViewBox] = useState(viewBoxRef.current);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, vbx: 0, vby: 0 });
  // Once the user pans or zooms, stop all automatic viewBox changes
  const userHasInteracted = useRef(false);

  // Drag-to-create dependency state
  const [dragSource, setDragSource] = useState<string | null>(null);
  const [dragMouse, setDragMouse] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: DropSide } | null>(null);

  // Wrapper that keeps the ref in sync with state
  const updateViewBox = useCallback((updater: (prev: typeof viewBoxRef.current) => typeof viewBoxRef.current) => {
    setViewBox((prev) => {
      const next = updater(prev);
      viewBoxRef.current = next;
      return next;
    });
  }, []);

  // Auto-fit viewbox when filters change or layout completes with new structure
  // Track both filterVersion and layoutId to handle the race where filter changes
  // trigger an ELK re-layout — the fit must wait for ELK to finish with new dimensions.
  const fittedRef = useRef({ filterVersion: -1, layoutId: -1 });
  useEffect(() => {
    if (!layoutDone || nodes.length === 0) return;
    if (fittedRef.current.filterVersion === filterVersion && fittedRef.current.layoutId === layoutId) return;
    fittedRef.current = { filterVersion, layoutId };
    userHasInteracted.current = false;
    const w = graphWidth + PADDING * 2;
    const h = graphHeight + PADDING * 2;
    updateViewBox(() => ({ x: -PADDING, y: -PADDING, w, h }));
  }, [layoutDone, filterVersion, layoutId, graphWidth, graphHeight, nodes.length, updateViewBox]);

  // Center on highlighted bead only when the highlighted ID changes and user hasn't panned
  const prevHighlightedId = useRef<string | null>(null);
  useEffect(() => {
    if (prevHighlightedId.current === highlightedBeadId) return;
    prevHighlightedId.current = highlightedBeadId;
    if (userHasInteracted.current) return;
    if (!highlightedBeadId || nodes.length === 0) return;
    const node = nodes.find((n) => n.id === highlightedBeadId);
    if (!node) return;
    updateViewBox((prev) => ({
      ...prev,
      x: node.x + node.width / 2 - prev.w / 2,
      y: node.y + node.height / 2 - prev.h / 2,
    }));
  }, [highlightedBeadId, nodes, updateViewBox]);

  // Zoom via mouse wheel
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;

    userHasInteracted.current = true;
    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;

    updateViewBox((prev) => {
      const newW = prev.w * zoomFactor;
      const newH = prev.h * zoomFactor;
      return { x: prev.x + (prev.w - newW) * mx, y: prev.y + (prev.h - newH) * my, w: newW, h: newH };
    });
  }, [updateViewBox]);

  // Pan via mouse drag — use refs to avoid stale closures
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as SVGElement;
    if (target.closest(".graph-node")) return;

    userHasInteracted.current = true;
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, vbx: viewBoxRef.current.x, vby: viewBoxRef.current.y };
  }, []);

  // Convert screen coordinates to SVG viewBox coordinates using the CTM
  // This correctly handles preserveAspectRatio letterboxing
  const screenToSvg = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const svgPoint = point.matrixTransform(ctm.inverse());
    return { x: svgPoint.x, y: svgPoint.y };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Update drag line position (SVG coordinates)
    if (dragSource) {
      const pt = screenToSvg(e.clientX, e.clientY);
      if (pt) setDragMouse(pt);
      return; // Don't pan while dragging
    }

    if (!isPanning) return;
    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const dx = ((e.clientX - panStart.current.x) / rect.width) * viewBoxRef.current.w;
    const dy = ((e.clientY - panStart.current.y) / rect.height) * viewBoxRef.current.h;

    updateViewBox(() => ({
      ...viewBoxRef.current,
      x: panStart.current.vbx - dx,
      y: panStart.current.vby - dy,
    }));
  }, [isPanning, dragSource, screenToSvg, updateViewBox]);

  const handleMouseUp = useCallback(() => {
    if (dragSource && dropTarget && onAddDependency && graph) {
      const src = dragSource;
      const tgt = dropTarget.id;

      // Desired dependency: left side = src blocks tgt (tgt depends on src)
      //                     right side = tgt blocks src (src depends on tgt)
      const desiredFrom = dropTarget.side === "left" ? tgt : src;
      const desiredTo = dropTarget.side === "left" ? src : tgt;

      // Check existing edges between these two nodes
      // Graph edges: from=blocker, to=blocked. CLI: from=dependent, to=blocker.
      // So CLI(desiredFrom, desiredTo) = graph edge(from=desiredTo, to=desiredFrom)
      const existingForward = graph.edges.find((e) => e.from === desiredTo && e.to === desiredFrom);
      const existingReverse = graph.edges.find((e) => e.from === desiredFrom && e.to === desiredTo);

      if (existingForward) {
        // Already exists in desired direction — no-op
      } else if (existingReverse && onReverseDependency) {
        // Reverse exists — atomically remove old + add new on extension side
        // Graph edge: from=blocker, to=blocked. CLI removeDep: from=dependent, to=blocker
        onReverseDependency(existingReverse.to, existingReverse.from, desiredFrom, desiredTo, "blocks");
      } else {
        // No existing edge — just add
        onAddDependency(desiredFrom, desiredTo, "blocks", false);
      }
    }
    setDragSource(null);
    setDragMouse(null);
    setDropTarget(null);
    setIsPanning(false);
  }, [dragSource, dropTarget, onAddDependency, onReverseDependency, graph]);

  // Arrow markers - memoized
  const arrowMarkers = useMemo(() => (
    Object.entries(EDGE_COLORS).map(([type, color]) => (
      <marker
        key={type}
        id={`arrow-${type}`}
        viewBox="0 0 10 10"
        refX={10}
        refY={5}
        markerWidth={8}
        markerHeight={8}
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
      </marker>
    ))
  ), []);

  if (loading && !graph) {
    return <Loading />;
  }

  if (error) {
    return (
      <div className="empty-state compact">
        <p>Error loading graph: {error}</p>
      </div>
    );
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="empty-state compact">
        <p>No beads to display</p>
      </div>
    );
  }

  if (!layoutDone) {
    return <Loading />;
  }

  return (
    <div className="graph-view" ref={containerRef}>
      <svg
        ref={svgRef}
        className="graph-svg"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isPanning ? "grabbing" : "grab" }}
      >
        <defs>{arrowMarkers}</defs>
        {/* Render edges behind nodes */}
        {edges.map((edge) => (
          <GraphEdge key={edge.id} edge={edge} />
        ))}
        {/* Render nodes on top */}
        {nodes.map((node) => (
          <GraphNode
            key={node.id}
            node={node}
            highlighted={node.id === highlightedBeadId}
            dropSide={dropTarget?.id === node.id ? dropTarget.side : null}
            isDragSource={dragSource === node.id}
            onClick={() => { if (!dragSource) onSelectBead(node.id); }}
            onDragStart={onAddDependency ? () => setDragSource(node.id) : undefined}
            onDragOver={dragSource && dragSource !== node.id ? (side) => setDropTarget({ id: node.id, side }) : undefined}
            onDragLeave={dragSource ? () => setDropTarget((prev) => prev?.id === node.id ? null : prev) : undefined}
            onDrop={dragSource && dragSource !== node.id ? () => {} : undefined}
            onDeleteBead={onDeleteBead}
          />
        ))}
        {/* Drag line from source node to cursor */}
        {dragSource && dragMouse && (() => {
          const sourceNode = nodes.find((n) => n.id === dragSource);
          if (!sourceNode) return null;
          const sx = sourceNode.x + sourceNode.width / 2;
          const sy = sourceNode.y + sourceNode.height / 2;
          return (
            <line
              x1={sx} y1={sy}
              x2={dragMouse.x} y2={dragMouse.y}
              stroke="#fbbf24"
              strokeWidth={2}
              strokeDasharray="6 3"
              pointerEvents="none"
            />
          );
        })()}
      </svg>
    </div>
  );
}
