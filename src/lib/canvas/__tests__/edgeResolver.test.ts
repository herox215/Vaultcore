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
});
