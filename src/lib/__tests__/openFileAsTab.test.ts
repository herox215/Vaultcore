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
