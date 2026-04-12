// Phase 4 Plan 03: Wiki-link [[ autocomplete CompletionSource
// Uses the suggestLinks IPC command (nucleo fuzzy matcher, same engine as Quick Switcher).
//
// Design decisions:
//   - filter: false — nucleo already applies fuzzy filtering on the backend; CM6's default
//     filter would re-filter already-filtered results with a different algorithm.
//   - apply uses a function to handle the closeBrackets() interaction correctly:
//     counts existing `]` chars after the cursor (0/1/2) and consumes them so that
//     the final result always has exactly `[[Filename]]`. Without this, typing `[[`
//     triggers closeBrackets → `[[|]]`, and naive apply produces `[[Name]]]]`.
//   - Alias support (D-06): if the user types | after [[, the source returns null
//     (the popup does not reopen — user freely types the alias).
//   - Empty query ([[|] or [[|]]): we ask the backend for the first N files (no query),
//     giving Obsidian-like "browse" behavior instead of an empty "Keine Dateien gefunden"
//     placeholder that blocks selection.

import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { suggestLinks } from "../../ipc/commands";

/** Extract the filename stem from a vault-relative path (strips .md suffix). */
function basename(path: string): string {
  const parts = path.split("/");
  const file = parts[parts.length - 1] ?? "";
  return file.endsWith(".md") ? file.slice(0, -3) : file;
}

/** Count consecutive `]` characters at the start of a string (clamped to 2). */
function countLeadingClosingBrackets(s: string): number {
  if (s.startsWith("]]")) return 2;
  if (s.startsWith("]")) return 1;
  return 0;
}

/**
 * CM6 CompletionSource for [[ wiki-link autocomplete.
 *
 * Triggers after [[ and queries the Rust backend via suggestLinks (nucleo).
 * Returns filename (label) + relative path (detail) per entry, per UI-SPEC D-04.
 */
export async function wikiLinkCompletionSource(
  ctx: CompletionContext,
): Promise<CompletionResult | null> {
  // Match [[ followed by any non-] characters (the query typed so far)
  const match = ctx.matchBefore(/\[\[([^\]]*)/);
  if (!match) return null;

  // Alias support (D-06): bail if user is typing after | — let them type freely
  const innerText = match.text.slice(2); // strip [[
  if (innerText.includes("|")) return null;

  const query = innerText;

  // Fetch results from backend (nucleo fuzzy match, D-05).
  // Backend returns top-N files for empty query (Obsidian "browse" behavior).
  let results;
  try {
    results = await suggestLinks(query, 20);
  } catch {
    return null; // silently fail if backend unavailable (vault not yet open, etc.)
  }

  // Only show "Keine Dateien gefunden" placeholder when the user has typed
  // a non-empty query and there really are no matches. For an empty query
  // with no files, returning null (no popup) is cleaner than a blocking placeholder.
  if (results.length === 0) {
    if (query.length === 0) return null;
    return {
      from: match.from + 2,
      options: [
        {
          label: "Keine Dateien gefunden",
          apply: query,
          type: "text",
        },
      ],
      filter: false,
    };
  }

  return {
    from: match.from + 2, // from is after the [[
    options: results.map((r) => {
      const name = basename(r.path);
      return {
        label: name,
        detail: r.path, // relative path shown in grey (D-04)
        // apply as function: consume existing `]` chars after the cursor so the
        // final result has exactly `[[Name]]` regardless of closeBrackets state.
        apply: (view: EditorView, _completion, from: number, to: number) => {
          const line = view.state.doc.lineAt(to);
          const posInLine = to - line.from;
          const afterCursor = line.text.slice(posInLine);
          const existingClosing = countLeadingClosingBrackets(afterCursor);
          view.dispatch({
            changes: {
              from,
              to: to + existingClosing,
              insert: `${name}]]`,
            },
            selection: { anchor: from + name.length + 2 },
          });
        },
        type: "file",
        boost: r.score, // preserve nucleo ranking order
      };
    }),
    filter: false, // backend already filtered via nucleo (D-05)
  };
}
