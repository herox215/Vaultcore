// Canvas-tab snapshot for the tab-morph effect (#383).
//
// Produces a `ViewSnapshot` from a canvas viewport so `TabMorphOverlay`
// can morph canvas↔text and canvas↔canvas tab switches with the same
// 120ms char-scramble pipeline used for text↔text in #380.
//
// Strategy (b) from the ticket: walk text-bearing nodes (text body /
// link URL / file basename / group label) and project each character to
// a viewport pixel position via the canvas camera transform. Bounded by
// `MAX_GLYPHS` so a dense canvas can't push us off the keystroke-latency
// budget. This is a deliberate approximation — glyph positions don't
// match the rendered cards' wrapped layout exactly. For a 120ms cue this
// is fine; the user sees the real canvas the moment the morph ends.
//
// Edges and image content are intentionally omitted: edges have no
// readable text and rasterizing images would blow the budget.

import type {
  CanvasDoc,
  CanvasFileNode,
  CanvasGroupNode,
  CanvasLinkNode,
  CanvasNode,
  CanvasTextNode,
} from "./types";
import type { ViewSnapshot, GlyphRef } from "../morphTypes";

/** Bail-out cap for the glyph walk. Off-screen nodes are culled BEFORE
 * being added, so this only kicks in for genuinely dense visible canvases. */
const MAX_GLYPHS = 1500;

/**
 * Extract the single text string a node contributes to the morph snapshot.
 * Returns `null` for node kinds with nothing readable (image-only file
 * nodes that point at non-markdown files still return their basename;
 * that's intentional — the basename is the visible card text).
 */
function nodeText(node: CanvasNode): string | null {
  // The CanvasUnknownNode variant has `type: string`, which overlaps the
  // literal types and degrades discriminated-union narrowing. Cast inside
  // each branch — same pattern as `readShape` in `./types.ts`.
  switch (node.type) {
    case "text":
      return (node as CanvasTextNode).text || null;
    case "link":
      return (node as CanvasLinkNode).url || null;
    case "file": {
      const file = (node as CanvasFileNode).file;
      if (!file) return null;
      const slash = file.lastIndexOf("/");
      return slash >= 0 ? file.slice(slash + 1) : file;
    }
    case "group":
      return (node as CanvasGroupNode).label || null;
    default:
      return null;
  }
}

/**
 * Snapshot the text content of a canvas viewport into a `ViewSnapshot`.
 *
 * Returns `null` when there's nothing to morph from — the overlay treats
 * null and empty `glyphs` as bypass-and-instant-swap, so this is the
 * caller-friendly way to opt out without a separate "should we morph?"
 * branch.
 *
 * Coordinates are projected as `vx = node.x * zoom + camX + cellX`, which
 * matches `CanvasView.svelte`'s `clientToWorld` inverse: world-coords get
 * transformed into viewport-local pixels, then offset by the viewport's
 * scroller rect at the consumption site (the overlay positions itself
 * absolute inset:0 within `.vc-editor-content`, so viewport-local is what
 * we want).
 */
export function snapshotCanvas(
  viewportEl: HTMLElement,
  doc: CanvasDoc,
  camX: number,
  camY: number,
  zoom: number,
  maxGlyphs: number = MAX_GLYPHS,
): ViewSnapshot | null {
  if (!viewportEl || !viewportEl.isConnected) return null;
  // Defensive: the camera zoom is clamped in CanvasView.svelte (MIN_ZOOM = 0.15)
  // but a not-yet-mounted state could in principle leak a zero. Bail rather
  // than divide-by-zero or stack every glyph at one pixel.
  if (!Number.isFinite(zoom) || zoom <= 0) return null;

  const rect = viewportEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const cs = typeof window !== "undefined" ? window.getComputedStyle(viewportEl) : null;
  const fontSize = cs ? parseFloat(cs.fontSize) || 14 : 14;
  const lineHeight = cs ? parseFloat(cs.lineHeight) || fontSize * 1.4 : fontSize * 1.4;
  const fontFamily = cs?.fontFamily ?? "sans-serif";
  const fontWeight = cs?.fontWeight ?? "400";
  const font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const color = cs?.color || "#000";

  // Approximate monospace cell width — close enough to lay glyphs out
  // along a node's top edge without doing real font-metric measurement
  // on every snapshot.
  const cellW = fontSize * 0.6;
  const lineH = lineHeight;

  const glyphs: GlyphRef[] = [];

  outer: for (const node of doc.nodes) {
    if (glyphs.length >= maxGlyphs) break;

    const text = nodeText(node);
    if (!text) continue;

    const vx0 = node.x * zoom + camX;
    const vy0 = node.y * zoom + camY;
    const vw = Math.max(0, node.width * zoom);
    const vh = Math.max(0, node.height * zoom);

    // Cull entirely off-screen nodes BEFORE walking their text. This is
    // what keeps `MAX_GLYPHS` from hiding pan/zoom regressions: a 100k-node
    // vault with one node visible still costs O(visible-text), not O(all-text).
    if (vx0 + vw < 0 || vy0 + vh < 0 || vx0 > rect.width || vy0 > rect.height) {
      continue;
    }

    const colsPerLine = Math.max(1, Math.floor(vw / cellW));
    const maxLines = Math.max(1, Math.floor(vh / lineH));

    let col = 0;
    let line = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (ch === "\n") {
        col = 0;
        line += 1;
        if (line >= maxLines) break;
        continue;
      }
      if (col >= colsPerLine) {
        col = 0;
        line += 1;
        if (line >= maxLines) break;
      }
      // Skip whitespace at the start of a wrapped line for a slightly
      // tighter visual — purely cosmetic, costs one branch per char.
      if (col === 0 && ch === " ") continue;
      glyphs.push({
        ch,
        x: vx0 + col * cellW,
        y: vy0 + line * lineH,
      });
      col += 1;
      if (glyphs.length >= maxGlyphs) break outer;
    }
  }

  if (glyphs.length === 0) return null;

  return {
    glyphs,
    lineHeight,
    font,
    color,
    scrollerRect: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
  };
}
