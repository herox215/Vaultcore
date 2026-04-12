// Flash highlight CM6 extension for scroll-to-match.
// Applied when user clicks a search result or Quick Switcher result —
// scrolls the editor to the match position and shows a yellow highlight
// that fades out over 2.5 seconds (SRCH-06).

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

/** Dispatched to set or clear the flash highlight range. */
export const flashEffect = StateEffect.define<{ from: number; to: number } | null>();

/** Holds the current flash decoration (at most one at a time). */
export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        if (e.value === null) return Decoration.none;
        return Decoration.set([
          Decoration.mark({ class: "vc-flash-highlight" }).range(e.value.from, e.value.to),
        ]);
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Scroll the editor to `from..to`, apply a yellow flash highlight,
 * begin a CSS fade transition after one animation frame, and remove
 * the decoration after 2600ms (matching the 2500ms CSS transition).
 */
export function scrollToMatch(view: EditorView, from: number, to: number): void {
  // 1. Scroll the range into view
  view.dispatch({
    effects: EditorView.scrollIntoView(from, { y: "center" }),
  });

  // 2. Apply flash highlight decoration
  view.dispatch({
    effects: flashEffect.of({ from, to }),
  });

  // 3. Trigger CSS fade-out by adding the done class after one frame
  requestAnimationFrame(() => {
    const marks = view.dom.querySelectorAll(".vc-flash-highlight");
    marks.forEach((m) => m.classList.add("vc-flash-done"));
  });

  // 4. Remove the decoration after transition completes
  setTimeout(() => {
    view.dispatch({ effects: flashEffect.of(null) });
  }, 2600);
}

/**
 * Extract the first plain-text match from a Tantivy snippet.
 * Tantivy SnippetGenerator wraps matched text in `<b>…</b>` tags.
 * Returns the innerText of the first <b> tag, or null if none.
 */
export function extractSnippetMatch(snippet: string): string | null {
  const match = /<b>([^<]+)<\/b>/.exec(snippet);
  return match ? (match[1] ?? null) : null;
}
