// #148 — after rebuildIndex, the SearchPanel calls
// `searchStore.refetchIfQueryNonEmpty()` so the freshly-built index is
// queried again and results reflect newly-indexed content without the
// user having to retype the query.
//
// We mock the IPC layer so the store exercises its control flow without
// a Tauri runtime. Each assertion locks in one AC from the ticket.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

const searchFulltextMock = vi.fn();

vi.mock("../../ipc/commands", () => ({
  searchFulltext: (...args: unknown[]) => searchFulltextMock(...args),
}));

import { searchStore } from "../searchStore";

describe("searchStore.refetchIfQueryNonEmpty (#148)", () => {
  beforeEach(() => {
    searchStore.reset();
    searchFulltextMock.mockReset();
  });

  it("re-runs the current query and replaces results", async () => {
    searchStore.setQuery("#yoda");
    // First rebuild finds one hit; a later rebuild finds two.
    searchFulltextMock.mockResolvedValueOnce([
      { path: "a.md", snippet: "", score: 1 },
      { path: "b.md", snippet: "", score: 1 },
    ]);

    await searchStore.refetchIfQueryNonEmpty();

    expect(searchFulltextMock).toHaveBeenCalledTimes(1);
    expect(searchFulltextMock).toHaveBeenCalledWith("#yoda", 100);
    const s = get(searchStore);
    expect(s.results).toHaveLength(2);
    expect(s.totalFiles).toBe(2);
    expect(s.isSearching).toBe(false);
  });

  it("is a no-op when the query is empty (no fetch issued)", async () => {
    searchStore.setQuery("");
    await searchStore.refetchIfQueryNonEmpty();
    expect(searchFulltextMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the query is only whitespace", async () => {
    searchStore.setQuery("   ");
    await searchStore.refetchIfQueryNonEmpty();
    expect(searchFulltextMock).not.toHaveBeenCalled();
  });

  it("marks the index stale and clears isSearching on IndexCorrupt", async () => {
    searchStore.setQuery("#yoda");
    searchFulltextMock.mockRejectedValueOnce({ kind: "IndexCorrupt", message: "x" });

    await searchStore.refetchIfQueryNonEmpty();

    const s = get(searchStore);
    expect(s.isSearching).toBe(false);
    expect(s.indexStale).toBe(true);
  });

  it("does not flip indexStale on unrelated errors, but clears isSearching", async () => {
    searchStore.setQuery("#yoda");
    searchFulltextMock.mockRejectedValueOnce(new Error("network blip"));

    await searchStore.refetchIfQueryNonEmpty();

    const s = get(searchStore);
    expect(s.isSearching).toBe(false);
    expect(s.indexStale).toBe(false);
  });
});
