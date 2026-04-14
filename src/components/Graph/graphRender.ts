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
import FA2LayoutSupervisor from "graphology-layout-forceatlas2/worker";
import type { GraphEdge, GraphNode, LocalGraph } from "../../types/links";

/**
 * User-tunable force parameters. Mapped onto the subset of ForceAtlas2
 * settings that actually shape the "organic" feel — gravity, repulsion,
 * edge-weight influence, and the motion damping (`slowDown`). Defaults are
 * tuned for an Obsidian-like drift rather than FA2's aggressive convergence.
 */
export interface ForceSettings {
  /** Center pull. 0 = graph drifts apart, 5 = strong clump. */
  gravity: number;
  /** Node repulsion strength. Higher = nodes push apart more. */
  scalingRatio: number;
  /** How much edge weight / existence attracts endpoints. */
  edgeWeightInfluence: number;
  /** Motion damping. Higher = slower, calmer movement. */
  slowDown: number;
}

export const DEFAULT_FORCE_SETTINGS: ForceSettings = {
  gravity: 1,
  scalingRatio: 10,
  edgeWeightInfluence: 1,
  slowDown: 5,
};

/** Interface shape of the running FA2 supervisor we care about. */
interface FA2Supervisor {
  start(): unknown;
  stop(): unknown;
  kill(): unknown;
  isRunning(): boolean;
  settings: Record<string, unknown>;
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
  /** Number of ForceAtlas2 iterations. Local graph uses the default 50
   *  for snappy redraws; global graph passes ~300 for a 2 s warm-up. */
  layoutIterations?: number | undefined;
  /** Enable drag-to-reposition on individual nodes. Defaults to false. */
  enableNodeDrag?: boolean | undefined;
  /** Per-node dim alpha multiplier — 0..1. 0 effectively hides, 1 is fully
   *  visible. Called every nodeReducer tick; return undefined to use the
   *  default. */
  dimForNode?: ((id: string, attrs: Record<string, unknown>) => number | undefined) | undefined;
  /** Labels always shown for these node ids regardless of zoom threshold. */
  alwaysShowLabel?: ((id: string) => boolean) | undefined;
  /** Force-simulation parameters. Passing this enables continuous (live)
   *  layout via the ForceAtlas2 worker — the default batch `layoutIterations`
   *  path is used when this field is absent. */
  forceSettings?: ForceSettings | undefined;
  /** Start the continuous simulation paused. Toggle later via
   *  `setLayoutFrozen`. No effect when `forceSettings` is absent. */
  startFrozen?: boolean | undefined;
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
  /** Live ForceAtlas2 supervisor when continuous sim is active. */
  layoutSupervisor: FA2Supervisor | null;
  /** Frozen state mirror — drives pause/resume without reading the supervisor. */
  frozen: boolean;
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

/** Run ForceAtlas2 and assign final positions in place. */
function runLayout(graph: Graph, iterations = 50): void {
  if (graph.order === 0) return;
  const settings = forceAtlas2.inferSettings(graph);
  // Speed up convergence on small graphs.
  settings.slowDown = 2;
  settings.gravity = 1;
  forceAtlas2.assign(graph, { iterations, settings });
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
  // Short seed pass so nodes spread out before the live supervisor (or the
  // final rendered frame) takes over. Without this FA2 starts from near-zero
  // positions and the first few frames look like a single cluster.
  runLayout(graph, options.forceSettings ? 30 : (options.layoutIterations ?? 50));

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
    renderLabels: true,
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
    layoutSupervisor: null,
    frozen: options.startFrozen === true,
  };

