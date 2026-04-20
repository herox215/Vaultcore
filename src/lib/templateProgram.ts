// Multi-segment `{{ ... ; ... }}` template programs (#303).
//
// A `{{ ... }}` body is split on top-level `;` into N independent segments.
// Each segment is parsed + evaluated independently and the rendered results
// are concatenated into the widget text. Per-segment errors are swallowed
// the same way `templateLivePreview` swallows whole-body errors today:
// a broken segment renders as empty, neighbours keep working.
//
// The splitter mirrors the tokenizer's string-literal state machine so that
// `;` inside `"..."` or `'...'` (including escaped quotes via `\"`) does
// NOT split. It also tracks paren depth so `;` inside a call arg list
// doesn't split either. Backticks have no special meaning in the
// expression language, so `` `a;b` `` splits on the inner `;` — that keeps
// the splitter aligned with the tokenizer.

import { evaluate, renderValue, type EvalScope } from "./templateExpression";

/**
 * Split a program body on top-level `;`. String literals and parenthesised
 * groups protect their contents from splitting. An unterminated string
 * consumes the rest of the input — the tokenizer will throw on that
 * segment later, which `evaluateProgram` swallows.
 */
export function splitSegments(src: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  let paren = 0;
  let inString: '"' | "'" | null = null;

  while (i < src.length) {
    const c = src[i]!;
    if (inString !== null) {
      if (c === "\\") {
        // Skip the escape and the next character (if any). A trailing `\`
        // at end of input is a no-op — we just advance past it.
        i += 2;
        continue;
      }
      if (c === inString) {
        inString = null;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      i++;
      continue;
    }
    if (c === "(") {
      paren++;
      i++;
      continue;
    }
    if (c === ")") {
      if (paren > 0) paren--;
      i++;
      continue;
    }
    if (c === ";" && paren === 0) {
      out.push(src.slice(start, i));
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  out.push(src.slice(start));
  return out;
}

/**
 * Evaluate each segment and concatenate the rendered string results. Errors
 * in individual segments are swallowed (rendered as empty), matching the
 * live-preview engine's "drop silently" strategy.
 *
 * Note on the ops budget: each segment gets a fresh budget via `evaluate`.
 * For MVP this is acceptable — N segments × 10k ops each → 10k·N worst
 * case. Users authoring pathological chains hit a natural ceiling at the
 * `{{ ... }}` block size anyway.
 */
export function evaluateProgram(src: string, scope: EvalScope): string {
  const segments = splitSegments(src);
  let out = "";
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed === "") continue;
    try {
      out += renderValue(evaluate(trimmed, scope));
    } catch {
      // Per-segment error: swallow and keep going so neighbours still
      // render. The decoration is dropped only when EVERY segment fails
      // (detected by the caller via `out === ""` + no non-empty segments).
    }
  }
  return out;
}

export interface SegmentCursor {
  segment: string;
  /** Character offset within `segment` where the cursor sits. */
  offsetInSegment: number;
  /** Column of the segment's first character within the original body. */
  segmentStart: number;
}

/**
 * Find the segment containing the cursor. When the cursor sits exactly on
 * a splitting `;`, it belongs to the RIGHT segment (offset 0) — which is
 * what the autocomplete popup wants: after typing `;`, the user is
 * authoring the new segment.
 */
export function segmentContainingCursor(
  src: string,
  cursor: number,
): SegmentCursor {
  const segments = splitSegments(src);
  let start = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const end = start + seg.length;
    const isLast = i === segments.length - 1;
    // Non-last segment: cursor sitting on the trailing `;` (cursor === end)
    // belongs to the NEXT segment at offset 0 — after typing `;` the user
    // is authoring the new (right) segment, not the old (left) one.
    if (cursor < end || (isLast && cursor <= end)) {
      return {
        segment: seg,
        offsetInSegment: cursor - start,
        segmentStart: start,
      };
    }
    if (!isLast && cursor === end) {
      const next = segments[i + 1]!;
      return {
        segment: next,
        offsetInSegment: 0,
        segmentStart: end + 1,
      };
    }
    start = end + 1;
  }
  const last = segments[segments.length - 1] ?? "";
  const lastStart = src.length - last.length;
  return {
    segment: last,
    offsetInSegment: Math.max(0, cursor - lastStart),
    segmentStart: lastStart,
  };
}
