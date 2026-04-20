// CodeMirror 6 ViewPlugin that publishes word/character counts for the
// active document (or current selection) into the Svelte `countsStore`.
//
// Debounce: 100ms. Enough to collapse a fast typing burst into a single
// count computation without feeling laggy. Non-empty selection changes
// bypass the debounce so click-and-drag feels instant.
//
// Hot-path rule (issue #251):
//   - Empty-selection cursor moves (arrow-key navigation) DO NOT run a
//     fresh whole-doc count: the document didn't change, so the previous
//     whole-doc publish is still correct. We short-circuit without touching
//     `view.state.doc.toString()` — which scales with document length and
//     was otherwise called on every keypress on long notes.
//   - When the selection collapses after having been non-empty, we publish
//     the cached whole-doc counts once so the status bar can switch its
//     label back from "X words selected" to the whole-document total.

import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { countsStore, type PaneId } from "../../store/countsStore";
import { computeCounts, type Counts } from "../../lib/wordCount";

const DEBOUNCE_MS = 100;

/**
 * Publish counts for the current selection (if non-empty) or the whole
 * document (if the selection is collapsed). Returns the whole-doc counts
 * when it computed them, so the caller can cache them; returns null when
 * the publish was for a selection and the whole-doc cache is unaffected.
 */
function publish(view: EditorView, paneId: PaneId): Counts | null {
  const selection = view.state.selection.main;
  const hasSelection = !selection.empty;

  if (hasSelection) {
    const text = view.state.sliceDoc(selection.from, selection.to);
    const { words, characters } = computeCounts(text);
    countsStore.set(paneId, { words, characters, selection: true });
    return null;
  }

  const text = view.state.doc.toString();
  const counts = computeCounts(text);
  countsStore.set(paneId, { ...counts, selection: false });
  return counts;
}

export function countsPlugin(paneId: PaneId) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private view: EditorView;
      /** Last whole-doc counts — reused when the selection collapses and
       *  the document hasn't changed, avoiding a fresh `doc.toString()`. */
      private wholeDocCounts: Counts | null = null;
      private prevSelectionEmpty = true;

      constructor(view: EditorView) {
        this.view = view;
        // Initial snapshot — no debounce, so the bar appears with correct
        // counts as soon as the editor mounts.
        this.wholeDocCounts = publish(view, paneId);
        this.prevSelectionEmpty = view.state.selection.main.empty;
      }

      update(update: ViewUpdate): void {
        if (!update.docChanged && !update.selectionSet) return;

        if (!update.docChanged && update.selectionSet) {
          const nowEmpty = update.state.selection.main.empty;
          const wasEmpty = this.prevSelectionEmpty;
          this.prevSelectionEmpty = nowEmpty;

          // Empty-selection cursor move (arrow keys, click to place cursor):
          // doc unchanged, selection collapsed — the last published whole-doc
          // counts are still correct, so do nothing.
          if (nowEmpty && wasEmpty) return;

          // Selection collapsed from non-empty → whole-doc label needs to
          // reappear. Re-publish cached whole-doc counts without touching
          // `doc.toString()`.
          if (nowEmpty && !wasEmpty) {
            if (this.wholeDocCounts) {
              countsStore.set(paneId, { ...this.wholeDocCounts, selection: false });
            } else {
              this.wholeDocCounts = publish(update.view, paneId);
            }
            return;
          }

          // Non-empty selection change (drag tick, shift-arrow, etc.) —
          // user expects real-time feedback, so publish immediately and
          // skip the typing debounce.
          if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
          }
          publish(update.view, paneId);
          return;
        }

        // Doc changed — debounce to collapse typing bursts. The timer
        // callback publishes and refreshes the whole-doc cache (when the
        // selection is collapsed at that moment).
        this.prevSelectionEmpty = update.state.selection.main.empty;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          const counts = publish(this.view, paneId);
          if (counts !== null) this.wholeDocCounts = counts;
        }, DEBOUNCE_MS);
      }

      destroy(): void {
        if (this.timer !== null) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        countsStore.clear(paneId);
      }
    },
  );
}

export const COUNTS_DEBOUNCE_FOR_TESTS = DEBOUNCE_MS;
