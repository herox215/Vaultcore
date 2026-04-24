// Geometry helpers for canvas edges (#71, phase 2).

import { describe, it, expect } from "vitest";
import {
  anchorPoint,
  autoSides,
  bezierControls,
  bezierMidpoint,
  bezierPath,
  sidesForShape,
  remapSideForShape,
} from "../geometry";
import type { CanvasTextNode } from "../types";

const node = (over: Partial<CanvasTextNode> = {}): CanvasTextNode => ({
  id: "n",
  type: "text",
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  text: "",
  ...over,
});

describe("anchorPoint", () => {
  it("returns the center of each side of the bounding rect", () => {
    const n = node({ x: 10, y: 20, width: 200, height: 80 });
    expect(anchorPoint(n, "top")).toEqual({ x: 110, y: 20 });
    expect(anchorPoint(n, "right")).toEqual({ x: 210, y: 60 });
    expect(anchorPoint(n, "bottom")).toEqual({ x: 110, y: 100 });
    expect(anchorPoint(n, "left")).toEqual({ x: 10, y: 60 });
  });
});

describe("autoSides", () => {
  it("faces sides toward each other when the target is to the right", () => {
    const from = node({ id: "a", x: 0, y: 0 });
    const to = node({ id: "b", x: 500, y: 0 });
    expect(autoSides(from, to)).toEqual({ fromSide: "right", toSide: "left" });
  });

  it("faces sides toward each other when the target is above", () => {
    const from = node({ id: "a", x: 0, y: 500 });
    const to = node({ id: "b", x: 0, y: 0 });
    expect(autoSides(from, to)).toEqual({ fromSide: "top", toSide: "bottom" });
  });

  it("prefers the horizontal axis when dx == dy (ties)", () => {
    const from = node({ id: "a", x: 0, y: 0, width: 0, height: 0 });
    const to = node({ id: "b", x: 100, y: 100, width: 0, height: 0 });
    // |dx| === |dy| → horizontal wins by ">=" convention
    expect(autoSides(from, to)).toEqual({ fromSide: "right", toSide: "left" });
  });
});

describe("bezierControls", () => {
  it("extends control points perpendicular to the requested side", () => {
    const { c1, c2 } = bezierControls(
      { x: 100, y: 50 },
      "right",
      { x: 400, y: 50 },
      "left",
    );
    // Both control points sit on the y=50 line because the sides point
    // horizontally. c1 is to the right of the start, c2 to the left of the end.
    expect(c1.y).toBeCloseTo(50);
    expect(c2.y).toBeCloseTo(50);
    expect(c1.x).toBeGreaterThan(100);
    expect(c2.x).toBeLessThan(400);
  });

  it("has a minimum offset so very-short edges still curve away from the node", () => {
    const { c1, c2 } = bezierControls(
      { x: 0, y: 0 },
      "right",
      { x: 1, y: 0 },
      "left",
    );
    // Even though the endpoints are 1px apart, the minimum 30px offset keeps
    // the control points out where the curve can leave/enter the nodes cleanly.
    expect(c1.x).toBeGreaterThanOrEqual(30);
    expect(c2.x).toBeLessThanOrEqual(1 - 30);
  });
});

describe("bezierPath", () => {
  it("produces an SVG d string starting at `from` and ending at `to`", () => {
    const d = bezierPath(
      { x: 10, y: 20 },
      "right",
      { x: 200, y: 80 },
      "left",
    );
    expect(d).toMatch(/^M 10 20 C /);
    expect(d).toMatch(/200 80$/);
  });
});

describe("bezierMidpoint", () => {
  it("lies on the curve between the endpoints", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 400, y: 0 };
    const mid = bezierMidpoint(from, "right", to, "left");
    // Symmetric horizontal case → midpoint should be horizontally centered.
    expect(mid.x).toBeCloseTo(200, 0);
    expect(mid.y).toBeCloseTo(0, 5);
  });
});

// ───────── #362: shape-aware anchors + autoSides remap ─────────

describe("anchorPoint (shape-aware, #362)", () => {
  it("uses bounding-box midpoints for rectangle / rounded-rectangle / ellipse / diamond", () => {
    const n = node({ x: 10, y: 20, width: 200, height: 80 });
    for (const shape of ["rectangle", "rounded-rectangle", "ellipse", "diamond"] as const) {
      expect(anchorPoint(n, "top", shape)).toEqual({ x: 110, y: 20 });
      expect(anchorPoint(n, "right", shape)).toEqual({ x: 210, y: 60 });
      expect(anchorPoint(n, "bottom", shape)).toEqual({ x: 110, y: 100 });
      expect(anchorPoint(n, "left", shape)).toEqual({ x: 10, y: 60 });
    }
  });

  it("uses the three edge midpoints of the triangle polygon for triangles", () => {
    // Triangle clip-path: apex at top-center, base along bottom edge.
    // Left edge midpoint  = (x + w*0.25, y + h*0.5)
    // Right edge midpoint = (x + w*0.75, y + h*0.5)
    // Bottom edge midpoint = (x + w*0.5,  y + h)
    const n = node({ x: 0, y: 0, width: 100, height: 40 });
    expect(anchorPoint(n, "left", "triangle")).toEqual({ x: 25, y: 20 });
    expect(anchorPoint(n, "right", "triangle")).toEqual({ x: 75, y: 20 });
    expect(anchorPoint(n, "bottom", "triangle")).toEqual({ x: 50, y: 40 });
  });

  it("reads the node's own shape when the `shape` arg is omitted", () => {
    const tri = node({ x: 0, y: 0, width: 100, height: 40, shape: "triangle" });
    expect(anchorPoint(tri, "left")).toEqual({ x: 25, y: 20 });
    const rect = node({ x: 0, y: 0, width: 100, height: 40 });
    // No shape field → rounded-rectangle default → bounding-box midpoints.
    expect(anchorPoint(rect, "left")).toEqual({ x: 0, y: 20 });
  });
});

