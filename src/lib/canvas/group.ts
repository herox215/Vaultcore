// #168 — spatial group membership. Pure helpers for deciding which nodes
// "belong" to a group at a moment in time so moving the group can drag
// its children with it (Obsidian-compatible: no persisted `parent` field,
// containment is evaluated at drag-start only).
//
// Rule: a node is inside a group iff its bounding box is *fully contained*
// by the group's bounding box. Nodes that straddle the boundary are not
// dragged. Group nodes are excluded from the membership list so nested
// groups do not cascade — this matches Obsidian and keeps the interaction
// predictable.

import type { CanvasDoc, CanvasNode } from "./types";

function rect(n: CanvasNode): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: n.x, y0: n.y, x1: n.x + n.width, y1: n.y + n.height };
}

function fullyInside(inner: CanvasNode, outer: CanvasNode): boolean {
  const i = rect(inner);
  const o = rect(outer);
  return i.x0 >= o.x0 && i.y0 >= o.y0 && i.x1 <= o.x1 && i.y1 <= o.y1;
}

/**
 * Returns every non-group node whose bounding box is fully contained by the
 * given group's bounding box. The `group` param is typed as `CanvasNode` so
 * callers can pass the narrowed leader of a drag without round-tripping
 * through a more specific variant (CanvasUnknownNode's `type: string` makes
 * strict narrowing fight the caller). Evaluation is purely geometric; nested
 * groups are intentionally excluded so cascading group-drag does not happen.
 */
export function nodesInsideGroup(doc: CanvasDoc, group: CanvasNode): CanvasNode[] {
  return doc.nodes.filter(
    (n) => n.id !== group.id && n.type !== "group" && fullyInside(n, group),
  );
}
