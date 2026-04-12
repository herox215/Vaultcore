// Wiki-link CM6 ViewPlugin — Phase 4 Plan 02
//
// Architecture:
//   - Module-level `resolvedLinks: Map<stem, relPath>` populated once per vault
//     open via EditorPane calling setResolvedLinks(await getResolvedLinks()).
//   - Every decoration + click lookup is a synchronous Map.get() — zero IPC
//     inside the CM6 render loop, zero IPC at click time.
//   - Click events are dispatched as CustomEvent("wiki-link-click") on the
//     EditorView DOM so the Svelte layer handles navigation without coupling
//     the CM6 extension to Svelte stores.

import { ViewPlugin, Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// ── Wiki-link regex ────────────────────────────────────────────────────────────

/** Matches [[target]] and [[target|alias]]. Global flag — reset lastIndex before use. */
const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

// ── Resolution map ─────────────────────────────────────────────────────────────

/**
 * Stem (lowercased) → vault-relative path.
 * Populated once per vault open via EditorPane calling
 * `setResolvedLinks(await getResolvedLinks())`.
 * Incrementally updated on file create/delete/rename by EditorPane.
 */
let resolvedLinks: Map<string, string> = new Map();

/**
 * Replace the resolution map. Called by EditorPane after `get_resolved_links`
 * IPC returns on vault open, and on incremental file create/delete/rename events.
 */
export function setResolvedLinks(map: Map<string, string>): void {
  resolvedLinks = map;
}

/**
 * Synchronous lookup used by both the ViewPlugin (decoration) and the
 * EditorPane click handler.
 *
 * @param target - Raw link target from `[[target]]` (may include `.md` suffix;
 *   alias is already stripped by the caller via the regex group 1 capture).
 * @returns Vault-relative path, or `null` if the target is not resolved.
 */
export function resolveTarget(target: string): string | null {
  const stem = (target.endsWith(".md") ? target.slice(0, -3) : target).toLowerCase();
  return resolvedLinks.get(stem) ?? null;
}

// ── Code block detection ───────────────────────────────────────────────────────

/**
 * Returns true when `pos` is inside a fenced code block, indented code block,
 * or inline code span. Uses the lezer syntax tree to check node ancestry.
 *
 * Node names are based on `@lezer/markdown`'s grammar. If a vault's content
 * triggers a different node name (e.g. language-specific embedding), the
 * decoration is skipped safely — a false positive here is always safe.
 */
function isInsideCodeBlock(state: EditorState, pos: number): boolean {
  const node = syntaxTree(state).resolve(pos, 1);
  let cur: typeof node | null = node;
  while (cur) {
    const name = cur.type.name;
    if (
      name === "FencedCode" ||
      name === "CodeBlock" ||
      name === "InlineCode" ||
      name === "Code"
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

// ── Decoration builder ─────────────────────────────────────────────────────────

interface WikiMatch {
  from: number;
  to: number;
  target: string;
  resolved: boolean;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();

  // Collect all matches first, then sort by from-position.
  // RangeSetBuilder panics if ranges are added out of order.
  const matches: WikiMatch[] = [];

  WIKI_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_LINK_RE.exec(text)) !== null) {
    const rawTarget: string | undefined = m[1]; // group 1: target (before | or end)
    if (rawTarget === undefined) continue;       // regex group 1 is non-optional but guard for strict TS

    const from = m.index;
    const to = from + m[0].length;

    // Skip links inside code blocks / inline code
    if (isInsideCodeBlock(view.state, from)) continue;

    // Strip .md suffix for resolution lookup (matches Rust side)
    const stem: string = rawTarget.endsWith(".md") ? rawTarget.slice(0, -3) : rawTarget;
    const resolved = resolvedLinks.has(stem.toLowerCase());

    matches.push({ from, to, target: stem, resolved });
  }

  // Sort by position (should already be in order, but guarantee it)
  matches.sort((a, b) => a.from - b.from);

  for (const match of matches) {
    const decoration = Decoration.mark({
      class: match.resolved ? "cm-wikilink-resolved" : "cm-wikilink-unresolved",
      attributes: {
        "data-wiki-target": match.target,
        "data-wiki-resolved": match.resolved ? "true" : "false",
      },
    });
    builder.add(match.from, match.to, decoration);
  }

  return builder.finish();
}

// ── ViewPlugin ─────────────────────────────────────────────────────────────────

export const wikiLinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event: MouseEvent, view: EditorView) {
        const target = event.target as HTMLElement;
        const wikiTarget = target.closest("[data-wiki-target]");
        if (!wikiTarget) return false;

        const linkTarget = wikiTarget.getAttribute("data-wiki-target");
        const isResolved = wikiTarget.getAttribute("data-wiki-resolved") === "true";
        if (!linkTarget) return false;

        event.preventDefault();
        event.stopPropagation();

        // Dispatch custom event for the Svelte layer to handle navigation.
        // The listener calls resolveTarget(linkTarget) for resolved links to
        // get the vault-relative path — no flat-vault stub, no IPC at click time.
        view.dom.dispatchEvent(
          new CustomEvent("wiki-link-click", {
            bubbles: true,
            detail: { target: linkTarget, resolved: isResolved },
          }),
        );

        return true;
      },
    },
  },
);

// ── Refresh helper ─────────────────────────────────────────────────────────────

/**
 * Force decoration rebuild on all open EditorViews after `setResolvedLinks`
 * is called. Dispatches a no-op transaction to trigger `update()`.
 *
 * EditorPane calls this on every mounted EditorView after vault open so
 * decorations reflect the fresh resolution map immediately.
 */
export function refreshWikiLinks(view: EditorView): void {
  view.dispatch({ effects: [] });
}
