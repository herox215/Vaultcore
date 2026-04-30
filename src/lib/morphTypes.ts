// Shared types for the tab-morph effect (#380, #383).
//
// `ViewSnapshot` is consumed by `TabMorphOverlay.svelte` and produced by
// per-tab-type snapshot helpers — `snapshotView` for CM6 (text) tabs in
// `src/lib/editor/tabMorph.ts`, `snapshotCanvas` for canvas tabs in
// `src/lib/canvas/canvasTabMorph.ts`. Living in a top-level `lib/` module
// keeps the canvas helper from importing across the canvas → editor module
// boundary.

/** A single character at a known viewport pixel position. */
export interface GlyphRef {
  ch: string;
  x: number;
  y: number;
}

/**
 * Card-shaped region inside a snapshot — used by canvas snapshots to
 * include the visible node frames (text cards, file cards, link cards,
 * group rectangles) in the morph so the dialogs/areas scramble too,
 * not just their text. Text-editor snapshots leave this empty.
 */
export interface FrameRef {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Visual shape — picked up by the overlay renderer. */
  shape: "rectangle" | "rounded-rectangle" | "ellipse" | "diamond" | "triangle";
  /** Optional fill (group background). `null`/missing = no fill, just outline. */
  fill?: string | null;
  /** Outline alpha at lock-in [0..1]. Default 1. Used to soften groups. */
  strokeAlpha?: number;
}

/** Snapshot of the visible glyphs for one editor surface. */
export interface ViewSnapshot {
  glyphs: GlyphRef[];
  /** Optional card / region frames — canvas snapshots populate this so
   *  dialogs and group areas scramble alongside their text. */
  frames?: FrameRef[];
  /** Line height in CSS pixels — used by the renderer to align baselines. */
  lineHeight: number;
  /** Font shorthand suitable for `ctx.font`. */
  font: string;
  /** Color resolved from the surface's `--color-text` (or computed `color`). */
  color: string;
  /** Pixel rect of the surface's scroller, viewport-relative. */
  scrollerRect: { x: number; y: number; width: number; height: number };
}
