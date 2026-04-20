// CodeMirror 6 CompletionSource for `{{ ... }}` template expressions (#284).
//
// Fires only when the cursor sits inside an open `{{ ... }}` block on the
// current line (scan backwards for `{{` without an intervening `}}`).
// Delegates all shape/type logic to `templateCompletion.ts` so the engine
// stays DOM-free and testable. Frontmatter keys for `note.property.*` come
// from the active editor doc — see #283 follow-up for full-vault scan.

import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { analyzeCompletion } from "../../lib/templateCompletion";
import { segmentContainingCursor } from "../../lib/templateProgram";
import { parseFrontmatter } from "../../lib/frontmatterIO";

const COMPLETION_TYPE: Record<string, string> = {
  variable: "variable",
  property: "property",
  method: "method",
};

/**
 * Returns the column within `line` where the enclosing `{{` starts, or
 * -1 when the cursor is not inside an open template block. A `}}` between
 * `{{` and the cursor closes the block.
 */
function findOpenTemplate(lineText: string, col: number): number {
  const before = lineText.slice(0, col);
  const lastOpen = before.lastIndexOf("{{");
  if (lastOpen < 0) return -1;
  const lastClose = before.lastIndexOf("}}");
  if (lastClose > lastOpen) return -1;
  return lastOpen;
}

export function templateCompletionSource(
  ctx: CompletionContext,
): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const col = ctx.pos - line.from;
  const openCol = findOpenTemplate(line.text, col);
  if (openCol < 0) return null;

  const bodyStart = line.from + openCol + 2; // skip past `{{`
  const body = ctx.state.doc.sliceString(bodyStart, ctx.pos);

  // #303: scope the analysis input to the segment containing the cursor.
  // Without this, a prior segment like `vault.notes.` would confuse the
  // analyzer into still treating the chain as open when the user has
  // already typed `;` and is authoring a new segment.
  const seg = segmentContainingCursor(body, body.length);
  const input = seg.segment.slice(0, seg.offsetInSegment);
  const exprStart = bodyStart + seg.segmentStart;

  const dynamicKeys = collectFrontmatterKeys(ctx.state.doc.toString());
  const analysis = analyzeCompletion(input, {
    dynamicFrontmatterKeys: dynamicKeys,
  });

  if (analysis.items.length === 0 && !ctx.explicit) return null;

  const options: Completion[] = analysis.items.map((item) => {
    const opt: Completion = {
      label: item.label,
      detail: item.detail,
      // #299: function-form apply guarantees the caret lands at the end of
      // the inserted text regardless of how CodeMirror resolves `to` under
      // a chained-completion timing (e.g. picking `vault`, then `.`, then
      // picking a member). The string-form fallback used to leave the caret
      // anchored at `result.from` when `to` drifted across transactions.
      apply: (view: EditorView, _completion, from: number, to: number) => {
        const insert = item.insertText;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          userEvent: "input.complete",
        });
      },
      type: COMPLETION_TYPE[item.kind] ?? "text",
    };
    if (item.doc !== undefined) opt.info = item.doc;
    return opt;
  });

  return {
    from: exprStart + analysis.from,
    to: ctx.pos,
    options,
    filter: true,
  };
}

function collectFrontmatterKeys(docText: string): string[] {
  try {
    const { properties } = parseFrontmatter(docText);
    return properties.map((p) => p.key);
  } catch {
    return [];
  }
}
