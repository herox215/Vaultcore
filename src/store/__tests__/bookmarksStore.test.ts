import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("../../ipc/commands", () => ({
  loadBookmarks: vi.fn(),
  saveBookmarks: vi.fn(),
}));

import { loadBookmarks, saveBookmarks } from "../../ipc/commands";
import { bookmarksStore } from "../bookmarksStore";

const VAULT = "/tmp/test-vault";

describe("bookmarksStore (#12)", () => {
  beforeEach(() => {
    bookmarksStore.reset();
    vi.clearAllMocks();
  });

  it("initial state has empty paths and loaded=false", () => {
    expect(get(bookmarksStore)).toEqual({ paths: [], loaded: false });
  });

  it("load() populates paths from loadBookmarks IPC", async () => {
    (loadBookmarks as any).mockResolvedValueOnce(["a.md", "b.md"]);
    await bookmarksStore.load(VAULT);
    const s = get(bookmarksStore);
    expect(s.paths).toEqual(["a.md", "b.md"]);
    expect(s.loaded).toBe(true);
    expect(loadBookmarks).toHaveBeenCalledWith(VAULT);
  });

  it("toggle() adds a path when missing and persists", async () => {
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.toggle("notes/a.md", VAULT);
    expect(get(bookmarksStore).paths).toEqual(["notes/a.md"]);
    expect(saveBookmarks).toHaveBeenCalledWith(VAULT, ["notes/a.md"]);
  });

  it("toggle() removes a path when already present and persists", async () => {
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.toggle("a.md", VAULT);
    await bookmarksStore.toggle("b.md", VAULT);
    await bookmarksStore.toggle("a.md", VAULT);
    expect(get(bookmarksStore).paths).toEqual(["b.md"]);
    // Last save call should contain only b.md
    expect(saveBookmarks).toHaveBeenLastCalledWith(VAULT, ["b.md"]);
  });

  it("remove() is a no-op when path is not bookmarked", async () => {
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.remove("unknown.md", VAULT);
    expect(saveBookmarks).not.toHaveBeenCalled();
  });

  it("remove() deletes and persists", async () => {
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.toggle("a.md", VAULT);
    vi.clearAllMocks();
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.remove("a.md", VAULT);
    expect(get(bookmarksStore).paths).toEqual([]);
    expect(saveBookmarks).toHaveBeenCalledWith(VAULT, []);
  });

  it("reorder() updates the stored order and persists", async () => {
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.toggle("a.md", VAULT);
    await bookmarksStore.toggle("b.md", VAULT);
    await bookmarksStore.toggle("c.md", VAULT);
    vi.clearAllMocks();
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.reorder(["c.md", "a.md", "b.md"], VAULT);
    expect(get(bookmarksStore).paths).toEqual(["c.md", "a.md", "b.md"]);
    expect(saveBookmarks).toHaveBeenCalledWith(VAULT, ["c.md", "a.md", "b.md"]);
  });

  it("renamePath() swaps in-place and persists", async () => {
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.toggle("old.md", VAULT);
    await bookmarksStore.toggle("keep.md", VAULT);
    vi.clearAllMocks();
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.renamePath("old.md", "new.md", VAULT);
    expect(get(bookmarksStore).paths).toEqual(["new.md", "keep.md"]);
    expect(saveBookmarks).toHaveBeenCalledWith(VAULT, ["new.md", "keep.md"]);
  });

  it("renamePath() is a no-op when path not bookmarked", async () => {
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.renamePath("missing.md", "other.md", VAULT);
    expect(saveBookmarks).not.toHaveBeenCalled();
  });

  it("isBookmarked() reflects current state", async () => {
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.toggle("a.md", VAULT);
    expect(bookmarksStore.isBookmarked("a.md")).toBe(true);
    expect(bookmarksStore.isBookmarked("b.md")).toBe(false);
  });

  it("reset() restores initial state", async () => {
    (saveBookmarks as any).mockResolvedValue(undefined);
    await bookmarksStore.toggle("a.md", VAULT);
    bookmarksStore.reset();
    expect(get(bookmarksStore)).toEqual({ paths: [], loaded: false });
  });
});
