// #237 — second graph-mode slider that collapses groups of highly-similar
// notes into a single representative super-node ("Oberbegriff").
//
// Runs purely in the frontend between the backend IPC response and the
// sigma/graphology render pass so the slider stays live (no roundtrip per
// tick). Algorithm is a union-find over the weighted embedding graph:
//
//   1. Every edge whose cosine similarity clears `threshold` unions its
//      endpoints. Lower threshold → more aggressive merging.
//   2. Each component of size ≥ 2 becomes a super-node whose label
//      surfaces the most "central" member (highest Σ intra-cluster
//      weight), and whose backlinkCount is the sum of its members' so
//      sigma renders it at a size that reflects cluster mass.
//   3. Edges are rewritten onto super-node ids, self-loops are dropped,
//      and multi-edges between the same cluster pair collapse to the
//      max member-pair weight — consistent with the backend's
//      chunk-pair-max aggregation.
//
// At `threshold >= 1.0` the helper is a strict passthrough, so the slider
// at its right edge reproduces the raw per-note graph byte-for-byte.
// Link-mode edges have no `weight`, so they never union anything and the
// helper no-ops regardless of the threshold.

import type { LocalGraph, GraphNode, GraphEdge } from "../../types/links";

/** Super-node ids are prefixed so the surrounding UI can cheaply tell a
 *  cluster apart from a real note (the Tauri side only ever mints real
 *  note paths as ids). */
export const CLUSTER_NODE_ID_PREFIX = "cluster:";

export interface ClusterMembership {
  /** Member id chosen as visual representative (max Σ intra-cluster weight,
   *  tiebreak by backlinkCount then alphabetical id). */
  representative: string;
  /** All member ids in the cluster, including the representative. */
  members: string[];
}

export interface ClusterResult {
  graph: LocalGraph;
  /** Keyed by the super-node id. Empty when no clustering was applied. */
  clusters: Map<string, ClusterMembership>;
}

/**
 * Collapse tight embedding components into super-nodes.
 *
 * Backwards-compatible shape: callers that only care about the resulting
 * graph can destructure `.graph`; the `clusters` map is there for UI that
 * wants to surface membership (e.g. tooltip listing, future expand-on-click).
 */
