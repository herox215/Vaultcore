// Phase 4 Plan 03: Wiki-link [[ autocomplete CompletionSource
// Uses the suggestLinks IPC command (nucleo fuzzy matcher, same engine as Quick Switcher).
//
// Design decisions:
//   - filter: false — nucleo already applies fuzzy filtering on the backend; CM6's default
//     filter would re-filter already-filtered results with a different algorithm.
//   - apply includes ]] — so selection produces a complete [[Filename]] (the [[ is already typed).
//   - Alias support (D-06): if the user types | after the filename (or after selecting), the
//     source returns null and the popup does not reopen.
//   - Empty state: "Keine Dateien gefunden" is shown when no results are returned from the backend.
//   - Does not retrigger inside an already-complete [[link]] (checks for ]] immediately after cursor).

import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { suggestLinks } from "../../ipc/commands";

/** Extract the filename stem from a vault-relative path (strips .md suffix). */
function basename(path: string): string {
  const parts = path.split("/");
  const file = parts[parts.length - 1] ?? "";
  return file.endsWith(".md") ? file.slice(0, -3) : file;
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

  // Don't trigger if there's already a ]] immediately after the cursor on the same line
  // (prevents re-triggering inside completed [[links]])
  const line = ctx.state.doc.lineAt(ctx.pos);
  const posInLine = ctx.pos - line.from;
  const afterCursor = line.text.slice(posInLine);
  if (afterCursor.startsWith("]]")) return null;

  // Don't trigger if the user is typing an alias (after |) — D-06
  const innerText = match.text.slice(2); // strip [[
  if (innerText.includes("|")) return null;

  const query = innerText;

  // Fetch results from backend (nucleo fuzzy match, D-05)
  let results;
  try {
    results = await suggestLinks(query, 20);
  } catch {
    return null; // silently fail if backend unavailable (vault not yet open, etc.)
  }

  if (results.length === 0) {
    // Empty state per UI-SPEC — show a non-interactive placeholder
    return {
      from: match.from + 2, // from is after the [[
      options: [
        {
          label: "Keine Dateien gefunden",
          apply: query, // keep whatever the user typed
          type: "text",
        },
      ],
      filter: false,
    };
  }

  return {
    from: match.from + 2, // from is after the [[
    options: results.map((r) => ({
      label: basename(r.path),
      detail: r.path, // relative path shown in grey (D-04)
      apply: `${basename(r.path)}]]`, // insert name + closing brackets
      type: "file",
      boost: r.score, // preserve nucleo ranking order
    })),
    filter: false, // backend already filtered via nucleo (D-05)
  };
}
