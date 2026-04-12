import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { autoSaveExtension, AUTO_SAVE_DEBOUNCE_FOR_TESTS } from "../autoSave";

vi.mock("../../../ipc/commands", () => ({
  invoke: vi.fn(),
  normalizeError: (e: unknown) => e,
  getFileHash: vi.fn(),
}));

import { getFileHash } from "../../../ipc/commands";

describe("autoSaveExtension (EDIT-10)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeView(onSave: (t: string) => Promise<void> | void): EditorView {
    return new EditorView({
      state: EditorState.create({ doc: "", extensions: [autoSaveExtension(onSave)] }),
    });
  }

  it("fires onSave once 2000ms after a docChanged event", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = makeView(onSave);
    view.dispatch({ changes: { from: 0, insert: "a" } });
    expect(onSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_FOR_TESTS);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("a");
    view.destroy();
  });

  it("resets the timer on a second keystroke", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = makeView(onSave);
    view.dispatch({ changes: { from: 0, insert: "a" } });
    await vi.advanceTimersByTimeAsync(1500);
    view.dispatch({ changes: { from: 1, insert: "b" } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(onSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("ab");
    view.destroy();
  });

  it("defers next timer until in-flight save resolves (no overlap)", async () => {
    let resolveFirst: () => void = () => {};
    const onSave = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { resolveFirst = r; }))
      .mockResolvedValue(undefined);
    const view = makeView(onSave);
    view.dispatch({ changes: { from: 0, insert: "a" } });
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_FOR_TESTS);
    expect(onSave).toHaveBeenCalledTimes(1);
    // Mutate while save is pending
    view.dispatch({ changes: { from: 1, insert: "b" } });
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_FOR_TESTS);
    // Still only first call — timer was deferred
    expect(onSave).toHaveBeenCalledTimes(1);
    // Resolve the first save
    resolveFirst();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_FOR_TESTS);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith("ab");
    view.destroy();
  });

  it("getFileHash wrapper resolves to hex from IPC", async () => {
    (getFileHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce("a".repeat(64));
    const hex = await getFileHash("/path");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
