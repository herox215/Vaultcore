import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

const AUTO_SAVE_DEBOUNCE_MS = 2000;

/**
 * EDIT-09: 2-second idle debounce on docChanged.
 * A single keystroke schedules exactly one onSave call 2000 ms later.
 * Successive keystrokes within 2000 ms reset the timer.
 * Non-doc-change updates (selection-only) are ignored.
 *
 * This factory is pure -- each call creates a new extension with its own
 * timer closure, so it is safe to use multiple editors in the same page.
 */
export function autoSaveExtension(
  onSave: (text: string) => void
): Extension {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (timer !== null) clearTimeout(timer);
    const view = update.view;
    timer = setTimeout(() => {
      onSave(view.state.doc.toString());
      timer = null;
    }, AUTO_SAVE_DEBOUNCE_MS);
  });
}

export const AUTO_SAVE_DEBOUNCE_FOR_TESTS = AUTO_SAVE_DEBOUNCE_MS;
