// Obsidian-compatible Canvas document model (issue #71, phase 1).
// Spec reference: https://jsoncanvas.org/spec/1.0/
//
// Each node / edge preserves unknown fields verbatim via the `extra` bag so
// VaultCore never drops data it does not understand — opening an Obsidian
// canvas, editing one text card, and saving must roundtrip every other
// field the producer wrote (colors, styleAttributes, future fields, …).

/** Side a connector can dock to on a node's bounding rect. */
export type CanvasSide = "top" | "right" | "bottom" | "left";

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
