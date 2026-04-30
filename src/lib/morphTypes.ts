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

/** Snapshot of the visible glyphs for one editor surface. */
export interface ViewSnapshot {
  glyphs: GlyphRef[];
  /** Line height in CSS pixels — used by the renderer to align baselines. */
  lineHeight: number;
  /** Font shorthand suitable for `ctx.font`. */
  font: string;
  /** Color resolved from the surface's `--color-text` (or computed `color`). */
  color: string;
  /** Pixel rect of the surface's scroller, viewport-relative. */
  scrollerRect: { x: number; y: number; width: number; height: number };
}
