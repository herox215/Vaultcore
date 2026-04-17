// Parse / serialize Obsidian-compatible `.canvas` files (issue #71, phase 1).
//
// Roundtrip rules:
//  - Unknown node / edge / top-level fields are captured into an `extra` bag
//    and restored verbatim on serialize.
//  - Output is pretty-printed JSON with tab indentation — matches Obsidian's
//    on-disk format so vaults diffed via git stay stable across editors.
//  - An empty canvas serializes to `{ "nodes": [], "edges": [] }`.

import type {
  CanvasDoc,
  CanvasEdge,
  CanvasFileNode,
  CanvasGroupNode,
  CanvasLinkNode,
  CanvasNode,
  CanvasSide,
  CanvasTextNode,
  CanvasUnknownNode,
} from "./types";

const KNOWN_NODE_KEYS = new Set([
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "color",
  // text
  "text",
  // file
  "file",
  "subpath",
  // link
  "url",
  // group
  "label",
  "background",
  "backgroundStyle",
]);

const KNOWN_EDGE_KEYS = new Set([
  "id",
  "fromNode",
  "toNode",
  "fromSide",
  "toSide",
  "fromEnd",
  "toEnd",
  "color",
  "label",
]);

const KNOWN_DOC_KEYS = new Set(["nodes", "edges"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickExtra(
  raw: Record<string, unknown>,
  known: Set<string>,
): Record<string, unknown> | undefined {
  let extra: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) {
      if (!extra) extra = {};
      extra[k] = v;
    }
  }
  return extra;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asSide(v: unknown): CanvasSide | undefined {
  return v === "top" || v === "right" || v === "bottom" || v === "left"
    ? v
    : undefined;
}

function parseNode(raw: unknown): CanvasNode | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const type = asString(raw.type);
  if (!id || !type) return null;
  const base = {
    id,
    x: asNumber(raw.x, 0),
    y: asNumber(raw.y, 0),
    width: asNumber(raw.width, 250),
    height: asNumber(raw.height, 60),
    ...(typeof raw.color === "string" ? { color: raw.color } : {}),
  };
  const extraMaybe = pickExtra(raw, KNOWN_NODE_KEYS);
  const extra = extraMaybe ? { extra: extraMaybe } : {};
  switch (type) {
    case "text": {
      const node: CanvasTextNode = {
        ...base,
        type: "text",
        text: asString(raw.text),
        ...extra,
      };
      return node;
    }
    case "file": {
      const node: CanvasFileNode = {
        ...base,
        type: "file",
        file: asString(raw.file),
        ...(typeof raw.subpath === "string" ? { subpath: raw.subpath } : {}),
        ...extra,
      };
      return node;
    }
    case "link": {
      const node: CanvasLinkNode = {
        ...base,
        type: "link",
        url: asString(raw.url),
        ...extra,
      };
      return node;
    }
    case "group": {
      const node: CanvasGroupNode = {
        ...base,
        type: "group",
        ...(typeof raw.label === "string" ? { label: raw.label } : {}),
        ...(typeof raw.background === "string"
          ? { background: raw.background }
          : {}),
        ...(typeof raw.backgroundStyle === "string"
          ? { backgroundStyle: raw.backgroundStyle }
          : {}),
        ...extra,
      };
      return node;
    }
    default: {
      const node: CanvasUnknownNode = {
        ...base,
        type,
        ...extra,
      };
      return node;
    }
  }
}

function parseEdge(raw: unknown): CanvasEdge | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const fromNode = asString(raw.fromNode);
  const toNode = asString(raw.toNode);
  if (!id || !fromNode || !toNode) return null;
  const extraMaybe = pickExtra(raw, KNOWN_EDGE_KEYS);
  const asEnd = (v: unknown): "none" | "arrow" | undefined =>
    v === "none" || v === "arrow" ? v : undefined;
  const fromSide = asSide(raw.fromSide);
  const toSide = asSide(raw.toSide);
  const fromEnd = asEnd(raw.fromEnd);
  const toEnd = asEnd(raw.toEnd);
  return {
    id,
    fromNode,
    toNode,
    ...(fromSide !== undefined ? { fromSide } : {}),
    ...(toSide !== undefined ? { toSide } : {}),
    ...(fromEnd !== undefined ? { fromEnd } : {}),
    ...(toEnd !== undefined ? { toEnd } : {}),
    ...(typeof raw.color === "string" ? { color: raw.color } : {}),
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    ...(extraMaybe ? { extra: extraMaybe } : {}),
  };
}

/**
 * Parse a `.canvas` file body. Empty / whitespace-only bodies become an
 * empty doc so a freshly created file opens without an error. Malformed
 * JSON throws — the caller should surface a toast and refuse to open.
 */
export function parseCanvas(text: string): CanvasDoc {
  const trimmed = text.trim();
  if (!trimmed) return { nodes: [], edges: [] };
  const raw = JSON.parse(trimmed);
  if (!isObject(raw)) return { nodes: [], edges: [] };
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map(parseNode).filter((n): n is CanvasNode => n !== null)
    : [];
  const edges = Array.isArray(raw.edges)
    ? raw.edges.map(parseEdge).filter((e): e is CanvasEdge => e !== null)
    : [];
  const extra = pickExtra(raw, KNOWN_DOC_KEYS);
  return { nodes, edges, ...(extra ? { extra } : {}) };
}

function serializeNode(n: CanvasNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: n.id,
    type: n.type,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
  };
  if (n.color !== undefined) out.color = n.color;
  if (n.type === "text") {
    out.text = (n as CanvasTextNode).text;
  } else if (n.type === "file") {
    const fn = n as CanvasFileNode;
    out.file = fn.file;
    if (fn.subpath !== undefined) out.subpath = fn.subpath;
  } else if (n.type === "link") {
    out.url = (n as CanvasLinkNode).url;
  } else if (n.type === "group") {
    const gn = n as CanvasGroupNode;
    if (gn.label !== undefined) out.label = gn.label;
    if (gn.background !== undefined) out.background = gn.background;
    if (gn.backgroundStyle !== undefined) out.backgroundStyle = gn.backgroundStyle;
  }
  if (n.extra) {
    for (const [k, v] of Object.entries(n.extra)) {
      if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

function serializeEdge(e: CanvasEdge): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: e.id,
    fromNode: e.fromNode,
    toNode: e.toNode,
  };
  if (e.fromSide !== undefined) out.fromSide = e.fromSide;
  if (e.toSide !== undefined) out.toSide = e.toSide;
  if (e.fromEnd !== undefined) out.fromEnd = e.fromEnd;
  if (e.toEnd !== undefined) out.toEnd = e.toEnd;
  if (e.color !== undefined) out.color = e.color;
  if (e.label !== undefined) out.label = e.label;
  if (e.extra) {
    for (const [k, v] of Object.entries(e.extra)) {
      if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

/**
 * Serialize to Obsidian-compatible JSON. Uses tab indentation to match the
 * on-disk format Obsidian writes so git diffs stay stable.
 */
export function serializeCanvas(doc: CanvasDoc): string {
  const out: Record<string, unknown> = {
    nodes: doc.nodes.map(serializeNode),
    edges: doc.edges.map(serializeEdge),
  };
  if (doc.extra) {
    for (const [k, v] of Object.entries(doc.extra)) {
      if (!(k in out)) out[k] = v;
    }
  }
  return JSON.stringify(out, null, "\t");
}

/** Empty doc used when the caller needs a blank canvas. */
export function emptyCanvas(): CanvasDoc {
  return { nodes: [], edges: [] };
}
