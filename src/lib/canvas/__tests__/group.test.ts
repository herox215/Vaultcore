// #168 — spatial group membership. Pure containment helper so moving a
// group translates every node whose bounding box fully lies inside the
// group's rect at the moment the drag starts. Matches Obsidian behavior —
// no persisted parent field, purely geometric at beginMove time.

import { describe, it, expect } from "vitest";
import { nodesInsideGroup } from "../group";
import type { CanvasDoc, CanvasGroupNode, CanvasNode } from "../types";

const group = (over: Partial<CanvasGroupNode> = {}): CanvasGroupNode => ({
  id: "g",
  type: "group",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  ...over,
});

const text = (over: Partial<CanvasNode> & { id: string }): CanvasNode => ({
  type: "text",
  text: "",
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  ...over,
} as CanvasNode);

const docOf = (nodes: CanvasNode[]): CanvasDoc => ({ nodes, edges: [] });

describe("nodesInsideGroup (#168)", () => {
  it("returns nodes whose bounding box lies fully inside the group rect", () => {
    const g = group({ x: 0, y: 0, width: 400, height: 300 });
    const inside = text({ id: "in", x: 50, y: 50, width: 100, height: 40 });
    const outside = text({ id: "out", x: 500, y: 500, width: 100, height: 40 });
    const doc = docOf([g, inside, outside]);

    const members = nodesInsideGroup(doc, g).map((n) => n.id);
    expect(members).toEqual(["in"]);
  });

  it("excludes nodes that overlap the group boundary but are not fully inside", () => {
    const g = group({ x: 0, y: 0, width: 200, height: 200 });
    const straddling = text({ id: "half", x: 150, y: 150, width: 100, height: 100 });
    const doc = docOf([g, straddling]);

    expect(nodesInsideGroup(doc, g)).toHaveLength(0);
  });

  it("excludes the group itself from its own membership list", () => {
    const g = group({ x: 0, y: 0, width: 400, height: 300 });
    const doc = docOf([g]);
    expect(nodesInsideGroup(doc, g)).toHaveLength(0);
  });

  it("excludes other group nodes so moving a group does not drag nested groups", () => {
    const outer = group({ id: "outer", x: 0, y: 0, width: 500, height: 500 });
    const inner = group({ id: "inner", x: 50, y: 50, width: 100, height: 100 });
    const doc = docOf([outer, inner]);
    // Per acceptance criteria in #168: groups don't nest-move. The decision
    // lives in this helper so the callers stay simple.
    expect(nodesInsideGroup(doc, outer)).toHaveLength(0);
  });

  it("includes a node whose edges touch the group rect exactly (inclusive bounds)", () => {
    const g = group({ x: 0, y: 0, width: 200, height: 200 });
    const flush = text({ id: "flush", x: 0, y: 0, width: 200, height: 200 });
    const doc = docOf([g, flush]);
    expect(nodesInsideGroup(doc, g).map((n) => n.id)).toEqual(["flush"]);
  });

  it("works for non-zero group origin (translated group rect)", () => {
    const g = group({ x: 100, y: 200, width: 300, height: 300 });
    const inside = text({ id: "in", x: 150, y: 250, width: 100, height: 40 });
    const outside = text({ id: "out", x: 50, y: 250, width: 100, height: 40 });
    const doc = docOf([g, inside, outside]);
    expect(nodesInsideGroup(doc, g).map((n) => n.id)).toEqual(["in"]);
  });

  it("returns every fully-inside node when many are present (preserves doc order)", () => {
    const g = group({ x: 0, y: 0, width: 1000, height: 1000 });
    const a = text({ id: "a", x: 10, y: 10 });
    const b = text({ id: "b", x: 100, y: 100 });
    const c = text({ id: "c", x: 200, y: 200 });
    const doc = docOf([g, a, b, c]);
    expect(nodesInsideGroup(doc, g).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
});
