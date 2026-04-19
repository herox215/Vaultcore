// Shared graph-render helper — wraps sigma.js + graphology so callers
// (the local-graph panel today, the global graph view tomorrow — issue #32)
// don't need to reach into either library directly.
//
// The helper exposes three verbs:
//   mountGraph(container, data, options) → GraphHandle
//   updateGraph(handle, data)
//   destroyGraph(handle)
//
// Layout is driven by d3-force to match Obsidian's physics feel (stronger
// separation, less jitter, natural cooling via d3-force's own alpha decay).
// Sigma remains the renderer — only the layout engine was swapped.
// Node sizing, center-node accent, unresolved styling and the hover-dim
// effect are applied through sigma's node/edge reducers so they can react
// live to the current center + hovered node without rebuilding the graph.

import Graph from "graphology";
import Sigma from "sigma";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphNode, LocalGraph } from "../../types/links";

/**
 * User-tunable force parameters. Field names are kept from the previous
 * ForceAtlas2 shape so callers (GraphForces.svelte UI, persisted state in
 * GraphView) don't need to change. Internally each field maps to the nearest
 * d3-force concept — see `applyForceSettings` below.
 */
export interface ForceSettings {
  /** Center pull. Maps to d3-force `forceCenter` strength multiplier. */
  gravity: number;
  /** Node repulsion strength. Maps to d3-force `forceManyBody` strength
   *  (negative — stronger values push nodes further apart). */
  scalingRatio: number;
  /** How much edge existence attracts endpoints. Maps to the d3-force
   *  `forceLink` strength multiplier. */
  edgeWeightInfluence: number;
  /** Motion damping. Maps inversely to d3-force `velocityDecay` — higher
   *  values = calmer graph. */
  slowDown: number;
}

export const DEFAULT_FORCE_SETTINGS: ForceSettings = {
  gravity: 1,
  scalingRatio: 40,
  // 0.7 pulls linked nodes visibly together so clusters form, but
  // short of 1.0 where the whole graph collapses onto itself.
  edgeWeightInfluence: 0.7,
  slowDown: 10,
};

/** Node datum handed to d3-force — references the underlying graphology id
 *  so `forceLink` can resolve source/target by string. */
interface SimNode extends SimulationNodeDatum {
  id: string;
  radius: number;
}

/** Link datum handed to d3-force. `weight` carries the edge similarity
 *  (cosine in the 0..1 range) for the embedding-mode graph. Link-mode
 *  edges leave it undefined — callers fall back to the scalar strength. */
interface SimLink extends SimulationLinkDatum<SimNode> {
  weight?: number;
}

