// Shared helper for locating `{{ ... }}` template expression ranges in editor
// text, plus an overlap check consulted by every inline decoration plugin
// (wikiLink, embedPlugin, livePreview, inlineHtml).
//
// Rule (#295): content inside a `{{ ... }}` range is template source code, not
// Markdown — no inline renderer other than the template live-preview itself
// and the autocomplete provider should decorate it.
//
// The regex mirrors the one used by `templateSubstitution.ts` and
// `templateLivePreview.ts`: single-line OR multi-line bodies are fine so long
// as they contain no `{` or `}` characters. If all three call-sites ever need
// to diverge, promote the regex into a shared constant — until then, keeping
// them textually identical is the simplest guarantee.

const EXPR_RE = /\{\{([^{}]+?)\}\}/g;

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
  EXPR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPR_RE.exec(text)) !== null) {
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
