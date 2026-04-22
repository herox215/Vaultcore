// Outgoing wiki-link extractor used by the right-sidebar OutgoingLinksPanel.
//
// Parses `[[target]]` and `[[target|alias]]` occurrences out of Markdown text
// and returns a deduplicated list. Duplication rule matches Obsidian parity:
// two links are considered the same outgoing entry when they resolve to the
// same vault-relative path (for resolved links) or share the same normalized
// target stem (for unresolved links). Aliases encountered along the way are
// collected so the panel can surface them as secondary labels if needed.
//
// This mirrors the parse regex in `components/Editor/wikiLink.ts` so the
// sidebar stays in sync with CM6 decorations on each keystroke — the two
// parsers MUST agree on what counts as a wiki-link.
//
// Template-body skip (#330): wiki-link text inside `{{ ... }}` is template
// source code, not Markdown, so it must NOT surface as an outgoing link
// (e.g. `{{ "[[" + f.name + "]]" }}` would otherwise emit a bogus entry
// named `" + f.name + "`). We compute template ranges once per call and
// skip any match whose span overlaps one — mirroring the guard used by
// the CM6 wikiLink plugin at `components/Editor/wikiLink.ts`.
//
// We do NOT pre-strip `{{ ... }}` bodies from the text, even though the
// `stripTemplateExpressions` helper exists: (1) a multi-line template
// contains newlines, so stripping would shift `lineNumber` for any real
// link that follows it; (2) stripping could concatenate text across a
// removed span and synthesise a new spurious `[[...]]` match that
// straddles the seam (e.g. `[[A{{x}}B]]` → `[[AB]]`). Skip-by-range
// dodges both hazards.

import {
  findTemplateExprRanges,
  isInsideTemplateExpr,
} from "./templateExprRanges";

/** Matches [[target]] and [[target|alias]]. Global flag — reset lastIndex before use. */
const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

/** A single deduplicated outgoing wiki-link ready for the sidebar list. */
export interface OutgoingLink {
  /** Raw target stem as authored, stripped of any `.md` suffix. */
  target: string;
  /** Vault-relative path the link resolves to, or `null` if unresolved. */
  resolvedPath: string | null;
  /** Label used for deduplication (lowercased resolved path, or lowercased stem). */
  key: string;
  /** All distinct aliases (`[[target|alias]]`) seen for this target, in order of first appearance. */
  aliases: string[];
  /** 0-based line number of the FIRST occurrence (for stable ordering). */
  lineNumber: number;
}

function stripMdSuffix(target: string): string {
  return target.endsWith(".md") ? target.slice(0, -3) : target;
}

/**
 * Extract outgoing wiki-links from `text`, deduplicated in document order.
 *
 * @param text        Raw document text.
 * @param resolve     Function that maps a raw target stem to a vault-relative
 *                    path (or `null` if unresolved). Normally wired to
 *                    `resolveTarget` from `components/Editor/wikiLink.ts`.
 * @returns Unique outgoing links, ordered by first occurrence.
 */
export function extractOutgoingLinks(
  text: string,
  resolve: (target: string) => string | null,
): OutgoingLink[] {
  const seen = new Map<string, OutgoingLink>();

  // Template ranges computed once — every match is checked against them so
  // `[[...]]` fragments inside `{{ ... }}` template source don't leak into
  // the sidebar (#330).
  const templateRanges = findTemplateExprRanges(text);

  // Reset lastIndex — the regex is global and shared across calls.
  WIKI_LINK_RE.lastIndex = 0;

  // Track line numbers by counting newlines up to each match — avoids splitting
  // the whole document for large files.
  let lineNumber = 0;
  let lastLineStart = 0;

  let match: RegExpExecArray | null;
  while ((match = WIKI_LINK_RE.exec(text)) !== null) {
    const rawTarget = match[1];
    if (rawTarget === undefined) continue;

    // Skip matches whose span overlaps a template expression body.
    if (isInsideTemplateExpr(templateRanges, match.index, WIKI_LINK_RE.lastIndex)) {
      continue;
    }

    // Advance line counter to this match's position.
    while (true) {
      const next = text.indexOf("\n", lastLineStart);
      if (next === -1 || next >= match.index) break;
      lineNumber += 1;
      lastLineStart = next + 1;
    }

    const stem = stripMdSuffix(rawTarget).trim();
    if (stem.length === 0) continue;

    const resolvedPath = resolve(stem);
    const key = (resolvedPath ?? stem).toLowerCase();
    const alias = match[2];

    const existing = seen.get(key);
    if (existing) {
      if (alias !== undefined && alias.length > 0 && !existing.aliases.includes(alias)) {
        existing.aliases.push(alias);
      }
      continue;
    }

    seen.set(key, {
      target: stem,
      resolvedPath,
      key,
      aliases: alias !== undefined && alias.length > 0 ? [alias] : [],
      lineNumber,
    });
  }

  return Array.from(seen.values());
}
