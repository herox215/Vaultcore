// Edge resolution tests (#133).

import { describe, it, expect } from "vitest";
import {
  resolveEdges,
  draftPath,
  oppositeSide,
} from "../edgeResolver";
import type {
  CanvasDoc,
  CanvasEdge,
  CanvasSide,
  CanvasTextNode,
} from "../types";
import type { DraftEdge } from "../pointerMode";

const node = (id: string, over: Partial<CanvasTextNode> = {}): CanvasTextNode => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  text: "",
  ...over,
});

const edge = (over: Partial<CanvasEdge> & Pick<CanvasEdge, "id" | "fromNode" | "toNode">): CanvasEdge =>
  over;

const doc = (nodes: CanvasTextNode[], edges: CanvasEdge[]): CanvasDoc => ({
  nodes,
  edges,
});

describe("oppositeSide", () => {
  it("flips each side to its opposite (used for draft preview routing)", () => {
    expect(oppositeSide("left")).toBe("right");
    expect(oppositeSide("right")).toBe("left");
    expect(oppositeSide("top")).toBe("bottom");
    expect(oppositeSide("bottom")).toBe("top");
  });
});

describe("resolveEdges", () => {
  it("resolves a complete edge with explicit sides", () => {
    const a = node("a", { x: 0, y: 0, width: 100, height: 50 });
    const b = node("b", { x: 200, y: 0, width: 100, height: 50 });
    const e: CanvasEdge = {
      id: "e1",
      fromNode: "a",
      toNode: "b",
      fromSide: "right",
      toSide: "left",
    };
    const out = resolveEdges(doc([a, b], [e]));
    expect(out).toHaveLength(1);
    expect(out[0]?.fromPt).toEqual({ x: 100, y: 25 });
    expect(out[0]?.toPt).toEqual({ x: 200, y: 25 });
    expect(out[0]?.fromSide).toBe("right");
    expect(out[0]?.toSide).toBe("left");
    expect(typeof out[0]?.path).toBe("string");
    expect(out[0]?.path.length).toBeGreaterThan(0);
  });

  it("auto-picks sides when fromSide/toSide are omitted", () => {
    const a = node("a", { x: 0, y: 0 });
    const b = node("b", { x: 500, y: 0 });
    const e = edge({ id: "e1", fromNode: "a", toNode: "b" });
    const out = resolveEdges(doc([a, b], [e]));
    expect(out).toHaveLength(1);
    // Two horizontally-arranged nodes with no explicit sides should auto-pick
    // matching opposite sides (right ↔ left).
    expect(out[0]?.fromSide).toBe("right");
    expect(out[0]?.toSide).toBe("left");
  });

  it("silently skips edges whose fromNode is missing", () => {
    const b = node("b");
    const e = edge({ id: "e1", fromNode: "missing", toNode: "b" });
    expect(resolveEdges(doc([b], [e]))).toEqual([]);
  });

  it("silently skips edges whose toNode is missing", () => {
    const a = node("a");
    const e = edge({ id: "e1", fromNode: "a", toNode: "missing" });
    expect(resolveEdges(doc([a], [e]))).toEqual([]);
  });

  it("skips a corrupt edge but keeps resolving valid ones in the same doc", () => {
    const a = node("a", { x: 0, y: 0 });
    const b = node("b", { x: 200, y: 0 });
    const valid: CanvasEdge = { id: "ok", fromNode: "a", toNode: "b" };
    const orphan: CanvasEdge = { id: "bad", fromNode: "a", toNode: "ghost" };
    const out = resolveEdges(doc([a, b], [valid, orphan]));
    expect(out.map((r) => r.edge.id)).toEqual(["ok"]);
  });

  // #362: triangles only expose three anchors (left/right/bottom). An
  // edge whose user-set `top` side lands on a triangle (possible if the
  // node was reshaped after the edge was authored) must remap to a
  // triangle side instead of silently drawing to the missing apex anchor.
  it("remaps an explicit `fromSide: top` on a triangle to a valid triangle side", () => {
    const tri = node("a", { x: 0, y: 0, width: 100, height: 40, shape: "triangle" });
    const other = node("b", { x: 500, y: 0, width: 100, height: 40 });
    const e: CanvasEdge = {
      id: "e1",
      fromNode: "a",
      toNode: "b",
      fromSide: "top",
      toSide: "left",
    };
    const out = resolveEdges(doc([tri, other], [e]));
    expect(out).toHaveLength(1);
    // Other node is to the right → top remaps to right.
    expect(out[0]?.fromSide).toBe("right");
    // Anchor point must match the triangle's right-edge midpoint, not the
    // bounding-box top midpoint.
    expect(out[0]?.fromPt).toEqual({ x: 75, y: 20 });
  });

  it("remaps an explicit `toSide: top` on a triangle", () => {
    const other = node("a", { x: 500, y: 0, width: 100, height: 40 });
    const tri = node("b", { x: 0, y: 0, width: 100, height: 40, shape: "triangle" });
    const e: CanvasEdge = {
      id: "e1",
      fromNode: "a",
      toNode: "b",
      fromSide: "left",
      toSide: "top",
    };
    const out = resolveEdges(doc([other, tri], [e]));
    expect(out[0]?.toSide).toBe("right"); // other is to the right → remap right
  });
});