/** Options accepted by `mountGraph` — future-proofed for the #32 global view.
 *  The `| undefined` on every optional member is deliberate: svelte-check runs
 *  with `exactOptionalPropertyTypes` and would otherwise reject callers that
 *  forward `undefined` explicitly. */
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
  onNodeClick?: ((id: string, node: GraphNode) => void) | undefined;
  /** Callback for double-click on a resolved node. */
  onNodeDoubleClick?: ((id: string, node: GraphNode) => void) | undefined;
  /** Callback for double-click on empty space (used by the global graph's
   *  "fit to view" reset). */
  onStageDoubleClick?: (() => void) | undefined;
  /** Legacy knob from the FA2 era. Still accepted for API stability but
   *  d3-force's alpha decay drives cooling natively — larger values simply
   *  mean a warmer initial state. */
  layoutIterations?: number | undefined;
  /** Enable drag-to-reposition on individual nodes. Defaults to false. */
  enableNodeDrag?: boolean | undefined;
  /** Per-node dim alpha multiplier — 0..1. 0 effectively hides, 1 is fully
   *  visible. Called every nodeReducer tick; return undefined to use the
   *  default. */
  dimForNode?: ((id: string, attrs: Record<string, unknown>) => number | undefined) | undefined;
  /** Labels always shown for these node ids regardless of zoom threshold. */
  alwaysShowLabel?: ((id: string) => boolean) | undefined;
  /** Force-simulation parameters. Passing this enables the continuous live
   *  layout; when absent a single warm-up tick-set is run and the simulation
   *  is then stopped. */
  forceSettings?: ForceSettings | undefined;
  /** Start the continuous simulation paused. Toggle later via
   *  `setLayoutFrozen`. No effect when `forceSettings` is absent. */
  startFrozen?: boolean | undefined;
  /** Whether to render node labels. Defaults to true. */
  renderLabels?: boolean | undefined;
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
  /** Live d3-force simulation when continuous sim is active. */
  simulation: Simulation<SimNode, SimLink> | null;
  /** Frozen state mirror — drives pause/resume without reading the sim. */
  frozen: boolean;
  /** Cached SimNode list indexed by id — used by update/drag handlers to
   *  preserve positions and set fx/fy without rebuilding the d3-force state. */
  simNodes: Map<string, SimNode>;
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
  // Seed positions on a disc whose radius scales with node count. d3-force
  // works in raw units; starting every node inside a 1x1 square forces the
  // simulation to explode out of a degenerate cluster before anything useful
  // can form. A radius proportional to sqrt(N) matches the expected rest
  // distance of a connected graph with link.distance ~80 and keeps the
  // visual kick-off loose enough that clusters have room to resolve.
  const n = data.nodes.length;
  const spread = 40 * Math.max(4, Math.sqrt(n));
  for (const node of data.nodes) {
    const angle = Math.random() * Math.PI * 2;
    const r = spread * Math.sqrt(Math.random());
    graph.addNode(node.id, {
      label: node.label,
      path: node.path,
      backlinkCount: node.backlinkCount,
      resolved: node.resolved,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      size: nodeSize(node, false),
    });
  }
  for (const edge of data.edges) {
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    if (graph.hasEdge(edge.from, edge.to)) continue;
    const attrs: Record<string, unknown> = {};
    if (typeof edge.weight === "number" && Number.isFinite(edge.weight)) {
      attrs.weight = edge.weight;
    }
    graph.addEdge(edge.from, edge.to, attrs);
  }
}

// ── Weight-driven visual mapping ───────────────────────────────────────────────
//
// Edge weight (cosine similarity) flows through three visuals in embedding
// mode: d3-force link strength/distance for spatial clustering, and edge
// thickness/alpha for the rendered line. Link-mode edges carry no weight,
// so the helpers fall back to a neutral 1.0 multiplier and the original
// scalar strength/distance stay in effect.

/** Normalize a weight into 0..1. Inputs outside the range clamp. */
function normalizeWeight(weight: number | undefined): number | null {
  if (typeof weight !== "number" || !Number.isFinite(weight)) return null;
  if (weight <= 0) return 0;
  if (weight >= 1) return 1;
  return weight;
}

/** Edge rest length scales inversely with weight — stronger similarity pulls
 *  nodes closer. Link-mode (weight=null) keeps the historical 80-unit default. */
function edgeDistanceForWeight(weight: number | null): number {
  if (weight === null) return 80;
  return 120 - 80 * weight;
}

/** Edge pull strength multiplier. Link-mode passes through unchanged (1);
 *  embedding-mode scales with weight so weak edges barely tug. */
function edgeStrengthScaleForWeight(weight: number | null): number {
  if (weight === null) return 1;
  return 0.25 + 0.75 * weight;
}

/** Build the d3-force node/link datum arrays from the current graphology
 *  graph. When `reuse` is provided, nodes with the same id keep their
 *  existing position/velocity so incremental updates don't jump. */
function buildSimState(
  graph: Graph,
  reuse: Map<string, SimNode> | null,
): { nodes: SimNode[]; links: SimLink[]; index: Map<string, SimNode> } {
  const nodes: SimNode[] = [];
  const index = new Map<string, SimNode>();
  graph.forEachNode((id, attrs) => {
    const existing = reuse?.get(id);
    const backlinkCount = Number(attrs.backlinkCount ?? 0);
    const radius = Math.max(4, Math.min(12, 4 + backlinkCount * 1.5));
    const sim: SimNode =
      existing ?? {
        id,
        x: Number(attrs.x ?? Math.random() - 0.5),
        y: Number(attrs.y ?? Math.random() - 0.5),
        radius,
      };
    sim.radius = radius;
    nodes.push(sim);
    index.set(id, sim);
  });
  const links: SimLink[] = [];
  graph.forEachEdge((_edge, attrs, source, target) => {
    if (index.has(source) && index.has(target)) {
      const link: SimLink = { source, target };
      const w = normalizeWeight(attrs.weight as number | undefined);
      if (w !== null) link.weight = w;
      links.push(link);
    }
  });
  return { nodes, links, index };
}

