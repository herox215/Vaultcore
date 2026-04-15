// Tag `#` autocomplete CompletionSource (#68).
//
// Sibling of wikiLinkAutocomplete.ts. Triggers when the user types `#` at a
// word boundary and offers the current vault tag set (from tagsStore). Tag
// list is read synchronously via `get(tagsStore)` each time the source fires,
// so newly created tags appear without needing a restart.
//
// Design decisions:
//   - filter: true (CM6 default) — the tag set is small and local, so we let
//     CodeMirror's prefix filter narrow as the user types. No fuzzy backend.
//   - Trigger only at a word boundary: the character before `#` must be
//     whitespace, punctuation, or line-start (mirrors the Rust inline tag
//     regex in src-tauri/src/indexer/tag_index.rs — filters out URL fragments
//     like `example.com/page#section` and CSS hex colors like `#abc`).
//   - Skip inside code fences / inline code — same syntax-tree guard pattern
//     used by wikiLink.ts and embedPlugin.ts (FencedCode / CodeBlock /
//     InlineCode / Code nodes).
//   - Enter inserts the tag (CM6 default apply just inserts the label), and
//     Escape dismisses the popup (CM6 default keymap).

import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { get } from "svelte/store";
import { tagsStore } from "../../store/tagsStore";

/**
 * Returns true if `pos` sits inside a fenced code block, plain code block,
 * or inline code span. Mirrors wikiLink.ts / embedPlugin.ts — a false
 * positive here is always safe (we just suppress the popup).
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

/**
 * CM6 CompletionSource for `#tag` autocomplete.
 *
 * Matches a `#` at a word boundary followed by optional tag-prefix characters
 * (letters/digits/underscore/hyphen/slash for nested tags). Offers candidates
 * from the tags store; CM6 handles prefix filtering as the user keeps typing.
 */
export function tagCompletionSource(
  ctx: CompletionContext,
): CompletionResult | null {
  // Match `#` + the partial tag text typed so far. Allow letters, digits,
  // `_`, `-`, `/` in the prefix (nested tags). We don't require a letter as
  // the first char here (unlike the Rust indexer) — the user may be mid-type
  // and we rank against the stored tag set anyway.
  const match = ctx.matchBefore(/#[\w\-/]*/);
  if (!match) return null;

  // Boundary check: the character BEFORE the `#` must be whitespace,
  // punctuation, or line-start. Otherwise we're inside a URL fragment,
  // CSS hex color, or similar — do not fire the popup.
  if (match.from > 0) {
    const prev = ctx.state.doc.sliceString(match.from - 1, match.from);
    if (!/[\s(,!?;:]/.test(prev)) return null;
  }

  // Skip inside fenced/inline code — tags there aren't real vault tags.
  if (isInsideCodeBlock(ctx.state, match.from)) return null;

  // If the user only typed `#` with nothing after, do not fire unless
  // explicitly requested (clicking / Ctrl-Space). This matches Obsidian
  // and avoids the popup blocking every line that starts with `#`
  // (markdown headings).
  const query = match.text.slice(1); // strip leading `#`
  if (query.length === 0 && !ctx.explicit) return null;

  // Pull the current tag list synchronously. Reactivity is covered because
  // this source runs on every keystroke — if tagsStore updated between
  // firings, the next popup uses the fresh list.
  const { tags } = get(tagsStore);
  if (tags.length === 0) return null;

  return {
    // `from` is after the `#` so CM6's prefix filter matches against the
    // bare tag text (without the `#`). `apply` re-adds the `#`.
    from: match.from + 1,
    options: tags.map((t) => ({
      label: t.tag,
      apply: t.tag,
      detail: String(t.count),
      type: "constant",
      boost: t.count, // more-used tags rank higher when prefixes tie
    })),
  };
}
