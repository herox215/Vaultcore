// #380 — char-morph transition between text-file tabs.
//
// Pure logic for the canvas-overlay morph: snapshot extraction from a CM6
// EditorView, glyph reveal scheduling, suppression-window decision, and the
// reduced-motion gate. Side effects (canvas drawing, rAF) live in the Svelte
// component that consumes this module.
//
// All exports are pure / inputs-only so the unit tests can exercise the
// timing rules without a DOM.

import type { EditorView } from "@codemirror/view";
import type { GlyphRef, ViewSnapshot } from "../morphTypes";

export type { GlyphRef, ViewSnapshot } from "../morphTypes";

/** Hard cut at the morph duration. Overridable via the
 *  `--vc-tab-switch-duration` CSS custom property (read at trigger time
 *  by `resolveMorphDuration`); this constant is the default and the
 *  fallback used by tests / non-DOM callers. */
export const MORPH_DURATION_MS = 240;

/**
 * Resolve the morph duration from `--vc-tab-switch-duration` on the document
 * root, falling back to {@link MORPH_DURATION_MS}. Accepts `Nms` or `Ns`.
 * Returns 0 (instant) for `0`, `0ms`, or `0s` so user snippets can disable
 * the effect without flipping a JS gate.
 */
export function resolveMorphDuration(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return MORPH_DURATION_MS;
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--vc-tab-switch-duration")
    .trim();
  if (!raw) return MORPH_DURATION_MS;
  const m = raw.match(/^([0-9]*\.?[0-9]+)(ms|s)?$/);
  if (!m) return MORPH_DURATION_MS;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n) || n < 0) return MORPH_DURATION_MS;
  return m[2] === "s" ? n * 1000 : n;
}

/**
 * If a second qualifying switch arrives within this window of the previous
 * one, skip animation and swap instantly. The window guards against
 * Cmd+Shift+] cycling through many tabs in rapid succession. Sized just
 * above the morph duration so a chord cycling faster than one morph per
 * tab always falls through to the instant path.
 */
export const MORPH_SUPPRESSION_MS = 320;

/** Per-glyph entry on the morph timeline. */
export interface ScheduledGlyph {
  /** Outgoing character at this slot. Empty string = no outgoing. */
  from: string;
  /** Incoming character at this slot. Empty string = no incoming. */
  to: string;
  x: number;
  y: number;
  /** Time, in ms from morph start, at which this glyph locks onto `to`. */
  lockInMs: number;
}

/** Decide whether a tab switch should play the morph or swap instantly. */
export interface SuppressionState {
  /** Timestamp (ms) of the last morph that completed (or was cancelled). */
  lastSettledAt: number;
  /** Whether a morph is currently in flight. */
  inFlight: boolean;
}

export function newSuppressionState(): SuppressionState {
  return { lastSettledAt: -Infinity, inFlight: false };
}

export type MorphDecision = "play" | "instant";

/**
 * Decide whether the next switch should play or swap instantly. Mutates
 * `state` to record the decision so the caller doesn't have to.
 *
 * Rules (issue #380):
 *  - In-flight morph + new request → cancel + instant. Suppression timer
 *    re-anchors at `now` so subsequent switches inside the window stay
 *    instant.
 *  - No in-flight morph but `now - lastSettledAt < MORPH_SUPPRESSION_MS` →
 *    instant. Re-anchors so a chord cycle stays instant for its duration.
 *  - Otherwise → play. `inFlight` is set to true; the caller must call
 *    `markMorphSettled(state, now)` when the morph ends or is cancelled.
 */
export function decideMorph(state: SuppressionState, now: number): MorphDecision {
  if (state.inFlight) {
    state.lastSettledAt = now;
    state.inFlight = false;
    return "instant";
  }
  if (now - state.lastSettledAt < MORPH_SUPPRESSION_MS) {
    state.lastSettledAt = now;
    return "instant";
  }
  state.inFlight = true;
  return "play";
}

export function markMorphSettled(state: SuppressionState, now: number): void {
  state.inFlight = false;
  state.lastSettledAt = now;
}

/**
 * Read the prefers-reduced-motion setting. Defaults to `false` outside a
 * browser (jsdom test environment without the matchMedia stub).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Build the per-glyph schedule that the rAF renderer iterates. Slots are
 * paired by index: outgoing[i] morphs into incoming[i]. The shorter side is
 * padded with empty strings so surplus glyphs fade rather than mis-align.
 */
export function buildSchedule(
  outgoing: ViewSnapshot,
  incoming: ViewSnapshot,
  randomFn: () => number = Math.random,
  durationMs: number = MORPH_DURATION_MS,
): ScheduledGlyph[] {
  const out: ScheduledGlyph[] = [];
  const len = Math.max(outgoing.glyphs.length, incoming.glyphs.length);
  for (let i = 0; i < len; i += 1) {
    const o = outgoing.glyphs[i];
    const n = incoming.glyphs[i];
    out.push({
      from: o ? o.ch : "",
      to: n ? n.ch : "",
      x: n ? n.x : (o ? o.x : 0),
      y: n ? n.y : (o ? o.y : 0),
      lockInMs: Math.floor(randomFn() * durationMs),
    });
  }
  return out;
}

/**
 * Snapshot the visible glyphs of an EditorView. Reads the scroller rect, the
 * resolved font / line-height / color, and the visible-range text, then
 * computes per-glyph pixel positions via `view.coordsAtPos`.
 *
 * Skips folded ranges (which `view.visibleRanges` already excludes) and
 * returns an empty snapshot if the view is detached.
 */
export function snapshotView(view: EditorView): ViewSnapshot | null {
  const scrollerEl = view.scrollDOM as HTMLElement;
  const contentEl = view.contentDOM as HTMLElement;
  if (!scrollerEl || !contentEl || !scrollerEl.isConnected) return null;

  const scrollerRect = scrollerEl.getBoundingClientRect();
  const cs = window.getComputedStyle(contentEl);
  // Build a minimal canvas-parseable font shorthand: weight + size + family.
  // We deliberately drop fontStyle ("oblique 10deg" in modern UAs is a valid
  // CSS value but ctx.font silently rejects it and falls back to "10px
  // sans-serif", which would mis-size every glyph). Lifting weight + size +
  // family is enough for layout fidelity since the editor's italic/oblique
  // styling is rare in note bodies and falls back gracefully.
  const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  const color = cs.color;

  const glyphs: GlyphRef[] = [];
  for (const range of view.visibleRanges) {
    const text = view.state.doc.sliceString(range.from, range.to);
    let pos = range.from;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      // Newlines have no glyph — advance the cursor but skip the draw call.
      if (ch === "\n") { pos += 1; continue; }
      const coords = view.coordsAtPos(pos);
      if (coords) {
        glyphs.push({
          ch,
          x: coords.left - scrollerRect.left,
          y: coords.top - scrollerRect.top,
        });
      }
      pos += 1;
    }
  }
  return {
    glyphs,
    lineHeight,
    font,
    color,
    scrollerRect: {
      x: scrollerRect.left,
      y: scrollerRect.top,
      width: scrollerRect.width,
      height: scrollerRect.height,
    },
  };
}

/** Random printable ASCII glyph used to scramble pre-lock-in. */
export function randomGlyph(rand: () => number = Math.random): string {
  // Printable ASCII range minus space — visually busy enough for the morph.
  const code = 33 + Math.floor(rand() * (126 - 33));
  return String.fromCharCode(code);
}