  // Live ForceAtlas2 supervisor — organic, Obsidian-style drift. Sigma
  // listens to node-attr changes emitted by the worker and redraws each
  // time, so we don't need an explicit requestAnimationFrame loop here.
  if (options.forceSettings) {
    try {
      const supervisor = new (FA2LayoutSupervisor as unknown as {
        new (g: Graph, p: { settings: Record<string, unknown> }): FA2Supervisor;
      })(graph, {
        settings: {
          ...forceAtlas2.inferSettings(graph),
          ...options.forceSettings,
          barnesHutOptimize: graph.order > 200,
          adjustSizes: true,
        },
      });
      handle.layoutSupervisor = supervisor;
      if (!handle.frozen) supervisor.start();
    } catch (err) {
      // Worker spawn can fail in CSP-restricted or jsdom environments.
      // Fall back to the existing static layout and log so we notice.
      // eslint-disable-next-line no-console
      console.warn("[graphRender] live layout unavailable, static fallback:", err);
      handle.layoutSupervisor = null;
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

  // Stage double-click — used by the global graph to reset zoom.
  if (options.onStageDoubleClick) {
    renderer.on("doubleClickStage", ({ event }) => {
      event.preventSigmaDefault();
      handle.options.onStageDoubleClick?.();
    });
  }

  // Drag-to-reposition — sigma 3 exposes raw mouse events; capture & convert
  // viewport coords to graph coords and write back to the node attributes.
  if (options.enableNodeDrag) {
    let draggedNode: string | null = null;
    let draggingActive = false;

    let resumeOnRelease = false;

    renderer.on("downNode", ({ node, event }) => {
      draggedNode = node;
      draggingActive = true;
      // Pause the live supervisor while dragging so it doesn't fight the
      // user's finger. Remember whether it was running so we can resume.
      if (handle.layoutSupervisor && handle.layoutSupervisor.isRunning()) {
        handle.layoutSupervisor.stop();
        resumeOnRelease = true;
      } else {
        resumeOnRelease = false;
      }
      // Disable camera movement while dragging a node.
      renderer.getCamera().disable();
      event.preventSigmaDefault();
    });

    const mouseCaptor = renderer.getMouseCaptor();
    const onMouseMove = (ev: { x: number; y: number; preventSigmaDefault: () => void }) => {
      if (!draggingActive || !draggedNode) return;
      const coords = renderer.viewportToGraph({ x: ev.x, y: ev.y });
      graph.setNodeAttribute(draggedNode, "x", coords.x);
      graph.setNodeAttribute(draggedNode, "y", coords.y);
      ev.preventSigmaDefault();
    };
    const onMouseUp = () => {
      if (draggingActive) {
        draggingActive = false;
        draggedNode = null;
        renderer.getCamera().enable();
        // Resume only if the user hasn't frozen the sim via the Forces panel
        // while the drag was in flight.
        if (resumeOnRelease && handle.layoutSupervisor && !handle.frozen) {
          handle.layoutSupervisor.start();
        }
        resumeOnRelease = false;
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
 * Replace the graph's nodes + edges with a fresh payload. Re-runs the layout
 * so newly added nodes snap into place.
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
  const iterations = opts.iterations ?? handle.options.layoutIterations ?? 50;

  // Pause the live supervisor so it doesn't race with `graph.clear()` /
  // re-seed. We'll restart it at the end if it was running and the view is
  // not frozen.
  const wasRunning =
    handle.layoutSupervisor !== null &&
    handle.layoutSupervisor.isRunning();
  if (wasRunning && handle.layoutSupervisor) handle.layoutSupervisor.stop();

  if (!relayout) {
    // Preserve positions for nodes that already exist.
    const prevPos = new Map<string, { x: number; y: number }>();
    handle.graph.forEachNode((id, attrs) => {
      prevPos.set(id, {
        x: Number(attrs.x ?? 0),
        y: Number(attrs.y ?? 0),
      });
    });
    populateGraph(handle.graph, data);
    for (const [id, pos] of prevPos) {
      if (handle.graph.hasNode(id)) {
        handle.graph.setNodeAttribute(id, "x", pos.x);
        handle.graph.setNodeAttribute(id, "y", pos.y);
      }
    }
    // Only run a short refinement pass if there are new nodes.
    let newCount = 0;
    handle.graph.forEachNode((id) => {
      if (!prevPos.has(id)) newCount += 1;
    });
    if (newCount > 0) {
      runLayout(handle.graph, Math.min(iterations, 30));
    }
  } else {
    populateGraph(handle.graph, data);
    runLayout(handle.graph, iterations);
  }

  handle.neighborMap = buildNeighborMap(data.edges);
  handle.hoveredNode = null;
  handle.renderer.refresh();

  if (wasRunning && handle.layoutSupervisor && !handle.frozen) {
    handle.layoutSupervisor.start();
  }
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
  if (handle.layoutSupervisor) {
    try {
      handle.layoutSupervisor.kill();
    } catch {
      /* ignore */
    }
    handle.layoutSupervisor = null;
  }
  try {
    handle.renderer.kill();
  } catch {
    /* ignore */
  }
  handle.graph.clear();
}

/**
 * Update the live force parameters. Mutates the supervisor's settings in place
 * — the next iteration message to the worker picks them up. No-op when the
 * handle has no supervisor (static-layout mode).
 */
export function setForceSettings(
  handle: GraphHandle,
  settings: ForceSettings,
): void {
  handle.options = { ...handle.options, forceSettings: settings };
  if (!handle.layoutSupervisor) return;
  Object.assign(handle.layoutSupervisor.settings, settings);
}

/**
 * Pause or resume the live simulation. When a node drag is in progress the
 * drag handler still pauses on mousedown and only resumes on mouseup — this
 * function mirrors the frozen state so the drag handler knows whether to
 * resume.
 */
export function setLayoutFrozen(handle: GraphHandle, frozen: boolean): void {
  handle.frozen = frozen;
  if (!handle.layoutSupervisor) return;
  const running = handle.layoutSupervisor.isRunning();
  if (frozen && running) handle.layoutSupervisor.stop();
  if (!frozen && !running) handle.layoutSupervisor.start();
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