/** Translate the user-facing ForceSettings knobs onto the running d3-force
 *  simulation. All strength tweaks apply immediately via the force accessors. */
function applyForceSettings(
  simulation: Simulation<SimNode, SimLink>,
  settings: ForceSettings,
): void {
  // slowDown slider (0 … 20) → velocityDecay (0.1 … 0.9) centered on d3-force's
  // native default of 0.4 at slowDown = 10. Too aggressive damping (>0.8) kills
  // motion before the simulation can spread the graph.
  const decay = Math.min(0.9, Math.max(0.1, 0.4 + 0.04 * (settings.slowDown - 10)));
  simulation.velocityDecay(decay);

  const charge = simulation.force("charge") as
    | ReturnType<typeof forceManyBody<SimNode>>
    | undefined;
  if (charge) {
    // Default scalingRatio=40 → strength -600. Enough to separate
    // unconnected nodes while links pull the connected ones into clusters.
    // Note: no distanceMax — an earlier attempt to cap repulsion range
    // killed cluster formation because the whole graph started too densely
    // packed and couldn't escape the tight initial seed.
    charge.strength(-(settings.scalingRatio * 15));
  }

  const link = simulation.force("link") as
    | ReturnType<typeof forceLink<SimNode, SimLink>>
    | undefined;
  if (link) {
    const base = Math.min(1, Math.max(0, settings.edgeWeightInfluence));
    // Per-edge strength: link-mode edges (no weight) keep the scalar `base`;
    // embedding-mode edges fold in their cosine similarity so strong pairs
    // pull hard and weak pairs barely register.
    link.strength((l) => {
      const w = normalizeWeight((l as SimLink).weight);
      return base * edgeStrengthScaleForWeight(w);
    });
    // Shorter rest length pulls linked nodes closer. Embedding-mode edges
    // shrink the rest length with weight so clusters of highly-similar
    // notes visibly collapse toward each other.
    link.distance((l) => {
      const w = normalizeWeight((l as SimLink).weight);
      return edgeDistanceForWeight(w);
    });
  }

  const center = simulation.force("center") as
    | ReturnType<typeof forceCenter<SimNode>>
    | undefined;
  if (center) {
    center.strength(Math.max(0, Math.min(1, settings.gravity * 0.1)));
  }
}

/** Push sim-node positions back onto graphology so sigma's reducers see them.
 *  Called on every simulation tick. */
function syncSimToGraph(handle: GraphHandle): void {
  const { graph, simNodes } = handle;
  for (const [id, sim] of simNodes) {
    if (!graph.hasNode(id)) continue;
    if (typeof sim.x === "number" && Number.isFinite(sim.x)) {
      graph.setNodeAttribute(id, "x", sim.x);
    }
    if (typeof sim.y === "number" && Number.isFinite(sim.y)) {
      graph.setNodeAttribute(id, "y", sim.y);
    }
  }
}