describe("draftPath", () => {
  const fromNode = node("a", { x: 0, y: 0, width: 100, height: 50 });
  const toNode = node("b", { x: 300, y: 0, width: 100, height: 50 });

  const baseDraft = (over: Partial<DraftEdge> = {}): DraftEdge => ({
    fromNodeId: "a",
    fromSide: "right",
    currentX: 200,
    currentY: 25,
    targetNodeId: null,
    targetSide: null,
    ...over,
  });

  it("returns null when no draft is in progress", () => {
    expect(draftPath(doc([fromNode], []), null)).toBeNull();
  });

  it("returns null when the origin node is missing from the doc", () => {
    const stale = baseDraft({ fromNodeId: "ghost" });
    expect(draftPath(doc([fromNode], []), stale)).toBeNull();
  });

  it("routes from origin handle through cursor when no snap target", () => {
    const path = draftPath(doc([fromNode], []), baseDraft());
    expect(path).not.toBeNull();
    expect(path).toMatch(/^M /); // SVG path starts with a move
  });

  it("routes into a snapped target's handle naturally", () => {
    const snapped = baseDraft({
      targetNodeId: "b",
      targetSide: "left",
    });
    const path = draftPath(doc([fromNode, toNode], []), snapped);
    expect(path).not.toBeNull();
    expect(path).toMatch(/^M /);
  });

  it("falls back to the cursor when the snap target node has been deleted", () => {
    const snappedToGhost = baseDraft({
      targetNodeId: "ghost",
      targetSide: "left",
    });
    const path = draftPath(doc([fromNode], []), snappedToGhost);
    // Falls through to the cursor path rather than returning null.
    expect(path).not.toBeNull();
    expect(path).toMatch(/^M /);
  });

  it("uses opposite-side routing for each origin side when free", () => {
    const sides: CanvasSide[] = ["left", "right", "top", "bottom"];
    for (const side of sides) {
      const path = draftPath(
        doc([fromNode], []),
        baseDraft({ fromSide: side }),
      );
      expect(path).not.toBeNull();
    }
  });

  // #362: when the draft origin is a triangle and a snap target is found,
  // the origin side must remap against the TARGET's center so the bezier
  // leaves toward the right endpoint — not against the (possibly far)
  // cursor position, which would invert the exit side mid-drag.
  it("remaps a triangle origin's `top` against the snap target's center, not the cursor", () => {
    const tri: CanvasTextNode = {
      id: "tri",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: "",
      shape: "triangle",
    };
    const target: CanvasTextNode = {
      id: "b",
      type: "text",
      x: 500, // to the right of the triangle
      y: 0,
      width: 100,
      height: 40,
      text: "",
    };
    const draft: DraftEdge = {
      fromNodeId: "tri",
      fromSide: "top",
      // Cursor far to the LEFT of the triangle — if the remap used the
      // cursor, fromSide would flip to "left". We want "right" because
      // the target is to the right.
      currentX: -500,
      currentY: 50,
      targetNodeId: "b",
      targetSide: "left",
    };
    const path = draftPath(doc([tri, target], []), draft);
    expect(path).not.toBeNull();
    // The bezier starts at the triangle's right-edge midpoint (x=75, y=20),
    // not at the left (x=25, y=20). Matching the prefix is sufficient.
    expect(path).toMatch(/^M 75 20 /);
  });
});