export function clusterGraph(raw: LocalGraph, threshold: number): ClusterResult {
  // Fast path — slider at rest (= off). Also covers `threshold > 1.0`
  // for paranoid callers.
  if (threshold >= 1.0) {
    return { graph: raw, clusters: new Map() };
  }

  // Build a parent array keyed by node id.
  const parent = new Map<string, string>();
  for (const n of raw.nodes) parent.set(n.id, n.id);

  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur)!;
      const gp = parent.get(p)!;
      parent.set(cur, gp);
      cur = gp;
    }
    return cur;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Deterministic union: prefer the lexicographically smaller root so
    // cluster identity is stable across slider ticks.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  // Phase 1 — union high-weight edges. Edges without weight never union,
  // which is how link-mode passthrough falls out naturally.
  for (const e of raw.edges) {
    if (typeof e.weight !== "number" || !Number.isFinite(e.weight)) continue;
    if (e.weight < threshold) continue;
    if (!parent.has(e.from) || !parent.has(e.to)) continue;
    union(e.from, e.to);
  }

  // Phase 2 — group members by root.
  const byRoot = new Map<string, string[]>();
  for (const n of raw.nodes) {
    const r = find(n.id);
    const arr = byRoot.get(r);
    if (arr) arr.push(n.id);
    else byRoot.set(r, [n.id]);
  }

  // Detect whether anything actually clustered. If every root maps to a
  // single-member component we can fast-path to passthrough — saves a
  // surprising amount of churn on big vaults where the slider sits above
  // the natural similarity ceiling.
  let hasMultiMember = false;
  for (const members of byRoot.values()) {
    if (members.length >= 2) {
      hasMultiMember = true;
      break;
    }
  }
  if (!hasMultiMember) {
    return { graph: raw, clusters: new Map() };
  }

  // Phase 3 — for each multi-member component pick a representative and
  // mint the super-node. Singletons pass through as-is.
  const nodesById = new Map<string, GraphNode>();
  for (const n of raw.nodes) nodesById.set(n.id, n);

  // Per-member Σ intra-cluster weight — used by the representative picker.
  const weightSum = new Map<string, number>();
  for (const e of raw.edges) {
    if (typeof e.weight !== "number" || !Number.isFinite(e.weight)) continue;
    if (e.weight < threshold) continue;
    if (find(e.from) !== find(e.to)) continue;
    weightSum.set(e.from, (weightSum.get(e.from) ?? 0) + e.weight);
    weightSum.set(e.to, (weightSum.get(e.to) ?? 0) + e.weight);
  }

  // Map original id → super-node id (or itself for singletons).
  const remap = new Map<string, string>();
  const clusters = new Map<string, ClusterMembership>();
  const outNodes: GraphNode[] = [];

  // Stable iteration: sort roots so the output node order is deterministic
  // (nice for tests + snapshot-diff debugging).
  const rootKeys = Array.from(byRoot.keys()).sort();

  for (const root of rootKeys) {
    const members = byRoot.get(root)!;
    if (members.length === 1) {
      const only = members[0]!;
      remap.set(only, only);
      outNodes.push(nodesById.get(only)!);
      continue;
    }

    // Representative pick: max Σ weight, tiebreak by backlinkCount desc,
    // then alphabetical id asc. Using a stable sort on a copy.
    const ranked = members.slice().sort((a, b) => {
      const wa = weightSum.get(a) ?? 0;
      const wb = weightSum.get(b) ?? 0;
      if (wa !== wb) return wb - wa;
      const ba = nodesById.get(a)?.backlinkCount ?? 0;
      const bb = nodesById.get(b)?.backlinkCount ?? 0;
      if (ba !== bb) return bb - ba;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const rep = ranked[0]!;

    const sortedMembers = members.slice().sort();
    const clusterId = CLUSTER_NODE_ID_PREFIX + sortedMembers[0]!;
    const repNode = nodesById.get(rep)!;
    const sumBacklinks = members.reduce(
      (acc, m) => acc + (nodesById.get(m)?.backlinkCount ?? 0),
      0,
    );

    outNodes.push({
      id: clusterId,
      label: `${repNode.label} · +${members.length - 1}`,
      path: "",
      backlinkCount: sumBacklinks,
      resolved: true,
    });

    clusters.set(clusterId, { representative: rep, members: sortedMembers });
    for (const m of members) remap.set(m, clusterId);
  }

  // Phase 4 — rewrite edges. Self-loops drop; duplicates between the same
  // cluster pair collapse to the max observed member-pair weight (matches
  // the backend's chunk-pair-max semantics).
  const edgeByKey = new Map<string, GraphEdge>();
  const passthrough: GraphEdge[] = [];
  for (const e of raw.edges) {
    const from = remap.get(e.from) ?? e.from;
    const to = remap.get(e.to) ?? e.to;
    if (from === to) continue;

    // Only edges that touch a cluster need aggregation — passthrough the
    // rest so link-mode graphs (no weight) keep their original edge list
    // shape and the existing GraphCanvas equality checks don't thrash.
    const isCluster = from.startsWith(CLUSTER_NODE_ID_PREFIX) || to.startsWith(CLUSTER_NODE_ID_PREFIX);
    if (!isCluster) {
      passthrough.push(e);
      continue;
    }

    const lo = from < to ? from : to;
    const hi = from < to ? to : from;
    const key = `${lo}|${hi}`;
    const w = typeof e.weight === "number" && Number.isFinite(e.weight) ? e.weight : 0;
    const existing = edgeByKey.get(key);
    if (!existing || (existing.weight ?? 0) < w) {
      const next: GraphEdge = { from: lo, to: hi };
      if (w > 0) next.weight = w;
      edgeByKey.set(key, next);
    }
  }

  const outEdges = passthrough.concat(Array.from(edgeByKey.values()));

  return {
    graph: { nodes: outNodes, edges: outEdges },
    clusters,
  };
}
