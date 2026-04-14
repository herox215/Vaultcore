// Shared graph-render helper — wraps sigma.js + graphology so callers
// (the local-graph panel today, the global graph view tomorrow — issue #32)
// don't need to reach into either library directly.
//
// The helper exposes three verbs:
//   mountGraph(container, data, options) → GraphHandle
//   updateGraph(handle, data)
//   destroyGraph(handle)
//
// It also owns the ForceAtlas2 layout pass (~50 iterations, static after).
// Node sizing, center-node accent, unresolved styling and the hover-dim
// effect are applied through sigma's node/edge reducers so they can react
// live to the current center + hovered node without rebuilding the graph.

import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { GraphEdge, GraphNode, LocalGraph } from "../../types/links";

/** Options accepted by `mountGraph` — future-proofed for the #32 global view. */
export interface GraphRenderOptions {
  /** Node id to highlight as the center/active node. Null = no accent. */
  centerId: string | null;
  /** Accent color (e.g. `var(--color-accent)` — a CSS variable is allowed). */
  accentColor: string;
  /** Neutral color for resolved non-center nodes. */
  nodeColor: string;
  /** Lighter color for unresolved pseudo-nodes. */
  unresolvedColor: string;
  /** Edge color (thin lines, low alpha). */
  edgeColor: string;
  /** Callback for single-click on a resolved node — receives the node id. */
  onNodeClick?: (id: string, node: GraphNode) => void;
  /** Callback for double-click on a resolved node. */
  onNodeDoubleClick?: (id: string, node: GraphNode) => void;
}

/** Opaque handle returned by `mountGraph`. Callers pass it to update/destroy. */
export interface GraphHandle {
  graph: Graph;
  renderer: Sigma;
  container: HTMLElement;
  options: GraphRenderOptions;
  /** Currently hovered node id — drives the dim-non-neighbors reducer. */
  hoveredNode: string | null;
  /** Map of node id → Set of adjacent node ids, cached for hover dim. */
  neighborMap: Map<string, Set<string>>;
  /** Disposers for DOM listeners attached outside sigma. */
  disposers: Array<() => void>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Node radius from `backlinkCount`, clamped to a sensible range. */
function nodeSize(node: GraphNode, isCenter: boolean): number {
  const base = Math.max(4, Math.min(12, 4 + node.backlinkCount * 1.5));
  return isCenter ? base + 2 : base;
}

/** Rebuild the adjacency cache used by the hover reducer. */
function buildNeighborMap(edges: GraphEdge[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!map.has(e.from)) map.set(e.from, new Set());
    if (!map.has(e.to)) map.set(e.to, new Set());
    map.get(e.from)!.add(e.to);
    map.get(e.to)!.add(e.from);
  }
  return map;
}

/**
 * Resolve a CSS-variable reference (e.g. `"var(--color-accent)"`) to its
 * actual value, falling back to the input string when it's already a plain
 * color. sigma's WebGL renderer wants concrete colors (`#rrggbb`, rgba()…)
 * so we can't pass `var(...)` through verbatim.
 */
function resolveColor(container: HTMLElement, color: string): string {
  const trimmed = color.trim();
  const match = /^var\((--[^,)]+)(?:,\s*([^)]+))?\)$/.exec(trimmed);
  if (!match) return trimmed;
  const [, varName, fallback] = match;
  if (!varName) return trimmed;
  const style = getComputedStyle(container);
  const value = style.getPropertyValue(varName).trim();
  if (value) return value;
  return fallback ? fallback.trim() : trimmed;
}

/**
 * Populate a `graphology` Graph from the Rust payload. Duplicate nodes / edges
 * are silently skipped so repeated calls on the same graph are idempotent.
 */
