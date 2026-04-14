// Pure helpers for the status-bar word/character counter.
//
// Scope: compute word and character counts for a plain-text/markdown document
// or an arbitrary selection, matching Obsidian's behavior:
//   - Characters: code-point count, INCLUDING whitespace and newlines.
//   - Words: contiguous runs of letters/digits, after stripping leading
//     frontmatter and common markdown syntax tokens. See WORD_RE comment.
//
// Non-goals: a full markdown AST, CJK word-segmentation, or grapheme-cluster
// counting. A code-point count is close enough to what users expect and
// matches what Obsidian shows.

import { detectFrontmatter } from "../components/Editor/frontmatterPlugin";

/**
 * Strip the leading `---\n...\n---\n` frontmatter block (only — not any
 * `---` that appears later in the document). Falls back to the original
 * text when no frontmatter is present.
 */
export function stripLeadingFrontmatter(text: string): string {
  const region = detectFrontmatter(text);
  if (!region) return text;
  return text.slice(region.to);
}

/**
 * Remove common markdown syntax tokens so word-splitting counts content
 * rather than punctuation. Pragmatic — not a parser:
 *
 *   - Fenced code blocks (```...```) — dropped wholesale (Obsidian counts
 *     code words, but its counter is known to over/undercount; dropping
 *     is simpler and closer to what the user perceives as "text").
 *   - Inline code spans (`...`) — contents dropped.
 *   - Image/link URL portions  — drop `](url)` tails, keep link text.
 *   - HTML comments — dropped.
 *   - Leading list/heading/blockquote markers on a line.
 *   - Emphasis/strike markers *, _, ~, backticks.
 *   - Wiki-link/embed brackets  [[..]], ![[..]] — keep the target text.
 *   - Stray `[`, `]`, `(`, `)` used by links.
 */
function stripMarkdownSyntax(text: string): string {
  let out = text;

  // Fenced code blocks — greedy-enough: three backticks, anything, three
  // backticks. Multiline dot via the `[\s\S]` trick (no /s flag for wider
  // runtime compatibility).
  out = out.replace(/```[\s\S]*?```/g, " ");

  // Inline code spans — single-backtick runs on one line.
  out = out.replace(/`[^`\n]*`/g, " ");

  // HTML comments.
  out = out.replace(/<!--[\s\S]*?-->/g, " ");

  // Embeds and wiki links: ![[target|alias]] / [[target|alias]] — keep the
  // alias if present, else the target (the portion users actually see).
  out = out.replace(/!?\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_m, t, a) => a ?? t);

  // Markdown links ![alt](url) / [text](url) — keep the visible text.
  out = out.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");

  // Leading line markers: heading #, blockquote >, list bullets -/*/+, and
  // ordered-list "1." style. Applied per-line so a `*` mid-text is kept.
  out = out.replace(/^[ \t]*(?:>+[ \t]*)?(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+\.[ \t]+)/gm, "");

  // Emphasis / strong / strikethrough markers. We just drop the runs of
  // these characters — the surrounding text is preserved for word counting.
  out = out.replace(/[*_~]+/g, " ");

  // Stray bracket characters from partial/edge-case links.
  out = out.replace(/[\[\]()]+/g, " ");

  return out;
}

/**
 * A "word" is a contiguous run of Unicode letters or digits. Hyphens and
 * apostrophes inside a run keep it as one word (e.g. "don't", "well-known").
 * Regex uses Unicode property escapes (supported in all modern V8 runtimes).
 */
const WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'’\-]*[\p{L}\p{N}])?/gu;

/**
 * Count words in a markdown-ish text, ignoring leading frontmatter and
 * markdown syntax tokens.
 */
export function countWords(text: string): number {
  if (text.length === 0) return 0;
  const body = stripMarkdownSyntax(stripLeadingFrontmatter(text));
  const matches = body.match(WORD_RE);
  return matches ? matches.length : 0;
}

/**
 * Count characters as code points. Frontmatter is stripped (same policy as
 * word count): frontmatter isn't visible prose and shouldn't inflate the
 * character total either. Whitespace and newlines in the body still count.
 */
export function countCharacters(text: string): number {
  if (text.length === 0) return 0;
  const body = stripLeadingFrontmatter(text);
  let n = 0;
  for (const _ of body) n += 1;
  return n;
}

export interface Counts {
  words: number;
  characters: number;
}

/** Compute both counts for a chunk of text in one pass-friendly call. */
export function computeCounts(text: string): Counts {
  return { words: countWords(text), characters: countCharacters(text) };
}
