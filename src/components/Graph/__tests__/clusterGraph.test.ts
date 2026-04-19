// Pure-function tests for the embedding-mode clustering helper (#237).
//
// `clusterGraph` takes a LocalGraph produced by `get_embedding_graph` plus
// a cluster-threshold slider value, and collapses any connected component
// whose internal edges all clear the threshold into a single super-node.
// No sigma / graphology imports — the helper is pure so we test it flat.

import { describe, expect, it } from "vitest";
import type { LocalGraph } from "../../../types/links";
import { clusterGraph, CLUSTER_NODE_ID_PREFIX } from "../clusterGraph";

function node(id: string, label: string, backlinkCount = 0) {
  return { id, label, path: id, backlinkCount, resolved: true };
}

function edge(from: string, to: string, weight?: number) {
  return weight === undefined ? { from, to } : { from, to, weight };
}

describe("clusterGraph", () => {
  it("passes through unchanged when threshold >= 1.0", () => {
    const raw: LocalGraph = {
      nodes: [node("a.md", "A"), node("b.md", "B")],
      edges: [edge("a.md", "b.md", 0.95)],
    };
    const out = clusterGraph(raw, 1.0);
    expect(out.graph.nodes).toEqual(raw.nodes);
    expect(out.graph.edges).toEqual(raw.edges);
    expect(out.clusters.size).toBe(0);
  });

  it("passes through link-mode graphs (edges without weight) regardless of threshold", () => {
    const raw: LocalGraph = {
      nodes: [node("a.md", "A"), node("b.md", "B")],
      edges: [edge("a.md", "b.md")],
    };
    const out = clusterGraph(raw, 0.5);
    expect(out.graph.nodes).toEqual(raw.nodes);
    expect(out.graph.edges).toEqual(raw.edges);
    expect(out.clusters.size).toBe(0);
  });

  it("collapses a single high-weight pair into one super-node and drops its intra-edge", () => {
    const raw: LocalGraph = {
      nodes: [node("a.md", "A"), node("b.md", "B")],
      edges: [edge("a.md", "b.md", 0.8)],
    };
    const out = clusterGraph(raw, 0.7);
    expect(out.graph.nodes).toHaveLength(1);
    expect(out.graph.edges).toHaveLength(0);
    expect(out.graph.nodes[0]!.id.startsWith(CLUSTER_NODE_ID_PREFIX)).toBe(true);
    expect(out.clusters.size).toBe(1);
  });

  it("uses the min member id to derive the cluster id (stable across slider ticks)", () => {
    const raw: LocalGraph = {
      nodes: [node("z.md", "Z"), node("a.md", "A"), node("m.md", "M")],
      edges: [
        edge("z.md", "a.md", 0.9),
        edge("a.md", "m.md", 0.85),
        edge("z.md", "m.md", 0.82),
      ],
    };
    const out = clusterGraph(raw, 0.8);
    expect(out.graph.nodes).toHaveLength(1);
    expect(out.graph.nodes[0]!.id).toBe(`${CLUSTER_NODE_ID_PREFIX}a.md`);
    const info = out.clusters.get(`${CLUSTER_NODE_ID_PREFIX}a.md`);
    expect(info?.members).toEqual(["a.md", "m.md", "z.md"]);
  });

  it("picks the representative as the member with the highest sum of intra-cluster weights", () => {
    // Weights: (a,b)=0.9, (a,c)=0.9, (b,c)=0.75
    // Sums: a = 1.8, b = 1.65, c = 1.65 → a wins.
    const raw: LocalGraph = {
      nodes: [node("a.md", "A"), node("b.md", "B"), node("c.md", "C")],
      edges: [
        edge("a.md", "b.md", 0.9),
        edge("a.md", "c.md", 0.9),
        edge("b.md", "c.md", 0.75),
      ],
    };
    const out = clusterGraph(raw, 0.7);
    expect(out.graph.nodes).toHaveLength(1);
    expect(out.graph.nodes[0]!.label.startsWith("A")).toBe(true);
    expect(out.graph.nodes[0]!.label).toContain("+2");
  });

  it("breaks representative ties by backlinkCount then alphabetical id", () => {
    // Weights tie all pairs at 0.8 so weight sums tie; b has highest backlinks.
    const raw: LocalGraph = {
      nodes: [
        node("a.md", "Alpha", 1),
        node("b.md", "Beta", 5),
        node("c.md", "Gamma", 1),
      ],
      edges: [
        edge("a.md", "b.md", 0.8),
        edge("a.md", "c.md", 0.8),
        edge("b.md", "c.md", 0.8),
      ],
    };
    const out = clusterGraph(raw, 0.7);
    expect(out.graph.nodes).toHaveLength(1);
    expect(out.graph.nodes[0]!.label.startsWith("Beta")).toBe(true);
  });

  it("labels the super-node as '<representative> · +N'", () => {
    const raw: LocalGraph = {
      nodes: [node("a.md", "Alpha"), node("b.md", "Beta"), node("c.md", "Gamma")],
      edges: [
        edge("a.md", "b.md", 0.9),
        edge("a.md", "c.md", 0.85),
      ],
    };
    const out = clusterGraph(raw, 0.8);
    expect(out.graph.nodes).toHaveLength(1);
    expect(out.graph.nodes[0]!.label).toBe("Alpha · +2");
  });

  it("passes through singleton nodes unchanged (no incident high-weight edges)", () => {
    const raw: LocalGraph = {
      nodes: [node("a.md", "A"), node("b.md", "B"), node("lone.md", "Lone")],
      edges: [edge("a.md", "b.md", 0.9)],
    };
    const out = clusterGraph(raw, 0.8);
    // One cluster node + one lone singleton.
    expect(out.graph.nodes).toHaveLength(2);
    const lone = out.graph.nodes.find((n) => n.id === "lone.md");
    expect(lone).toEqual(node("lone.md", "Lone"));
  });

  it("aggregates inter-cluster edges with the maximum member-pair weight", () => {
    // Two clusters: {a,b} (via 0.9) and {c,d} (via 0.9).
    // Cross edges a-c = 0.6, b-d = 0.65 → super-edge weight = 0.65.
    const raw: LocalGraph = {
      nodes: [
        node("a.md", "A"),
        node("b.md", "B"),
        node("c.md", "C"),
        node("d.md", "D"),
      ],
      edges: [
        edge("a.md", "b.md", 0.9),
        edge("c.md", "d.md", 0.9),
        edge("a.md", "c.md", 0.6),
        edge("b.md", "d.md", 0.65),
      ],
    };
    const out = clusterGraph(raw, 0.8);
    expect(out.graph.nodes).toHaveLength(2);
    expect(out.graph.edges).toHaveLength(1);
    expect(out.graph.edges[0]!.weight).toBeCloseTo(0.65, 6);
  });

  it("filters self-loops after cluster collapse", () => {
    // All edges above threshold → everything collapses into one cluster;
    // every would-be edge becomes a self-loop and must be dropped.
    const raw: LocalGraph = {
      nodes: [node("a.md", "A"), node("b.md", "B"), node("c.md", "C")],
      edges: [
        edge("a.md", "b.md", 0.9),
        edge("b.md", "c.md", 0.9),
        edge("a.md", "c.md", 0.9),
      ],
    };
    const out = clusterGraph(raw, 0.8);
    expect(out.graph.nodes).toHaveLength(1);
    expect(out.graph.edges).toHaveLength(0);
  });

  it("preserves a below-threshold edge between two singletons", () => {
    const raw: LocalGraph = {
      nodes: [node("a.md", "A"), node("b.md", "B")],
      edges: [edge("a.md", "b.md", 0.6)],
    };
    const out = clusterGraph(raw, 0.8);
    expect(out.graph.nodes).toHaveLength(2);
    expect(out.graph.edges).toHaveLength(1);
    expect(out.graph.edges[0]).toEqual(raw.edges[0]);
  });

  it("sums member backlinkCounts onto the super-node so sizing reflects cluster mass", () => {
    const raw: LocalGraph = {
      nodes: [
        node("a.md", "A", 3),
        node("b.md", "B", 4),
      ],
      edges: [edge("a.md", "b.md", 0.9)],
    };
    const out = clusterGraph(raw, 0.8);
    expect(out.graph.nodes).toHaveLength(1);
    expect(out.graph.nodes[0]!.backlinkCount).toBe(7);
  });
});
