// Integration tests for the openFileAsTab dispatcher (#49). These pin the
// extension-to-viewer mapping AND the unknown-extension UTF-8 probe path
// — opening an image must NOT touch readFile (that would fail on binary
// bytes), and an unknown-but-utf8 file must classify as "text", while an
// unknown-and-binary file must classify as "unsupported".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock("../../ipc/commands", () => ({
  readFile,
}));

import { openFileAsTab } from "../openFileAsTab";
import { tabStore } from "../../store/tabStore";

beforeEach(() => {
  tabStore._reset();
  readFile.mockReset();
});

describe("openFileAsTab", () => {
  it("opens a markdown file via openTab (no viewer field set)", async () => {
    await openFileAsTab("/vault/note.md");
    const state = get(tabStore);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.viewer).toBeUndefined();
    expect(state.tabs[0]!.filePath).toBe("/vault/note.md");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("opens an image without touching readFile", async () => {
    await openFileAsTab("/vault/photo.png");
    const state = get(tabStore);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.viewer).toBe("image");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("opens a known text/config extension as text without probing", async () => {
    await openFileAsTab("/vault/data.json");
    const state = get(tabStore);
    expect(state.tabs[0]!.viewer).toBe("text");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("opens a `.canvas` file with the canvas viewer without probing (#71)", async () => {
    await openFileAsTab("/vault/board.canvas");
    const state = get(tabStore);
    expect(state.tabs[0]!.viewer).toBe("canvas");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("opens an unknown UTF-8 file as text after probing", async () => {
    readFile.mockResolvedValueOnce("plain text content");
    await openFileAsTab("/vault/script.unknownext");
    expect(readFile).toHaveBeenCalledWith("/vault/script.unknownext");
    const state = get(tabStore);
    expect(state.tabs[0]!.viewer).toBe("text");
  });

  it("opens an unknown non-UTF-8 file as unsupported", async () => {
    readFile.mockRejectedValueOnce({
      kind: "InvalidEncoding",
      message: "binary",
      data: "/vault/blob.bin",
    });
    await openFileAsTab("/vault/blob.bin");
    const state = get(tabStore);
    expect(state.tabs[0]!.viewer).toBe("unsupported");
  });

  it("propagates non-encoding errors so the caller can toast them", async () => {
    readFile.mockRejectedValueOnce({
      kind: "FileNotFound",
      message: "missing",
      data: "/vault/gone.unknownext",
    });
    await expect(openFileAsTab("/vault/gone.unknownext")).rejects.toMatchObject({
      kind: "FileNotFound",
    });
    expect(get(tabStore).tabs).toHaveLength(0);
  });

  it("dedupes by filePath — calling twice on the same image focuses the existing tab", async () => {
    const id1 = await openFileAsTab("/vault/photo.png");
    const id2 = await openFileAsTab("/vault/photo.png");
    expect(id1).toBe(id2);
    expect(get(tabStore).tabs).toHaveLength(1);
  });
});

// #388 — viewport-aware default viewMode. Mobile users get markdown opens in
// read mode; non-markdown viewers (image / text / unsupported) ignore the
// hint because they have no Reading Mode path. The dispatcher reads the
// helper from `tabKind.ts`, which itself reads `viewportStore` once per call.

describe("openFileAsTab + viewMode (#388)", () => {
  beforeEach(() => {
    readFile.mockReset();
    vi.resetModules();
    vi.doUnmock("../../store/viewportStore");
    // NOTE: do NOT reset `tabStore` here — `vi.resetModules()` makes every
    // subsequent dynamic `import("../../store/tabStore")` return a FRESH
    // module whose `_core` writable is distinct from the top-level
    // import. Calling `tabStore._reset()` on the stale top-level instance
    // would silently no-op against the stores the tests actually use.
    // The reset moved into `loadDispatcher` below — runs after the dynamic
    // import, against the fresh singleton.
  });

  async function loadDispatcher(
    mode: "desktop" | "tablet" | "mobile",
  ): Promise<{
    dispatch: typeof openFileAsTab;
    ts: typeof import("../../store/tabStore").tabStore;
  }> {
    const { readable } = await import("svelte/store");
    vi.doMock("../../store/viewportStore", () => ({
      viewportStore: readable({ mode, isCoarsePointer: mode === "mobile" }),
    }));
    // Re-mock the IPC layer for the freshly-imported dispatcher so the
    // module graph after `vi.resetModules()` shares the same readFile spy.
    vi.doMock("../../ipc/commands", () => ({ readFile }));
    const mod = await import("../openFileAsTab");
    const { tabStore: ts } = await import("../../store/tabStore");
    ts._reset();
    return { dispatch: mod.openFileAsTab, ts };
  }

  it("opens markdown with viewMode='read' on mobile", async () => {
    const { dispatch, ts } = await loadDispatcher("mobile");
    await dispatch("/vault/note.md");
    const state = get(ts);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.viewMode).toBe("read");
  });

  it("opens markdown with viewMode='edit' on desktop", async () => {
    const { dispatch, ts } = await loadDispatcher("desktop");
    await dispatch("/vault/note.md");
    const state = get(ts);
    expect(state.tabs[0]!.viewMode).toBe("edit");
  });

  it("does not pass the hint for image viewers (image has no Reading Mode)", async () => {
    const { dispatch, ts } = await loadDispatcher("mobile");
    await dispatch("/vault/photo.png");
    const state = get(ts);
    expect(state.tabs[0]!.viewer).toBe("image");
    expect(state.tabs[0]!.viewMode).toBeUndefined();
  });

  it("does not pass the hint for text viewers (.txt / .json / etc.)", async () => {
    const { dispatch, ts } = await loadDispatcher("mobile");
    await dispatch("/vault/notes.txt");
    const state = get(ts);
    expect(state.tabs[0]!.viewer).toBe("text");
    expect(state.tabs[0]!.viewMode).toBeUndefined();
  });
});
