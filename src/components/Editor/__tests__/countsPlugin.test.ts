// Regression tests for issue #251:
// `countsPlugin` used to bypass its 100ms debounce for every selection-only
// transaction AND, when the selection was empty (i.e. normal cursor-navigation),
// recompute word/character counts over the *entire document* via
// `view.state.doc.toString()` — on every arrow key. On long notes that burns
// the per-keystroke 16 ms budget.
//
// The fix:
//   - Empty-selection cursor moves (no doc change, selection is collapsed)
//     MUST NOT recompute counts or publish, because the whole-doc count is
//     unchanged from its last publish.
//   - Non-empty-selection drags still publish immediately (drag-tracking).
//   - Typing still publishes debounced at 100ms.
//   - When the selection collapses after having been non-empty, the plugin
//     must publish the whole-doc counts once so the status bar switches back
//     from "X words selected" to the whole-document label — without running
//     `doc.toString()` again (cached from the previous whole-doc publish).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState, EditorSelection, Text } from "@codemirror/state";
import { countsPlugin, COUNTS_DEBOUNCE_FOR_TESTS } from "../countsPlugin";
import { countsStore } from "../../../store/countsStore";

function mountView(doc: string): { view: EditorView; parent: HTMLElement } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [countsPlugin("left")],
    }),
    parent,
  });
  return { view, parent };
}

describe("countsPlugin — issue #251 cursor-nav debounce bypass", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    countsStore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    countsStore.reset();
  });

  it("publishes an initial snapshot on mount", () => {
    const setSpy = vi.spyOn(countsStore, "set");
    const { view, parent } = mountView("the quick brown fox");
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![0]).toBe("left");
    expect(setSpy.mock.calls[0]![1]).toMatchObject({
      words: 4,
      selection: false,
    });
    view.destroy();
    parent.remove();
  });

  it("does NOT republish or recompute on empty-selection cursor moves", () => {
    // Build a long doc so that any regression (toString over the whole doc)
    // is measurable. Content doesn't matter — we assert via spies.
    const longDoc = "word ".repeat(5_000).trim();
    const { view, parent } = mountView(longDoc);

    const setSpy = vi.spyOn(countsStore, "set");
    const toStringSpy = vi.spyOn(Text.prototype, "toString");

    // Simulate 20 arrow-key taps: selection moves, doc doesn't change,
    // selection stays collapsed.
    for (let i = 1; i <= 20; i++) {
      view.dispatch({ selection: EditorSelection.cursor(i) });
    }

    // Fix: publish MUST NOT be called on empty-selection cursor moves.
    expect(setSpy).not.toHaveBeenCalled();
    // And the whole-doc `toString()` MUST NOT run on the cursor-nav hot path.
    expect(toStringSpy).not.toHaveBeenCalled();

    view.destroy();
    parent.remove();
  });

  it("publishes immediately for non-empty-selection changes (drag tracking)", () => {
    const { view, parent } = mountView("alpha beta gamma delta");
    const setSpy = vi.spyOn(countsStore, "set");

    // Simulate a drag that selects "alpha beta" (chars 0..10).
    view.dispatch({ selection: EditorSelection.range(0, 10) });
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![1]).toMatchObject({ selection: true, words: 2 });

    // Extend the selection mid-drag to "alpha beta gamma" (chars 0..16).
    view.dispatch({ selection: EditorSelection.range(0, 16) });
    expect(setSpy).toHaveBeenCalledTimes(2);
    expect(setSpy.mock.calls[1]![1]).toMatchObject({ selection: true, words: 3 });

    view.destroy();
    parent.remove();
  });

  it("debounces typing at 100ms — a burst yields a single publish", () => {
    const { view, parent } = mountView("hello");
    const setSpy = vi.spyOn(countsStore, "set");

    // Five quick inserts within the debounce window.
    for (let i = 0; i < 5; i++) {
      view.dispatch({
        changes: { from: view.state.doc.length, to: view.state.doc.length, insert: "x" },
      });
    }

    // Before the debounce fires, no publish.
    expect(setSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COUNTS_DEBOUNCE_FOR_TESTS + 1);

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![1]).toMatchObject({ selection: false });

    view.destroy();
    parent.remove();
  });

  it("re-publishes whole-doc counts when the selection collapses from non-empty", () => {
    const { view, parent } = mountView("alpha beta gamma");
    const setSpy = vi.spyOn(countsStore, "set");

    // Make a selection first so the store reports `selection: true`.
    view.dispatch({ selection: EditorSelection.range(0, 5) });
    expect(setSpy).toHaveBeenLastCalledWith(
      "left",
      expect.objectContaining({ selection: true }),
    );

    // Collapse the selection — user clicks away / presses Esc. The status bar
    // must switch back to the whole-doc label, so one publish with
    // `selection: false` is expected and is allowed to use cached counts.
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(setSpy).toHaveBeenLastCalledWith(
      "left",
      expect.objectContaining({ selection: false, words: 3 }),
    );

    // Any further empty-cursor moves must NOT republish.
    const callsBefore = setSpy.mock.calls.length;
    view.dispatch({ selection: EditorSelection.cursor(2) });
    view.dispatch({ selection: EditorSelection.cursor(5) });
    expect(setSpy.mock.calls.length).toBe(callsBefore);

    view.destroy();
    parent.remove();
  });
});
