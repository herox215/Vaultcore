// CodeMirror 6 ViewPlugin that publishes word/character counts for the
// active document (or current selection) into the Svelte `countsStore`.
//
// Debounce: 100ms. Enough to collapse a fast typing burst into a single
// count computation without feeling laggy. Selection-only transactions
// bypass the debounce so click-and-drag feels instant.

import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { countsStore, type PaneId } from "../../store/countsStore";
import { computeCounts } from "../../lib/wordCount";

const DEBOUNCE_MS = 100;

function publish(view: EditorView, paneId: PaneId): void {
  const selection = view.state.selection.main;
  const hasSelection = !selection.empty;

  const text = hasSelection
    ? view.state.sliceDoc(selection.from, selection.to)
    : view.state.doc.toString();

  const { words, characters } = computeCounts(text);
  countsStore.set(paneId, { words, characters, selection: hasSelection });
}

export function countsPlugin(paneId: PaneId) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        // Initial snapshot — no debounce, so the bar appears with correct
        // counts as soon as the editor mounts.
        publish(view, paneId);
      }

      update(update: ViewUpdate): void {
        if (!update.docChanged && !update.selectionSet) return;

        // Selection-only updates are cheap and the user expects the count
        // to track the drag in real time — skip the debounce.
        if (update.selectionSet && !update.docChanged) {
          if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
          }
          publish(update.view, paneId);
          return;
        }

        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          publish(this.view, paneId);
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
