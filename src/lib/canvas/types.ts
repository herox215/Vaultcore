// Obsidian-compatible Canvas document model (issue #71, phase 1).
// Spec reference: https://jsoncanvas.org/spec/1.0/
//
// Each node / edge preserves unknown fields verbatim via the `extra` bag so
// VaultCore never drops data it does not understand — opening an Obsidian
// canvas, editing one text card, and saving must roundtrip every other
// field the producer wrote (colors, styleAttributes, future fields, …).

/** Side a connector can dock to on a node's bounding rect. */
export type CanvasSide = "top" | "right" | "bottom" | "left";

/**
 * Visual shape of a text node (#362). VaultCore extension — Obsidian
 * ignores the field on load and round-trips through our canonical
 * serializer unchanged. `rounded-rectangle` is the default and matches
 * the pre-#362 visual (border-radius: 6px); nodes without a `shape` field
 * on disk render as `rounded-rectangle` for zero visual regression.
 */
export type CanvasShape =
  | "rounded-rectangle"
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "triangle";

/** Ordered list driving the shape-picker UI. */
export const CANVAS_SHAPES: readonly CanvasShape[] = [
  "rounded-rectangle",
  "rectangle",
  "ellipse",
  "diamond",
  "triangle",
];

export const DEFAULT_CANVAS_SHAPE: CanvasShape = "rounded-rectangle";

export function isCanvasShape(v: unknown): v is CanvasShape {
  return (
    v === "rounded-rectangle" ||
    v === "rectangle" ||
    v === "ellipse" ||
    v === "diamond" ||
    v === "triangle"
  );
}

export interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  /** Unknown fields passed through unchanged on save. */
  extra?: Record<string, unknown>;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: "text";
  text: string;
  /** #362: visual shape. `undefined` renders as {@link DEFAULT_CANVAS_SHAPE}. */
  shape?: CanvasShape;
}

/**
 * Resolve a node's effective visual shape. Only text nodes carry a shape;
 * every other node type returns the default. Called by the renderer per
 * frame and by geometry helpers — keep O(1) pure.
 */
export function readShape(node: CanvasNode): CanvasShape {
  // CanvasUnknownNode's `type` field is `string`, so TS can't narrow
  // away the unknown branch on the discriminator alone — we check for
  // the `shape` field's presence on a typed text node via the cast.
  if (node.type === "text") {
    const shape = (node as CanvasTextNode).shape;
    if (shape) return shape;
  }
  return DEFAULT_CANVAS_SHAPE;
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: "file";
  file: string;
  subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: "link";
  url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: string;
}

/**
 * A node we parsed but do not render yet. Phase 1 only renders "text";
 * other types round-trip through this variant so saves do not destroy them.
 */
export interface CanvasUnknownNode extends CanvasNodeBase {
  type: string;
}

export type CanvasNode =
  | CanvasTextNode
  | CanvasFileNode
  | CanvasLinkNode
  | CanvasGroupNode
  | CanvasUnknownNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  fromEnd?: "none" | "arrow";
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
  /** Unknown fields passed through unchanged on save. */
  extra?: Record<string, unknown>;
}

export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Top-level unknown fields passed through unchanged on save. */
  extra?: Record<string, unknown>;
}

/** Default width / height applied when a node omits the field. Matches Obsidian. */
export const DEFAULT_NODE_WIDTH = 250;
export const DEFAULT_NODE_HEIGHT = 60;