describe("sidesForShape", () => {
  it("returns all 4 sides for non-triangle shapes", () => {
    for (const shape of ["rectangle", "rounded-rectangle", "ellipse", "diamond"] as const) {
      expect(sidesForShape(shape)).toEqual(["top", "right", "bottom", "left"]);
    }
  });

  it("returns only left / right / bottom for triangles (no top — it's the apex)", () => {
    expect(sidesForShape("triangle")).toEqual(["left", "right", "bottom"]);
  });
});

describe("remapSideForShape", () => {
  it("passes non-top sides through untouched on any shape", () => {
    const my = { x: 0, y: 0 };
    const other = { x: 100, y: 0 };
    for (const side of ["left", "right", "bottom"] as const) {
      expect(remapSideForShape("triangle", side, my, other)).toBe(side);
      expect(remapSideForShape("rectangle", side, my, other)).toBe(side);
    }
  });

  it("passes `top` through untouched on non-triangle shapes", () => {
    const my = { x: 0, y: 0 };
    const other = { x: 100, y: 0 };
    expect(remapSideForShape("rectangle", "top", my, other)).toBe("top");
    expect(remapSideForShape("ellipse", "top", my, other)).toBe("top");
  });

  it("remaps triangle `top` to `right` when the other endpoint is to the right", () => {
    const my = { x: 0, y: 0 };
    const other = { x: 100, y: 50 };
    expect(remapSideForShape("triangle", "top", my, other)).toBe("right");
  });

  it("remaps triangle `top` to `left` when the other endpoint is to the left", () => {
    const my = { x: 100, y: 0 };
    const other = { x: 0, y: 50 };
    expect(remapSideForShape("triangle", "top", my, other)).toBe("left");
  });
});

describe("autoSides (shape-aware, #362)", () => {
  it("remaps a triangle endpoint's `top` auto-pick to left/right based on dx", () => {
    // Vertical stack: rectangle above, triangle below. autoSides' baseline
    // picks fromSide: "bottom", toSide: "top". The triangle is the TO node
    // and its apex (`top`) has no anchor — remap to whichever face points
    // at the other endpoint. With dx=0 the `>= 0` convention resolves to
    // `right`, which is fine either way — we only care that it isn't `top`.
    const rect = node({ id: "from", x: 0, y: 0, width: 100, height: 40 });
    const tri = node({ id: "to", x: 0, y: 500, width: 100, height: 40, shape: "triangle" });
    const sides = autoSides(rect, tri);
    expect(sides.fromSide).toBe("bottom");
    expect(sides.toSide).not.toBe("top");
    expect(sides.toSide === "left" || sides.toSide === "right").toBe(true);
  });

  it("remaps independently per endpoint when both endpoints are triangles", () => {
    // Triangles directly above/below → baseline pick is top/bottom. The
    // upper triangle gets `bottom` (not top → safe). The lower triangle
    // would get `top`, which must remap.
    const top = node({ id: "top", x: 0, y: 0, width: 100, height: 40, shape: "triangle" });
    const bot = node({ id: "bot", x: 50, y: 500, width: 100, height: 40, shape: "triangle" });
    const sides = autoSides(top, bot);
    expect(sides.fromSide).toBe("bottom"); // upper triangle — bottom is a valid anchor
    expect(sides.toSide).not.toBe("top"); // remapped away
    // Lower triangle's "top" faces the upper one which is to its left
    // (dx = fcx - tcx = 50 - 100 = -50), so remap → "right" (to face left).
    // Convention: remapSideForShape uses other.x - my.x ≥ 0 → "right", else "left".
    // From the TO node's perspective, "other" is the FROM node at dx = -50 → "left".
    expect(sides.toSide).toBe("left");
  });

  it("keeps horizontal-axis auto-pick unchanged for triangles (no top involved)", () => {
    const tri = node({ id: "t", x: 0, y: 0, width: 100, height: 40, shape: "triangle" });
    const other = node({ id: "o", x: 500, y: 0, width: 100, height: 40 });
    const sides = autoSides(tri, other);
    expect(sides).toEqual({ fromSide: "right", toSide: "left" });
  });
});