function populateGraph(graph: Graph, data: LocalGraph): void {
  graph.clear();
  for (const node of data.nodes) {
    // Random seed position — ForceAtlas2 needs non-zero coordinates to escape
    // the trivial equilibrium at the origin. The actual layout overwrites these.
    graph.addNode(node.id, {
      label: node.label,
      path: node.path,
      backlinkCount: node.backlinkCount,
      resolved: node.resolved,
      x: Math.random() - 0.5,
      y: Math.random() - 0.5,
      size: nodeSize(node, false),
    });
  }
  for (const edge of data.edges) {
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    if (graph.hasEdge(edge.from, edge.to)) continue;
    graph.addEdge(edge.from, edge.to);
  }
}

/** Run ForceAtlas2 for 50 iterations and assign final positions in place. */
function runLayout(graph: Graph): void {
  if (graph.order === 0) return;
  const settings = forceAtlas2.inferSettings(graph);
  // Speed up convergence on small graphs.
  settings.slowDown = 2;
  settings.gravity = 1;
  forceAtlas2.assign(graph, { iterations: 50, settings });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Mount a sigma-powered graph into `container` and return a handle.
 *
 * The container MUST already have non-zero width/height — sigma measures it
 * on construction to size its WebGL viewport.
 */
export function mountGraph(
  container: HTMLElement,
  data: LocalGraph,
  options: GraphRenderOptions,
): GraphHandle {
  const graph = new Graph({ type: "undirected", multi: false });
  populateGraph(graph, data);
  runLayout(graph);

  const accent = resolveColor(container, options.accentColor);
  const nodeColor = resolveColor(container, options.nodeColor);
  const unresolved = resolveColor(container, options.unresolvedColor);
  const edge = resolveColor(container, options.edgeColor);

  const neighborMap = buildNeighborMap(data.edges);

  const renderer = new Sigma(graph, container, {
    renderLabels: true,
    labelRenderedSizeThreshold: 0,
    labelSize: 11,
    labelWeight: "500",
    minEdgeThickness: 1,
    defaultEdgeColor: edge,
    defaultNodeColor: nodeColor,
  });

  const handle: GraphHandle = {
    graph,
    renderer,
    container,
    options,
    hoveredNode: null,
    neighborMap,
    disposers: [],
  };

  // Node reducer — color + size per frame. Reflects center, unresolved,
  // and hover-dim state without mutating node attributes.
  renderer.setSetting("nodeReducer", (node, attrs) => {
    const isCenter = node === handle.options.centerId;
    const resolved = attrs.resolved !== false;
    const color = !resolved ? unresolved : isCenter ? accent : nodeColor;

    const nodeData: GraphNode = {
      id: node,
      label: String(attrs.label ?? node),
      path: String(attrs.path ?? ""),
      backlinkCount: Number(attrs.backlinkCount ?? 0),
      resolved,
    };

    let dim = false;
    if (handle.hoveredNode && handle.hoveredNode !== node) {
      const neighbors = handle.neighborMap.get(handle.hoveredNode);
      if (!neighbors || !neighbors.has(node)) {
        dim = true;
      }
    }

    return {
      ...attrs,
      size: nodeSize(nodeData, isCenter),
      color,
      label: nodeData.label,
      zIndex: isCenter ? 2 : 1,
      forceLabel: true,
      ...(dim ? { color: applyAlpha(color, 0.2), labelColor: applyAlpha(color, 0.2) } : {}),
    };
  });

  // Edge reducer — hover dim for non-adjacent edges.
  renderer.setSetting("edgeReducer", (e, attrs) => {
    if (!handle.hoveredNode) {
      return { ...attrs, color: edge, size: 1 };
    }
    const [source, target] = graph.extremities(e);
    const adjacent = source === handle.hoveredNode || target === handle.hoveredNode;
    return {
      ...attrs,
      color: adjacent ? edge : applyAlpha(edge, 0.2),
      size: 1,
    };
  });

  // ── Interaction wiring ────────────────────────────────────────────────────
  const clickHandler = ({ node }: { node: string }) => {
    const attrs = graph.getNodeAttributes(node);
    if (attrs.resolved === false) return;
    handle.options.onNodeClick?.(node, {
      id: node,
      label: String(attrs.label ?? ""),
      path: String(attrs.path ?? ""),
      backlinkCount: Number(attrs.backlinkCount ?? 0),
      resolved: true,
    });
  };
  renderer.on("clickNode", clickHandler);

  const doubleClickHandler = ({ node, event }: { node: string; event: { original: Event; preventSigmaDefault: () => void } }) => {
    // Sigma's default double-click is zoom — suppress it.
    event.preventSigmaDefault();
    const attrs = graph.getNodeAttributes(node);
    if (attrs.resolved === false) return;
    handle.options.onNodeDoubleClick?.(node, {
      id: node,
      label: String(attrs.label ?? ""),
      path: String(attrs.path ?? ""),
      backlinkCount: Number(attrs.backlinkCount ?? 0),
      resolved: true,
    });
  };
  renderer.on("doubleClickNode", doubleClickHandler);

  const enter = ({ node }: { node: string }) => {
    handle.hoveredNode = node;
    renderer.refresh({ skipIndexation: true });
  };
  const leave = () => {
    handle.hoveredNode = null;
    renderer.refresh({ skipIndexation: true });
  };
  renderer.on("enterNode", enter);
  renderer.on("leaveNode", leave);

  // Scroll-wheel inside the panel zooms the graph rather than scrolling the
  // sidebar. Sigma already binds wheel events on its container, but it doesn't
  // call preventDefault by default when the mouse is outside a node. We catch
  // the raw event on the container in capture phase to be safe.
  const wheelHandler = (ev: WheelEvent) => {
    ev.preventDefault();
  };
  container.addEventListener("wheel", wheelHandler, { passive: false });
  handle.disposers.push(() =>
    container.removeEventListener("wheel", wheelHandler),
  );

  return handle;
}

/**
 * Replace the graph's nodes + edges with a fresh payload. Re-runs the layout
 * so newly added nodes snap into place.
 */
export function updateGraph(handle: GraphHandle, data: LocalGraph): void {
  populateGraph(handle.graph, data);
  runLayout(handle.graph);
  handle.neighborMap = buildNeighborMap(data.edges);
  handle.hoveredNode = null;
  handle.renderer.refresh();
}

/** Tear down the sigma renderer and remove all listeners. */
export function destroyGraph(handle: GraphHandle): void {
  for (const dispose of handle.disposers) {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  }
  handle.disposers.length = 0;
  try {
    handle.renderer.kill();
  } catch {
    /* ignore */
  }
  handle.graph.clear();
}

/**
 * Update the center-node id without rebuilding the graph. Cheaper than
 * `updateGraph` when only the highlight needs to move.
 */
export function setCenter(handle: GraphHandle, centerId: string | null): void {
  handle.options = { ...handle.options, centerId };
  handle.renderer.refresh({ skipIndexation: true });
}

// ── Color utilities ────────────────────────────────────────────────────────────

/**
 * Mix a color toward transparent by replacing its alpha channel. Accepts
 * `#rgb`, `#rrggbb`, `rgb(...)`, `rgba(...)` — anything else is returned
 * unchanged.
 */
export function applyAlpha(color: string, alpha: number): string {
  const trimmed = color.trim();

  // #rgb / #rrggbb
  if (trimmed.startsWith("#")) {
    let hex = trimmed.slice(1);
    if (hex.length === 3) {
      hex = hex.split("").map((c) => c + c).join("");
    }
    if (hex.length !== 6) return trimmed;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return trimmed;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(trimmed);
  if (rgbMatch && rgbMatch[1]) {
    const parts = rgbMatch[1].split(",").map((s) => s.trim());
    if (parts.length >= 3) {
      const [r, g, b] = parts;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  return trimmed;
}
