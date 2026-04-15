import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { searchStore } from "../searchStore";
import { vaultStore } from "../vaultStore";
import type { SearchResult } from "../../types/search";

const RESULT: SearchResult = {
  path: "/tmp/vault-a/note.md",
  title: "Note",
  snippet: "alpha <b>beta</b> gamma",
  score: 1.0,
  matchCount: 1,
};

describe("searchStore clears on vault switch (#46)", () => {
  beforeEach(() => {
    searchStore.reset();
    vaultStore.reset();
  });

  it("resets query and results when currentPath changes from A to B", () => {
    // Open Vault A and seed a search result set.
    vaultStore.setReady({ currentPath: "/tmp/vault-a", fileList: [], fileCount: 0 });
    searchStore.setQuery("alpha");
    searchStore.setResults([RESULT], 1);
    expect(get(searchStore).query).toBe("alpha");
    expect(get(searchStore).results).toHaveLength(1);

    // Switch to Vault B — stale query + results should be cleared.
    vaultStore.setReady({ currentPath: "/tmp/vault-b", fileList: [], fileCount: 0 });
    const s = get(searchStore);
    expect(s.query).toBe("");
    expect(s.results).toEqual([]);
    expect(s.totalMatches).toBe(0);
    expect(s.totalFiles).toBe(0);
  });

  it("does not clear results when currentPath stays the same", () => {
    vaultStore.setReady({ currentPath: "/tmp/vault-a", fileList: [], fileCount: 0 });
    searchStore.setQuery("alpha");
    searchStore.setResults([RESULT], 1);

    // Same path emitted again (e.g. setReady after reindex) — preserve state.
    vaultStore.setReady({ currentPath: "/tmp/vault-a", fileList: [], fileCount: 0 });
    const s = get(searchStore);
    expect(s.query).toBe("alpha");
    expect(s.results).toHaveLength(1);
  });

  it("clears results when the vault is closed (path goes to null)", () => {
    vaultStore.setReady({ currentPath: "/tmp/vault-a", fileList: [], fileCount: 0 });
    searchStore.setQuery("alpha");
    searchStore.setResults([RESULT], 1);

    vaultStore.reset();
    const s = get(searchStore);
    expect(s.query).toBe("");
    expect(s.results).toEqual([]);
  });
});