/** Create a d3-force simulation around the current graph + settings. */
function buildSimulation(
  handle: GraphHandle,
  settings: ForceSettings | undefined,
): Simulation<SimNode, SimLink> {
  const { nodes, links, index } = buildSimState(handle.graph, handle.simNodes);
  handle.simNodes = index;

  const effective = settings ?? DEFAULT_FORCE_SETTINGS;
  const simulation = forceSimulation<SimNode>(nodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((n) => n.id)
        .distance((l) => edgeDistanceForWeight(normalizeWeight((l as SimLink).weight))),
    )
    .force("charge", forceManyBody<SimNode>())
    .force("center", forceCenter<SimNode>(0, 0))
    .force(
      "collide",
      forceCollide<SimNode>((n) => n.radius + 2),
    )
    .alpha(1);

  applyForceSettings(simulation, effective);

  simulation.on("tick", () => {
    syncSimToGraph(handle);
    try {
      handle.renderer.refresh({ skipIndexation: true });
    } catch {
      /* sigma may be mid-teardown */
    }
  });
  simulation.on("end", () => {
    // Final sync on natural cool-down.
    syncSimToGraph(handle);
    try {
      handle.renderer.refresh({ skipIndexation: true });
    } catch {
      /* ignore */
    }
  });

  return simulation;
}

