// Edge resolution for canvas rendering (#71, extracted for #133).
//
// Two pure helpers the viewer's render loop calls every frame:
//   - resolveEdges: turn the document's logical edge list into the
//     anchor points + bezier paths the SVG layer renders. Edges whose
//     endpoint node has been deleted (or is otherwise missing from the
//     doc) are silently skipped so a corrupt file can't crash the view.
//   - draftPath: the bezier preview the user sees while dragging from a
//     handle. When the cursor is over a different node's handle we route
//     into that handle naturally; otherwise we fake an "opposite side"
//     so the preview still curves smoothly toward the cursor.
//
// Keeping these out of the .svelte component means we can unit-test the
// fallback behaviours (missing endpoint, no snap target, opposite-side
// pick) without booting the renderer.

import { anchorPoint, autoSides, bezierMidpoint, bezierPath } from "./geometry";
import type { CanvasDoc, CanvasEdge, CanvasSide } from "./types";
import type { DraftEdge } from "./pointerMode";

export interface ResolvedEdge {
  edge: CanvasEdge;
  fromPt: { x: number; y: number };
  toPt: { x: number; y: number };
  fromSide: CanvasSide;
  toSide: CanvasSide;
  path: string;
  mid: { x: number; y: number };
}

export function resolveEdges(doc: CanvasDoc): ResolvedEdge[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  const out: ResolvedEdge[] = [];
  for (const edge of doc.edges) {
    const from = byId.get(edge.fromNode);
    const to = byId.get(edge.toNode);
    if (!from || !to) continue;
    const { fromSide, toSide } =
      edge.fromSide && edge.toSide
        ? { fromSide: edge.fromSide, toSide: edge.toSide }
        : autoSides(from, to);
    const fromPt = anchorPoint(from, fromSide);
    const toPt = anchorPoint(to, toSide);
    out.push({
      edge,
      fromPt,
      toPt,
      fromSide,
      toSide,
      path: bezierPath(fromPt, fromSide, toPt, toSide),
      mid: bezierMidpoint(fromPt, fromSide, toPt, toSide),
    });
  }
  return out;
}

/**
 * Side opposite to `side` — the natural entry/exit pair for a smooth
 * draft curve when the cursor is in free space.
 */
export function oppositeSide(side: CanvasSide): CanvasSide {
  switch (side) {
    case "left":
      return "right";
    case "right":
      return "left";
    case "top":
      return "bottom";
    case "bottom":
      return "top";
  }
}

export function draftPath(doc: CanvasDoc, draft: DraftEdge | null): string | null {
  if (!draft) return null;
  const from = doc.nodes.find((n) => n.id === draft.fromNodeId);
  if (!from) return null;
  const fromPt = anchorPoint(from, draft.fromSide);
  if (draft.targetNodeId && draft.targetSide) {
    const to = doc.nodes.find((n) => n.id === draft.targetNodeId);
    if (to) {
      const toPt = anchorPoint(to, draft.targetSide);
      return bezierPath(fromPt, draft.fromSide, toPt, draft.targetSide);
    }
  }
  return bezierPath(
    fromPt,
    draft.fromSide,
    { x: draft.currentX, y: draft.currentY },
    oppositeSide(draft.fromSide),
  );
}
