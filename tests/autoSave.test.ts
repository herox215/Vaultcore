import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  autoSaveExtension,
  AUTO_SAVE_DEBOUNCE_FOR_TESTS,
} from "../src/components/Editor/autoSave";

function makeView(onSave: (text: string) => void, doc: string = ""): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [autoSaveExtension(onSave)],
    }),
    parent,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EDIT-09: auto-save 2s idle debounce", () => {
  it("EDIT-09: a single keystroke schedules onSave exactly once after 2000 ms", () => {
    const onSave = vi.fn();
    const view = makeView(onSave, "");
    view.dispatch({ changes: { from: 0, insert: "h" } });
    expect(onSave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AUTO_SAVE_DEBOUNCE_FOR_TESTS - 1);
    expect(onSave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("h");
    view.destroy();
  });

  it("EDIT-09: successive keystrokes within 2000 ms reset the debounce (only one save fires)", () => {
    const onSave = vi.fn();
    const view = makeView(onSave, "");
    view.dispatch({ changes: { from: 0, insert: "a" } });
    vi.advanceTimersByTime(500);
    view.dispatch({ changes: { from: 1, insert: "b" } });
    vi.advanceTimersByTime(500);
    view.dispatch({ changes: { from: 2, insert: "c" } });
    // After 1000ms total -- nothing saved yet (each keystroke reset the timer)
    vi.advanceTimersByTime(1000);
    expect(onSave).not.toHaveBeenCalled();
    // After an additional 1001 ms (so 2001 ms since last keystroke) -- save fires
    vi.advanceTimersByTime(1001);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("abc");
    view.destroy();
  });

  it("EDIT-09: docChanged === false (selection-only transaction) does not schedule a save", () => {
    const onSave = vi.fn();
    const view = makeView(onSave, "hello");
    // Selection-only change -- no doc edit
    view.dispatch({ selection: { anchor: 2, head: 4 } });
    vi.advanceTimersByTime(AUTO_SAVE_DEBOUNCE_FOR_TESTS + 100);
    expect(onSave).not.toHaveBeenCalled();
    view.destroy();
  });

  it("EDIT-09: second keystroke after first save fires a second save", () => {
    const onSave = vi.fn();
    const view = makeView(onSave, "");
    view.dispatch({ changes: { from: 0, insert: "a" } });
    vi.advanceTimersByTime(2001);
    expect(onSave).toHaveBeenCalledTimes(1);
    view.dispatch({ changes: { from: 1, insert: "b" } });
    vi.advanceTimersByTime(2001);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith("ab");
    view.destroy();
  });
});
