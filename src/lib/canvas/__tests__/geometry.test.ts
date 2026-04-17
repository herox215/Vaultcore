// Geometry helpers for canvas edges (#71, phase 2).

import { describe, it, expect } from "vitest";
import {
  anchorPoint,
  autoSides,
  bezierControls,
  bezierMidpoint,
  bezierPath,
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
