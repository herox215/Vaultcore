// Locator for `{{ ... }}` template expression ranges + an overlap check.
//
// Consumers:
// - Inline CM6 decorations (wikiLink, embedPlugin, livePreview, inlineHtml)
//   skip rendering anything that overlaps a template body (#295): content
//   inside `{{ ... }}` is template source code, not Markdown.
// - `lib/outgoingLinks.ts` uses the same guard so the right-sidebar
//   Outgoing Links panel never surfaces `[[...]]` string fragments that
//   live inside a template body (#330). Lives in `lib/` — not under the
//   Editor — so non-UI callers can import it without reaching into
//   component code.
//
// The regex comes from `templateExprRegex.ts` so all three consumers
// (the range-based skip here, the strip-based `.content` accessor in
// vaultApi, and the CM6 live-preview plugin) agree on what counts as a
// template body. See that module for the `[^{}]` rationale (no nesting;
// multi-line allowed).

import { TEMPLATE_EXPR_RE } from "./templateExprRegex";

export type TemplateExprRange = readonly [number, number];

/**
 * Scan `text` for `{{ ... }}` ranges.
 *
 * `baseOffset` is added to every returned position, so callers that pass a
 * viewport slice (e.g. `doc.sliceString(viewport.from, viewport.to)`) can
 * pass `viewport.from` and receive absolute document coordinates back.
 * Defaults to 0 for full-document scans.
 */
export function findTemplateExprRanges(
  text: string,
  baseOffset: number = 0,
): TemplateExprRange[] {
  const out: TemplateExprRange[] = [];
  TEMPLATE_EXPR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_EXPR_RE.exec(text)) !== null) {
    out.push([baseOffset + m.index, baseOffset + m.index + m[0].length]);
  }
  return out;
}

/**
 * Returns true iff the half-open interval `[from, to)` overlaps any of
 * `ranges`. Call with only `from` to probe a single position.
 *
 * Linear scan — fine in practice (a note with even a few hundred expressions
 * is an edge case). If this ever shows up in a profile, swap to a sorted
 * binary-search walk; ranges are already emitted in document order.
 */
export function isInsideTemplateExpr(
  ranges: readonly TemplateExprRange[],
  from: number,
  to: number = from,
): boolean {
  for (const [a, b] of ranges) {
    if (to > a && from < b) return true;
  }
  return false;
}