/** Reheat the sim so the user sees motion after drag / settings changes. */
function reheat(handle: GraphHandle): void {
  if (!handle.simulation || handle.frozen) return;
  if (handle.graph.order < 2) return;
  handle.simulation.alpha(0.3).restart();
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

  const accent = resolveColor(container, options.accentColor);
  const nodeColor = resolveColor(container, options.nodeColor);
  const unresolved = resolveColor(container, options.unresolvedColor);
  const edge = resolveColor(container, options.edgeColor);

  const neighborMap = buildNeighborMap(data.edges);

  // Label threshold: 0 = always show (local graph). Global graph raises this
  // so only higher-zoom / larger nodes show labels; hovered+neighbors are
  // force-labeled via the reducer.
  const labelThreshold = options.layoutIterations && options.layoutIterations > 50 ? 6 : 0;

  const renderer = new Sigma(graph, container, {
    renderLabels: options.renderLabels !== false,
    labelRenderedSizeThreshold: labelThreshold,
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
    simulation: null,
    frozen: options.startFrozen === true,
    simNodes: new Map(),
  };

  // Spin up the d3-force simulation — skip degenerate graphs to avoid
  // spurious NaN positions and to match the previous FA2 guard.
  if (graph.order >= 2) {
    try {
      handle.simulation = buildSimulation(handle, options.forceSettings);
      if (handle.frozen) {
        handle.simulation.stop();
      }
    } catch (err) {
      // Any construction error — leave the random-seed positions in place
      // rather than propagating a crash that tears down the panel.
      // eslint-disable-next-line no-console
      console.warn("[graphRender] d3-force setup failed:", err);
      handle.simulation = null;
    }
  }

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

    // External dim filter (text/tag/folder filters in the global graph).
    const externalAlpha = handle.options.dimForNode?.(node, attrs);

    // Hover dim: non-hovered, non-neighbor nodes get dimmed.
    let hoverDim = false;
    if (handle.hoveredNode && handle.hoveredNode !== node) {
      const neighbors = handle.neighborMap.get(handle.hoveredNode);
      if (!neighbors || !neighbors.has(node)) {
        hoverDim = true;
      }
    }

    // Always-label contract: hovered node + direct neighbors always show
    // labels regardless of the renderer threshold.
    const neighborsOfHover = handle.hoveredNode
      ? handle.neighborMap.get(handle.hoveredNode)
      : null;
    const isHoverNeighbor =
      handle.hoveredNode === node ||
      (neighborsOfHover ? neighborsOfHover.has(node) : false);
    const forceLabel =
      labelThreshold === 0 ||
      isHoverNeighbor ||
      (handle.options.alwaysShowLabel?.(node) ?? false);

    let finalColor = color;
    let finalLabelColor: string | undefined;
    if (hoverDim) {
      finalColor = applyAlpha(color, 0.2);
      finalLabelColor = applyAlpha(color, 0.2);
    }
    if (typeof externalAlpha === "number" && externalAlpha < 1) {
      finalColor = applyAlpha(finalColor, externalAlpha);
      finalLabelColor = applyAlpha(finalColor, externalAlpha);
    }

    const result: Record<string, unknown> = {
      ...attrs,
      size: nodeSize(nodeData, isCenter),
      color: finalColor,
      label: nodeData.label,
      zIndex: isCenter ? 2 : 1,
      forceLabel,
    };
    if (finalLabelColor !== undefined) {
      result.labelColor = finalLabelColor;
    }
    return result;
  });

  // Edge reducer — hover dim + weight-driven thickness/alpha.
  //
  // In embedding mode each edge carries a `weight` attr (cosine similarity
  // in 0..1). Map it to:
  //   size  : 1  → 3.5  (thicker line for stronger relations)
  //   alpha : 0.45 → 1.0 (fade weak edges into the background)
  //
  // Link-mode edges have no weight — they render with the historical
  // size=1 / full-opacity color, so the link graph is visually unchanged.
  renderer.setSetting("edgeReducer", (e, attrs) => {
    const weight = normalizeWeight(attrs.weight as number | undefined);
    const baseSize = weight === null ? 1 : 1 + weight * 2.5;
    const baseAlpha = weight === null ? 1 : 0.45 + weight * 0.55;
    const weightedEdgeColor = baseAlpha < 1 ? applyAlpha(edge, baseAlpha) : edge;

    if (!handle.hoveredNode) {
      return { ...attrs, color: weightedEdgeColor, size: baseSize };
    }
    const [source, target] = graph.extremities(e);
    const adjacent = source === handle.hoveredNode || target === handle.hoveredNode;
    return {
      ...attrs,
      color: adjacent ? weightedEdgeColor : applyAlpha(edge, 0.2),
      size: baseSize,
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

  // Stage double-click — used by the global graph to reset zoom.
  if (options.onStageDoubleClick) {
    renderer.on("doubleClickStage", ({ event }) => {
      event.preventSigmaDefault();
      handle.options.onStageDoubleClick?.();
    });
  }

  // Drag-to-reposition — sigma 3 exposes raw mouse events; capture & convert
  // viewport coords to graph coords, pin the d3-force node via fx/fy while
  // dragging, then release on mouseup so the simulation can reclaim it.
  if (options.enableNodeDrag) {
    let draggedNode: string | null = null;
    let draggingActive = false;

    renderer.on("downNode", ({ node, event }) => {
      draggedNode = node;
      draggingActive = true;
      const sim = handle.simNodes.get(node);
      if (sim) {
        sim.fx = sim.x;
        sim.fy = sim.y;
      }
      // Gentle reheat so the user's drag ripples through neighbours.
      if (handle.simulation && !handle.frozen) {
        handle.simulation.alphaTarget(0.3).restart();
      }
      renderer.getCamera().disable();
      event.preventSigmaDefault();
    });

    const mouseCaptor = renderer.getMouseCaptor();
    const onMouseMove = (ev: { x: number; y: number; preventSigmaDefault: () => void }) => {
      if (!draggingActive || !draggedNode) return;
      const coords = renderer.viewportToGraph({ x: ev.x, y: ev.y });
      graph.setNodeAttribute(draggedNode, "x", coords.x);
      graph.setNodeAttribute(draggedNode, "y", coords.y);
      const sim = handle.simNodes.get(draggedNode);
      if (sim) {
        sim.fx = coords.x;
        sim.fy = coords.y;
      }
      ev.preventSigmaDefault();
    };
    const onMouseUp = () => {
      if (draggingActive) {
        draggingActive = false;
        const sim = draggedNode ? handle.simNodes.get(draggedNode) : null;
        draggedNode = null;
        renderer.getCamera().enable();
        if (sim) {
          sim.fx = null;
          sim.fy = null;
        }
        // Release alphaTarget so the simulation cools naturally.
        if (handle.simulation && !handle.frozen) {
          handle.simulation.alphaTarget(0);
          reheat(handle);
        }
      }
    };
    mouseCaptor.on("mousemovebody", onMouseMove);
    mouseCaptor.on("mouseup", onMouseUp);
    handle.disposers.push(() => {
      mouseCaptor.removeListener("mousemovebody", onMouseMove);
      mouseCaptor.removeListener("mouseup", onMouseUp);
    });
  }

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
 * Replace the graph's nodes + edges with a fresh payload. Re-seeds the
 * d3-force simulation so newly added nodes snap in while existing ones
 * keep their current position.
 *
 * If `relayout` is false, existing node positions are preserved for any id
 * still present in the new dataset — useful for incremental refreshes in the
 * global graph so the view doesn't jump on every file-save.
 */
export function updateGraph(
  handle: GraphHandle,
  data: LocalGraph,
  opts: { relayout?: boolean; iterations?: number } = {},
): void {
  const relayout = opts.relayout ?? true;

  // Snapshot existing positions before we rebuild the graphology graph so we
  // can merge them back in after populateGraph clears everything.
  const prevPos = new Map<string, { x: number; y: number }>();
  handle.graph.forEachNode((id, attrs) => {
    prevPos.set(id, {
      x: Number(attrs.x ?? 0),
      y: Number(attrs.y ?? 0),
    });
  });

  populateGraph(handle.graph, data);

  if (!relayout) {
    // Preserve positions for nodes that already exist.
    for (const [id, pos] of prevPos) {
      if (handle.graph.hasNode(id)) {
        handle.graph.setNodeAttribute(id, "x", pos.x);
        handle.graph.setNodeAttribute(id, "y", pos.y);
      }
    }
  }

  // Prune sim nodes that no longer exist in the new graph; keep the rest so
  // positions/velocities carry over.
  const reuse = new Map<string, SimNode>();
  for (const [id, sim] of handle.simNodes) {
    if (handle.graph.hasNode(id)) reuse.set(id, sim);
  }
  if (relayout) {
    // On vault identity change, also reset seeded x/y on carried-over nodes
    // so the fresh simulation can spread them — but keep the SimNode object
    // identity so d3-force doesn't rebuild allocator state unnecessarily.
    for (const sim of reuse.values()) {
      sim.x = Math.random() - 0.5;
      sim.y = Math.random() - 0.5;
      sim.vx = 0;
      sim.vy = 0;
    }
  }
  handle.simNodes = reuse;

  handle.neighborMap = buildNeighborMap(data.edges);
  handle.hoveredNode = null;

  // Rebuild the simulation around the new node/link datums. The previous
  // simulation is stopped first so it doesn't keep ticking against stale
  // refs between the two call frames.
  if (handle.simulation) {
    handle.simulation.stop();
    handle.simulation.on("tick", null);
    handle.simulation.on("end", null);
    handle.simulation = null;
  }
  if (handle.graph.order >= 2) {
    try {
      handle.simulation = buildSimulation(handle, handle.options.forceSettings);
      if (handle.frozen) {
        handle.simulation.stop();
      } else if (!relayout) {
        // Cooler restart for incremental refreshes so the view doesn't
        // jitter for nodes whose neighborhood is unchanged.
        handle.simulation.alpha(0.3).restart();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[graphRender] d3-force update failed:", err);
      handle.simulation = null;
    }
  }

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
  if (handle.simulation) {
    try {
      handle.simulation.stop();
      handle.simulation.on("tick", null);
      handle.simulation.on("end", null);
    } catch {
      /* ignore */
    }
    handle.simulation = null;
  }
  handle.simNodes.clear();
  try {
    handle.renderer.kill();
  } catch {
    /* ignore */
  }
  handle.graph.clear();
}

/**
 * Update the live force parameters. Patches the simulation's forces in
 * place; the next tick picks up the new strengths. No-op when the handle has
 * no simulation (degenerate graph).
 */
export function setForceSettings(
  handle: GraphHandle,
  settings: ForceSettings,
): void {
  handle.options = { ...handle.options, forceSettings: settings };
  if (!handle.simulation) return;
  applyForceSettings(handle.simulation, settings);
  reheat(handle);
}

/**
 * Pause or resume the live simulation. When a node drag is in progress the
 * drag handler still pauses on mousedown and only resumes on mouseup — this
 * function mirrors the frozen state so the drag handler knows whether to
 * resume.
 */
export function setLayoutFrozen(handle: GraphHandle, frozen: boolean): void {
  handle.frozen = frozen;
  if (!handle.simulation) return;
  if (frozen) {
    handle.simulation.stop();
    return;
  }
  handle.simulation.alpha(0.3).restart();
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
