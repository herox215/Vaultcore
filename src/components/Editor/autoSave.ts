import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

const AUTO_SAVE_DEBOUNCE_MS = 2000;

/**
 * EDIT-09 + EDIT-10: 2-second idle debounce on docChanged.
 *
 * onSave may be async. The extension awaits the returned Promise before
 * scheduling the next timer, preventing overlapping writes (important for
 * the hash-verify merge path: a second auto-save must not race a pending
 * mergeExternalChange call).
 *
 * A single keystroke schedules exactly one onSave call 2000 ms later.
 * Successive keystrokes within 2000 ms reset the timer.
 * If a save is in flight, keystrokes are still recorded (doc mutates)
 * but no new timer starts until the in-flight save's promise settles.
 *
 * This factory is pure -- each call creates a new extension with its own
 * timer closure, so it is safe to use multiple editors in the same page.
 */
export function autoSaveExtension(
  onSave: (text: string) => Promise<void> | void,
): Extension {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let savingPromise: Promise<void> | null = null;
  let pendingReschedule = false;

  function scheduleTimer(view: EditorView): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try {
        const result = onSave(view.state.doc.toString());
        savingPromise = Promise.resolve(result);
        await savingPromise;
      } catch {
        // Errors surface via the onSave callback's own toast plumbing.
      } finally {
        savingPromise = null;
        if (pendingReschedule) {
          pendingReschedule = false;
          scheduleTimer(view);
        }
      }
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (savingPromise !== null) {
      // A save is in flight — defer the next timer until it completes.
      pendingReschedule = true;
      return;
    }
    scheduleTimer(update.view);
  });
}

export const AUTO_SAVE_DEBOUNCE_FOR_TESTS = AUTO_SAVE_DEBOUNCE_MS;
