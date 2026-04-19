// searchStore — classic Svelte `writable` store per D-06 / RC-01.
// Do NOT refactor to a Svelte 5 `$state` class wrapper — this decision is
// locked for Phase 1 in CONTEXT.md. Components subscribe via `$searchStore`.
//
// State owned here:
//   - query:        current search input text (content mode)
//   - results:      array of Tantivy SearchResult objects
//   - totalMatches: count of matched results (capped at Tantivy's `limit`)
//   - totalFiles:   unique files matched (computed from results)
//   - isSearching:  true while a search IPC call is in-flight
//   - isRebuilding: true while rebuild_index is in-flight
//   - activeTab:    sidebar tab — "files" (file browser) | "tags"

import { writable } from "svelte/store";
import type { HybridHit } from "../types/search";
import { hybridSearch } from "../ipc/commands";
import { isVaultError } from "../types/errors";
import { vaultStore } from "./vaultStore";

export interface SearchStoreState {
  query: string;
  results: HybridHit[];
  /** Total results returned (capped at limit, typically 100). */
  totalMatches: number;
  /** Number of unique file paths in results. */
  totalFiles: number;
  /** True while a search_fulltext IPC call is in-flight. */
  isSearching: boolean;
  /** True while a rebuild_index IPC call is in-flight. */
  isRebuilding: boolean;
  /** True when the search index is stale or corrupt (Issue #82). */
  indexStale: boolean;
  /**
   * Controls which sidebar panel is visible. The dedicated "Suche" tab was
   * removed in #174 (omni-search replaces the sidebar search panel); this
   * field now only toggles between the file tree and the tags panel.
   */
  activeTab: "files" | "tags";
}

const initial: SearchStoreState = {
  query: "",
  results: [],
  totalMatches: 0,
  totalFiles: 0,
  isSearching: false,
  isRebuilding: false,
  indexStale: false,
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
    setResults: (results: HybridHit[], totalFiles: number) =>
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

    /** Mark the search index as stale/corrupt or healthy (Issue #82). */
    setIndexStale: (indexStale: boolean) =>
      update((s) => ({ ...s, indexStale })),

    /** Switch the sidebar between the file browser and the tags panel. */
    setActiveTab: (tab: "files" | "tags") =>
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
     * Re-execute the current query against the freshly-built index.
     *
     * Called after a successful rebuild (#148). If the query is empty there
     * is nothing to fetch; otherwise we re-issue `hybrid_search` and replace
     * the results so the panel reflects newly-indexed content without the
     * user having to edit the query. #204 switched the rebuild refetch from
     * BM25-only to the RRF-fused hybrid result so the statusbar rebuild path
     * stays consistent with the live search dispatch in OmniSearch.
     */
    refetchIfQueryNonEmpty: async (): Promise<void> => {
      let query = "";
      const unsubscribe = subscribe((s) => {
        query = s.query;
      });
      unsubscribe();
      if (!query.trim()) return;
      update((s) => ({ ...s, isSearching: true }));
      try {
        const results = await hybridSearch(query, 100);
        const uniqueFileCount = new Set(results.map((r) => r.path)).size;
        update((s) => ({
          ...s,
          results,
          totalMatches: results.length,
          totalFiles: uniqueFileCount,
          isSearching: false,
        }));
      } catch (e) {
        if (isVaultError(e) && e.kind === "IndexCorrupt") {
          update((s) => ({ ...s, isSearching: false, indexStale: true }));
        } else {
          update((s) => ({ ...s, isSearching: false }));
        }
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
