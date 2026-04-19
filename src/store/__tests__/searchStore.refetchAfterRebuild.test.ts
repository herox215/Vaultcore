// #148 — after rebuildIndex, the SearchPanel calls
// `searchStore.refetchIfQueryNonEmpty()` so the freshly-built index is
// queried again and results reflect newly-indexed content without the
// user having to retype the query.
//
// #204 switched the refetch path from searchFulltext (BM25-only) to
// hybridSearch (RRF-fused). The store control flow is identical — only
// the underlying IPC call and the result type (HybridHit) changed.
//
// We mock the IPC layer so the store exercises its control flow without
// a Tauri runtime. Each assertion locks in one AC from the ticket.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

const hybridSearchMock = vi.fn();

vi.mock("../../ipc/commands", () => ({
  hybridSearch: (...args: unknown[]) => hybridSearchMock(...args),
}));

import { searchStore } from "../searchStore";

describe("searchStore.refetchIfQueryNonEmpty (#148, rewired in #204)", () => {
  beforeEach(() => {
    searchStore.reset();
    hybridSearchMock.mockReset();
  });

  it("re-runs the current query and replaces results", async () => {
    searchStore.setQuery("#yoda");
    hybridSearchMock.mockResolvedValueOnce([
      { path: "a.md", title: "a", snippet: "", score: 1, matchCount: 0 },
      { path: "b.md", title: "b", snippet: "", score: 1, matchCount: 0 },
    ]);

    await searchStore.refetchIfQueryNonEmpty();

    expect(hybridSearchMock).toHaveBeenCalledTimes(1);
    expect(hybridSearchMock).toHaveBeenCalledWith("#yoda", 100);
    const s = get(searchStore);
    expect(s.results).toHaveLength(2);
    expect(s.totalFiles).toBe(2);
    expect(s.isSearching).toBe(false);
  });

  it("is a no-op when the query is empty (no fetch issued)", async () => {
    searchStore.setQuery("");
    await searchStore.refetchIfQueryNonEmpty();
    expect(hybridSearchMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the query is only whitespace", async () => {
    searchStore.setQuery("   ");
    await searchStore.refetchIfQueryNonEmpty();
    expect(hybridSearchMock).not.toHaveBeenCalled();
  });

  it("marks the index stale and clears isSearching on IndexCorrupt", async () => {
    searchStore.setQuery("#yoda");
    hybridSearchMock.mockRejectedValueOnce({ kind: "IndexCorrupt", message: "x" });

    await searchStore.refetchIfQueryNonEmpty();

    const s = get(searchStore);
    expect(s.isSearching).toBe(false);
    expect(s.indexStale).toBe(true);
  });

  it("does not flip indexStale on unrelated errors, but clears isSearching", async () => {
    searchStore.setQuery("#yoda");
    hybridSearchMock.mockRejectedValueOnce(new Error("network blip"));

    await searchStore.refetchIfQueryNonEmpty();

    const s = get(searchStore);
    expect(s.isSearching).toBe(false);
    expect(s.indexStale).toBe(false);
  });
});
