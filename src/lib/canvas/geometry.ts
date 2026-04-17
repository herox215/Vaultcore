// Canvas edge geometry (#71, phase 2). Pure helpers for converting a
// node rectangle + side into an anchor point, auto-picking sides when an
// edge omits them, and producing the SVG `d` string for a cubic Bezier
// that enters/leaves each endpoint perpendicular to its side (Obsidian's
// routing style).

import type { CanvasNode, CanvasSide } from "./types";

export interface Point {
  x: number;
  y: number;
}

/**
 * Center point of the requested side of a node's bounding rect. Used as
 * the anchor where an edge meets the node and where we draw the hover
 * handles during edge-creation.
 */
export function anchorPoint(node: CanvasNode, side: CanvasSide): Point {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
  }
}

/** Unit vector pointing away from the node along the given side. */
function sideUnit(side: CanvasSide): Point {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "right":
      return { x: 1, y: 0 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
  }
}

/**
 * Pick a from/to side pair when the edge omits them. We use the larger
 * axis of the center-to-center vector to decide whether the edge should
 * leave horizontally or vertically, then face the sides toward each other.
 */
export function autoSides(
  from: CanvasNode,
  to: CanvasNode,
): { fromSide: CanvasSide; toSide: CanvasSide } {
  const fcx = from.x + from.width / 2;
  const fcy = from.y + from.height / 2;
  const tcx = to.x + to.width / 2;
  const tcy = to.y + to.height / 2;
  const dx = tcx - fcx;
  const dy = tcy - fcy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { fromSide: "right", toSide: "left" }
      : { fromSide: "left", toSide: "right" };
  }
  return dy >= 0
    ? { fromSide: "bottom", toSide: "top" }
    : { fromSide: "top", toSide: "bottom" };
}

/**
 * SVG `d` attribute for a cubic Bezier whose tangents at each end point
 * perpendicular to the requested side. The control-point offset grows
 * with endpoint distance so long edges get a gentle arc instead of a
 * kink while short edges stay tight.
 */
export function bezierPath(
  from: Point,
  fromSide: CanvasSide,
  to: Point,
  toSide: CanvasSide,
): string {
  const { c1, c2 } = bezierControls(from, fromSide, to, toSide);
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

/** Control points for the cubic Bezier used by {@link bezierPath}. */
export function bezierControls(
  from: Point,
  fromSide: CanvasSide,
  to: Point,
  toSide: CanvasSide,
): { c1: Point; c2: Point } {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const offset = Math.max(30, dist * 0.5);
  const uA = sideUnit(fromSide);
  const uB = sideUnit(toSide);
  return {
    c1: { x: from.x + uA.x * offset, y: from.y + uA.y * offset },
    c2: { x: to.x + uB.x * offset, y: to.y + uB.y * offset },
  };
}

/**
 * Midpoint (t=0.5) of the cubic Bezier, used to place the edge label and
 * the selection click-target.
 */
export function bezierMidpoint(
  from: Point,
  fromSide: CanvasSide,
  to: Point,
  toSide: CanvasSide,
): Point {
  const { c1, c2 } = bezierControls(from, fromSide, to, toSide);
  // B(0.5) for a cubic Bezier simplifies to (P0 + 3·P1 + 3·P2 + P3) / 8.
  return {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8,
  };
}

/** All four sides — used by the UI to render hover handles. */
export const SIDES: readonly CanvasSide[] = ["top", "right", "bottom", "left"];
