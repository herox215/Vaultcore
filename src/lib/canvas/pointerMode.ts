// Canvas pointer-mode state machine (#71, extracted for #133).
//
// The viewer mixes four distinct drag gestures on a single set of pointer
// events: panning the world, moving a node, resizing a node, and drawing an
// edge. Each gesture has its own snapshot of where-we-started and a pure
// delta computation for where-we-are-now. Keeping that in the component
// wrapped the state machine in reactive-state mutations, which made the
// arithmetic untestable and the .svelte file hard to follow.
//
// This module owns the types and the pure math; the component still owns
// the reactive state and applies the computed positions/sizes to it. Callers
// pass in only the event coords and the zoom factor they already have in
// hand, so nothing here depends on Svelte runes or the DOM.
//
// Minimum dimensions for resize are enforced here so the lower bound is
// defined once and can't drift between the arithmetic and the UI.
//
// The edge-draft object (target-side tracking while dragging from a handle)
// is updated by `updateDraftOnMove`; the pure helper means tests can verify
// the "snap when over a different node's handle, otherwise track cursor"
// rule without wiring up a live DOM.

import type { CanvasNode, CanvasSide } from "./types";

export const MIN_NODE_WIDTH = 80;
export const MIN_NODE_HEIGHT = 40;

export type PointerMode =
  | {
      kind: "pan";
      startClientX: number;
      startClientY: number;
      startCamX: number;
      startCamY: number;
    }
  | {
      kind: "move";
      nodeId: string;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
    }
  | {
      kind: "resize";
      nodeId: string;
      startClientX: number;
      startClientY: number;
      startW: number;
      startH: number;
    }
  | { kind: "edge"; fromNodeId: string; fromSide: CanvasSide };

export interface ClientPoint {
  clientX: number;
  clientY: number;
}

export interface DraftEdge {
  fromNodeId: string;
  fromSide: CanvasSide;
  currentX: number;
  currentY: number;
  targetNodeId: string | null;
  targetSide: CanvasSide | null;
}

export interface HandleHit {
  nodeId: string;
  side: CanvasSide;
}

// ── factories ──────────────────────────────────────────────────────────────

export function beginPan(e: ClientPoint, cam: { x: number; y: number }): PointerMode {
  return {
    kind: "pan",
    startClientX: e.clientX,
    startClientY: e.clientY,
    startCamX: cam.x,
    startCamY: cam.y,
  };
}

export function beginMove(node: CanvasNode, e: ClientPoint): PointerMode {
  return {
    kind: "move",
    nodeId: node.id,
    startClientX: e.clientX,
    startClientY: e.clientY,
    startX: node.x,
    startY: node.y,
  };
}

export function beginResize(node: CanvasNode, e: ClientPoint): PointerMode {
  return {
    kind: "resize",
    nodeId: node.id,
    startClientX: e.clientX,
    startClientY: e.clientY,
    startW: node.width,
    startH: node.height,
  };
}

export function beginEdge(nodeId: string, side: CanvasSide): PointerMode {
  return { kind: "edge", fromNodeId: nodeId, fromSide: side };
}

// ── move handlers (pure delta → position / size) ───────────────────────────

export function panPosition(
  mode: Extract<PointerMode, { kind: "pan" }>,
  e: ClientPoint,
): { camX: number; camY: number } {
  return {
    camX: mode.startCamX + (e.clientX - mode.startClientX),
    camY: mode.startCamY + (e.clientY - mode.startClientY),
  };
}

export function movePosition(
  mode: Extract<PointerMode, { kind: "move" }>,
  e: ClientPoint,
  zoom: number,
): { x: number; y: number } {
  return {
    x: mode.startX + (e.clientX - mode.startClientX) / zoom,
    y: mode.startY + (e.clientY - mode.startClientY) / zoom,
  };
}

export function resizeSize(
  mode: Extract<PointerMode, { kind: "resize" }>,
  e: ClientPoint,
  zoom: number,
): { width: number; height: number } {
  return {
    width: Math.max(MIN_NODE_WIDTH, mode.startW + (e.clientX - mode.startClientX) / zoom),
    height: Math.max(MIN_NODE_HEIGHT, mode.startH + (e.clientY - mode.startClientY) / zoom),
  };
}

// ── edge draft ─────────────────────────────────────────────────────────────

/**
 * Produce the next DraftEdge state given the current cursor position (in
 * world coords) and whether the pointer is currently over a handle. The
 * commit rule in onUp checks `targetNodeId !== null`, so we only populate
 * the snap fields when `hit` belongs to a *different* node than the
 * drag origin — self-loops are not allowed.
 */
export function updateDraftOnMove(
  draft: DraftEdge,
  world: { x: number; y: number },
  hit: HandleHit | null,
): DraftEdge {
  const snap = hit && hit.nodeId !== draft.fromNodeId ? hit : null;
  return {
    ...draft,
    currentX: world.x,
    currentY: world.y,
    targetNodeId: snap ? snap.nodeId : null,
    targetSide: snap ? snap.side : null,
  };
}

// ── commit decision ────────────────────────────────────────────────────────

export type PointerUpAction =
  | { kind: "none" }
  | {
      kind: "commit-edge";
      fromId: string;
      fromSide: CanvasSide;
      toId: string;
      toSide: CanvasSide;
    };

/**
 * On pointer-up, the edge mode decides whether to commit based on whether
 * the draft snapped to a valid target handle. All other modes are pure
 * cleanup — the component clears `pointerMode` to null either way.
 */
export function resolvePointerUp(
  mode: PointerMode,
  draft: DraftEdge | null,
): PointerUpAction {
  if (mode.kind !== "edge" || !draft) return { kind: "none" };
  if (!draft.targetNodeId || !draft.targetSide) return { kind: "none" };
  return {
    kind: "commit-edge",
    fromId: draft.fromNodeId,
    fromSide: draft.fromSide,
    toId: draft.targetNodeId,
    toSide: draft.targetSide,
  };
}
