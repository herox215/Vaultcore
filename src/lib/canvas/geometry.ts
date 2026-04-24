// Canvas edge geometry (#71, phase 2). Pure helpers for converting a
// node rectangle + side into an anchor point, auto-picking sides when an
// edge omits them, and producing the SVG `d` string for a cubic Bezier
// that enters/leaves each endpoint perpendicular to its side (Obsidian's
// routing style).

import type { CanvasNode, CanvasShape, CanvasSide } from "./types";
import { readShape } from "./types";

export interface Point {
  x: number;
  y: number;
}

/**
 * Center point of the requested side of a node's bounding rect. Used as
 * the anchor where an edge meets the node and where we draw the hover
 * handles during edge-creation.
 *
 * Shape-aware since #362: rectangle / rounded-rectangle / ellipse / diamond
 * all use bounding-box midpoints (they share the same anchor geometry — the
 * shape differs visually only). Triangles use the midpoints of their three
 * polygon edges; the apex (`top`) is not a valid anchor and callers must
 * have remapped it via {@link remapSideForShape} before reaching here. A
 * triangle's `top` here indicates a caller bug and falls through to `left`
 * to stay non-crashing, with a DEV-only warning so the bug surfaces.
 */
export function anchorPoint(
  node: CanvasNode,
  side: CanvasSide,
  shape: CanvasShape = readShape(node),
): Point {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  if (shape === "triangle") {
    // clip-path: polygon(50% 0%, 100% 100%, 0% 100%)
    // left edge  (apex → bottom-left)  midpoint = (x + w*0.25, y + h*0.5)
    // right edge (apex → bottom-right) midpoint = (x + w*0.75, y + h*0.5)
    // bottom edge (bl → br)            midpoint = (x + w*0.5,  y + h)
    switch (side) {
      case "left":
        return { x: node.x + node.width * 0.25, y: cy };
      case "right":
        return { x: node.x + node.width * 0.75, y: cy };
      case "bottom":
        return { x: cx, y: node.y + node.height };
      case "top":
        if (import.meta.env?.DEV) {
          console.warn(
            "[canvas/geometry] anchorPoint called with side='top' on a triangle; caller forgot to remapSideForShape — falling back to 'left'.",
          );
        }
        return { x: node.x + node.width * 0.25, y: cy };
    }
  }
  // Rectangle / rounded-rectangle / ellipse / diamond — bounding-box midpoints.
  switch (side) {
    case "top":
      return { x: cx, y: node.y };
    case "right":
      return { x: node.x + node.width, y: cy };
    case "bottom":
      return { x: cx, y: node.y + node.height };
    case "left":
      return { x: node.x, y: cy };
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
 *
 * After the baseline pick, each side is passed through
 * {@link remapSideForShape} so shapes that don't expose all four sides
 * (triangle) get a side that actually has an anchor. The remap runs per
 * endpoint so mixed cases (triangle ↔ rectangle, triangle ↔ triangle)
 * resolve correctly without a special-case.
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
  let fromSide: CanvasSide;
  let toSide: CanvasSide;
  if (Math.abs(dx) >= Math.abs(dy)) {
    fromSide = dx >= 0 ? "right" : "left";
    toSide = dx >= 0 ? "left" : "right";
  } else {
    fromSide = dy >= 0 ? "bottom" : "top";
    toSide = dy >= 0 ? "top" : "bottom";
  }
  return {
    fromSide: remapSideForShape(readShape(from), fromSide, { x: fcx, y: fcy }, { x: tcx, y: tcy }),
    toSide: remapSideForShape(readShape(to), toSide, { x: tcx, y: tcy }, { x: fcx, y: fcy }),
  };
}

/**
 * Sides that expose a valid connection anchor for each shape. Rectangle /
 * rounded-rectangle / ellipse / diamond all expose the full four-side set;
 * triangles drop `top` because the apex is a point (not a segment) and
 * makes a poor bezier terminus. The renderer iterates this list to decide
 * which hover handles to draw per node.
 */
export function sidesForShape(shape: CanvasShape): readonly CanvasSide[] {
  if (shape === "triangle") return TRIANGLE_SIDES;
  return SIDES;
}

/**
 * Coerce a side that isn't valid for the node's shape into one that is.
 * Only triangles need coercion today (their apex `top` has no anchor) —
 * the incoming side is swapped for whichever face of the triangle points
 * toward the other endpoint, so the edge stays on the short side.
 *
 * Pure and composable: takes the node's own center and the other
 * endpoint's center as plain points so the caller doesn't need to know
 * the dx convention, and the same helper works for auto-picked sides, a
 * user-set explicit side surviving from before a shape change, and a
 * draft edge's origin during edge creation.
 */
export function remapSideForShape(
  shape: CanvasShape,
  side: CanvasSide,
  myCenter: Point,
  otherCenter: Point,
): CanvasSide {
  if (shape !== "triangle") return side;
  if (side !== "top") return side;
  return otherCenter.x >= myCenter.x ? "right" : "left";
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

/** Triangle's three anchor-bearing sides (no `top` — that's the apex). */
const TRIANGLE_SIDES: readonly CanvasSide[] = ["left", "right", "bottom"];
