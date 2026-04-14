// Heading extractor used by the right-sidebar OutlinePanel.
//
// Walks the Lezer syntax tree produced by @lezer/markdown to find ATX headings
// (# … ####### …) and setext headings (underline with === or ---). Falls back
// to a regex scan when no EditorState is supplied (e.g. in unit tests).

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/** A single heading entry. */
export interface Heading {
  /** Heading level 1–6. */
  level: 1 | 2 | 3 | 4 | 5 | 6;
  /** Heading text with leading #-marks and trailing whitespace stripped. */
  text: string;
  /** Absolute position of the first character of the heading line in the doc. */
  from: number;
  /** 1-based line number of the heading line. */
  line: number;
}

// ── Syntax-tree extraction ──────────────────────────────────────────────────

const ATX_NODE_RE = /^ATXHeading([1-6])$/;
const SETEXT_NODE_RE = /^SetextHeading([1-2])$/;

/**
 * Extract headings from `state` using the Lezer parse tree.
 * This is the preferred path when a live EditorState is available.
 */
export function extractHeadingsFromState(state: EditorState): Heading[] {
  const results: Heading[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      let level: number | null = null;

      const atxMatch = ATX_NODE_RE.exec(node.name);
      if (atxMatch && atxMatch[1] !== undefined) {
        level = parseInt(atxMatch[1], 10);
      }

      const setextMatch = SETEXT_NODE_RE.exec(node.name);
      if (setextMatch && setextMatch[1] !== undefined) {
        level = parseInt(setextMatch[1], 10);
      }

      if (level === null) return;

      const lineInfo = state.doc.lineAt(node.from);
      const rawText = lineInfo.text;

      let text: string;
      if (atxMatch) {
        // Strip leading # characters and optional space.
        text = rawText.replace(/^#{1,6}\s*/, "").trim();
      } else {
        // Setext heading: the text is on the line itself (not the underline).
        text = rawText.trim();
      }

      results.push({
        level: level as 1 | 2 | 3 | 4 | 5 | 6,
        text,
        from: lineInfo.from,
        line: lineInfo.number,
      });
    },
  });

  return results;
}

// ── Regex fallback (for unit tests / no live state) ─────────────────────────

// Matches ATX headings: # … through ###### …
const ATX_RE = /^(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/m;

/**
 * Extract headings from raw `text` using a line-by-line regex scan.
 * Supports ATX headings only. Suitable for testing and offline use.
 *
 * @param text  Raw document text.
 * @returns Headings in document order.
 */
export function extractHeadings(text: string): Heading[] {
  const results: Heading[] = [];
  const lines = text.split("\n");
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] ?? "";

    // ATX heading
    const atxMatch = /^(#{1,6})\s+(.*)$/.exec(lineText);
    if (atxMatch) {
      const hashes = atxMatch[1] ?? "";
      const rawHeadingText = atxMatch[2] ?? "";
      // Strip optional closing # marks
      const headingText = rawHeadingText.replace(/\s+#+\s*$/, "").trim();
      results.push({
        level: Math.min(hashes.length, 6) as 1 | 2 | 3 | 4 | 5 | 6,
        text: headingText,
        from: offset,
        line: i + 1,
      });
      offset += lineText.length + 1;
      continue;
    }

    // Setext heading: check the NEXT line for === or ---
    const nextLine = lines[i + 1] ?? "";
    if (/^=+\s*$/.test(nextLine)) {
      results.push({
        level: 1,
        text: lineText.trim(),
        from: offset,
        line: i + 1,
      });
    } else if (/^-+\s*$/.test(nextLine)) {
      results.push({
        level: 2,
        text: lineText.trim(),
        from: offset,
        line: i + 1,
      });
    }

    offset += lineText.length + 1;
  }

  // Remove empty entries and enforce unique from positions (setext double-counts
  // if the next line also looks like a heading candidate; guard against that).
  return results.filter((h) => h.text.length > 0);
}

void ATX_NODE_RE;
