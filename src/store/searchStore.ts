// searchStore — classic Svelte `writable` store per D-06 / RC-01.
// Do NOT refactor to a Svelte 5 `$state` class wrapper — this decision is
// locked for Phase 1 in CONTEXT.md. Components subscribe via `$searchStore`.
//
// State owned here:
//   - query:        current search input text
//   - results:      array of Tantivy SearchResult objects
//   - totalMatches: count of matched results (capped at Tantivy's `limit`)
//   - totalFiles:   unique files matched (computed from results)
//   - isSearching:  true while a search IPC call is in-flight
//   - isRebuilding: true while rebuild_index is in-flight
//   - activeTab:    sidebar tab — "files" (file browser) | "search" (results)

import { writable } from "svelte/store";
import type { SearchResult } from "../types/search";
import { searchFulltext } from "../ipc/commands";
import { vaultStore } from "./vaultStore";

export interface SearchStoreState {
  query: string;
  results: SearchResult[];
  /** Total results returned (capped at limit, typically 100). */
  totalMatches: number;
  /** Number of unique file paths in results. */
  totalFiles: number;
  /** True while a search_fulltext IPC call is in-flight. */
  isSearching: boolean;
  /** True while a rebuild_index IPC call is in-flight. */
  isRebuilding: boolean;
  /** Controls which sidebar panel is visible (D-01). */
  activeTab: "files" | "search" | "tags";
}

const initial: SearchStoreState = {
  query: "",
  results: [],
  totalMatches: 0,
  totalFiles: 0,
  isSearching: false,
  isRebuilding: false,
  activeTab: "files",
};

function createSearchStore() {
  const { subscribe, set, update } = writable<SearchStoreState>({ ...initial });

  return {
    subscribe,

    /** Update the search query string (called on every keystroke). */
    setQuery: (query: string) => update((s) => ({ ...s, query })),

    /**
     * Store search results returned by search_fulltext.
     * Also clears isSearching and computes unique file count.
     */
    setResults: (results: SearchResult[], totalFiles: number) =>
      update((s) => ({
        ...s,
        results,
        totalMatches: results.length,
        totalFiles,
        isSearching: false,
      })),

    /** Mark a search IPC call as in-flight (true) or completed (false). */
    setSearching: (isSearching: boolean) =>
      update((s) => ({ ...s, isSearching })),

    /** Mark a rebuild_index IPC call as in-flight (true) or completed (false). */
    setRebuilding: (isRebuilding: boolean) =>
      update((s) => ({ ...s, isRebuilding })),

    /** Switch the sidebar between the file browser, search results, and tags panels. */
    setActiveTab: (tab: "files" | "search" | "tags") =>
      update((s) => ({ ...s, activeTab: tab })),

    /** Clear results and query — called on vault close or explicit dismiss. */
    clearResults: () =>
      update((s) => ({
        ...s,
        results: [],
        totalMatches: 0,
        totalFiles: 0,
        query: "",
      })),

    /**
     * Set the query AND execute the full-text search, populating results.
     *
     * Used by the Tags panel (tag-click) and any other caller that needs to
     * programmatically run a search. Equivalent to typing `query` into the
     * search box, but works from outside the SearchPanel component.
     */
    runSearch: async (query: string): Promise<void> => {
      update((s) => ({ ...s, query, activeTab: "search" }));
      if (!query.trim()) {
        update((s) => ({ ...s, results: [], totalMatches: 0, totalFiles: 0 }));
        return;
      }
      update((s) => ({ ...s, isSearching: true }));
      try {
        const results = await searchFulltext(query, 100);
        const uniqueFileCount = new Set(results.map((r) => r.path)).size;
        update((s) => ({
          ...s,
          results,
          totalMatches: results.length,
          totalFiles: uniqueFileCount,
          isSearching: false,
        }));
      } catch {
        update((s) => ({ ...s, isSearching: false }));
      }
    },

    /** Full reset to initial state (vault close / new vault open). */
    reset: () => set({ ...initial }),
  };
}

export const searchStore = createSearchStore();

// Issue #46: when the active vault changes, drop the cached query and
// results. Without this, a search run in Vault A continues to render its
// old hits after switching to Vault B — the results list still points to
// files that don't exist under the new vault root.
let _prevVaultPath: string | null = null;
let _vaultSubInitialised = false;
vaultStore.subscribe((s) => {
  // Skip the initial synchronous emission on import — the store is
  // already at its `initial` state, so there's nothing to clear.
  if (!_vaultSubInitialised) {
    _vaultSubInitialised = true;
    _prevVaultPath = s.currentPath;
    return;
  }
  if (s.currentPath !== _prevVaultPath) {
    _prevVaultPath = s.currentPath;
    searchStore.reset();
  }
});
