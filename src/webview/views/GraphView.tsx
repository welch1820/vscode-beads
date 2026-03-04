import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ELK, { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import { DependencyGraph, DependencyType, Bead, BeadType, STATUS_COLORS } from "../types";
import { Loading } from "../common/Loading";
import { PriorityBadge } from "../common/PriorityBadge";
import { TypeIcon } from "../common/TypeIcon";
import { LabelBadge } from "../common/LabelBadge";

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

interface GraphViewProps {
  graph: DependencyGraph | null;
  loading: boolean;
  error: string | null;
  highlightedBeadId: string | null;
  onSelectBead: (beadId: string) => void;
}

// ELK layout hook
function useElkLayout(graph: DependencyGraph | null) {
  const [nodes, setNodes] = useState<LayoutNode[]>([]);
  const [edges, setEdges] = useState<LayoutEdge[]>([]);
  const [graphWidth, setGraphWidth] = useState(0);
  const [graphHeight, setGraphHeight] = useState(0);
  const [layoutDone, setLayoutDone] = useState(false);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setNodes([]);
      setEdges([]);
      setGraphWidth(0);
      setGraphHeight(0);
      setLayoutDone(true);
      return;
    }

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
      setLayoutDone(true);
    }).catch((err) => {
      console.error("ELK layout failed:", err);
      setLayoutDone(true);
    });
  }, [graph]);

  return { nodes, edges, graphWidth, graphHeight, layoutDone };
}

// SVG Graph Node using foreignObject for rich HTML content
function GraphNode({
  node,
  highlighted,
  onClick,
}: {
  node: LayoutNode;
  highlighted: boolean;
  onClick: () => void;
}) {
  const statusColor = STATUS_COLORS[node.bead.status] || "#6b7280";
  const idText = node.bead.id;
  const title = node.bead.title.length > 28
    ? node.bead.title.slice(0, 26) + "\u2026"
    : node.bead.title;

  return (
    <g
      className={`graph-node${highlighted ? " graph-node--highlighted" : ""}`}
      transform={`translate(${node.x}, ${node.y})`}
      onClick={onClick}
      style={{ cursor: "pointer" }}
    >
      <rect
        width={node.width}
        height={node.height}
        rx={4}
        ry={4}
        fill="var(--vscode-editor-background, #1e1e1e)"
        stroke={highlighted ? "#fbbf24" : "var(--vscode-panel-border, #3c3c3c)"}
        strokeWidth={highlighted ? 2 : 1}
      />
      {/* Status color bar */}
      <rect
        x={0}
        y={0}
        width={4}
        height={node.height}
        rx={2}
        fill={statusColor}
      />
      <foreignObject x={8} y={4} width={node.width - 12} height={node.height - 8}>
        <div className="graph-node-content" style={{ fontSize: 11 }}>
          <div className="graph-node-header">
            <TypeIcon type={(node.bead.type || "task") as BeadType} size={11} />
            <span className="graph-node-id">{idText}</span>
            {node.bead.priority !== undefined && (
              <PriorityBadge priority={node.bead.priority} size="small" />
            )}
          </div>
          <div className="graph-node-title">{title}</div>
          <div className="graph-node-meta">
            {node.bead.assignee && (
              <span className="graph-node-assignee">{node.bead.assignee}</span>
            )}
            {node.bead.labels && node.bead.labels.length > 0 && (
              <span className="graph-node-labels">
                {node.bead.labels.slice(0, 2).map((label) => (
                  <LabelBadge key={label} label={label} />
                ))}
                {node.bead.labels.length > 2 && (
                  <span className="graph-node-labels-more">+{node.bead.labels.length - 2}</span>
                )}
              </span>
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

export function GraphView({ graph, loading, error, highlightedBeadId, onSelectBead }: GraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { nodes, edges, graphWidth, graphHeight, layoutDone } = useElkLayout(graph);

  // ViewBox state for zoom/pan
  const viewBoxRef = useRef({ x: 0, y: 0, w: 800, h: 600 });
  const [viewBox, setViewBox] = useState(viewBoxRef.current);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, vbx: 0, vby: 0 });
  // Once the user pans or zooms, stop all automatic viewBox changes
  const userHasInteracted = useRef(false);

  // Wrapper that keeps the ref in sync with state
  const updateViewBox = useCallback((updater: (prev: typeof viewBoxRef.current) => typeof viewBoxRef.current) => {
    setViewBox((prev) => {
      const next = updater(prev);
      viewBoxRef.current = next;
      return next;
    });
  }, []);

  // Auto-fit viewbox on first layout, and when graph identity changes
  const graphNodeIds = useMemo(() => graph?.nodes.map((n) => n.id).sort().join(",") ?? "", [graph]);
  const prevGraphNodeIds = useRef("");
  useEffect(() => {
    if (!layoutDone || nodes.length === 0) return;
    // Only auto-fit on first layout or when graph identity changes
    const graphChanged = prevGraphNodeIds.current !== graphNodeIds;
    if (prevGraphNodeIds.current !== "" && !graphChanged) return;
    prevGraphNodeIds.current = graphNodeIds;
    if (userHasInteracted.current && !graphChanged) return;
    if (graphChanged) userHasInteracted.current = false;
    const w = graphWidth + PADDING * 2;
    const h = graphHeight + PADDING * 2;
    updateViewBox(() => ({ x: -PADDING, y: -PADDING, w, h }));
  }, [layoutDone, graphWidth, graphHeight, graphNodeIds, nodes.length, updateViewBox]);

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

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
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
  }, [isPanning, updateViewBox]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

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
            onClick={() => onSelectBead(node.id)}
          />
        ))}
      </svg>
    </div>
  );
}
