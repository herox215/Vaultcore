// vaultStore — classic Svelte `writable` store per D-06 / RC-01.
// Do NOT refactor to a Svelte 5 `$state` class wrapper: this decision is
// locked for Phase 1 in CONTEXT.md. Components subscribe via `$vaultStore`.
//
// Phase 2 additions:
// - treeCache: module-level Map<string, DirEntry[]> for lazy-loaded sidebar tree
// - sidebarWidth: persisted sidebar width (default 240px)

import { writable } from "svelte/store";
import type { VaultStatus } from "../types/vault";
import type { DirEntry } from "../types/tree";

export interface VaultState {
  currentPath: string | null;
  status: VaultStatus;
  fileList: string[];
  fileCount: number;
  errorMessage: string | null;
  sidebarWidth: number;
}

const initial: VaultState = {
  currentPath: null,
  status: "idle",
  fileList: [],
  fileCount: 0,
  errorMessage: null,
  sidebarWidth: 240,
};

// treeCache is kept as a module-level Map (not inside the store) because
// Maps don't serialize well in Svelte stores and the tree cache is ephemeral
// per-session state. Components call these helpers directly.
const _treeCache = new Map<string, DirEntry[]>();

const _store = writable<VaultState>({ ...initial });

export const vaultStore = {
  subscribe: _store.subscribe,
  setOpening(path: string): void {
    _store.update((s) => ({
      ...s,
      currentPath: path,
      status: "opening",
      errorMessage: null,
    }));
  },
  setIndexing(fileCount: number): void {
    _store.update((s) => ({ ...s, status: "indexing", fileCount }));
  },
  setReady(args: { currentPath: string; fileList: string[]; fileCount: number }): void {
    _store.update((s) => ({
      ...s,
      currentPath: args.currentPath,
      status: "ready",
      fileList: args.fileList,
      fileCount: args.fileCount,
      errorMessage: null,
    }));
  },
  setError(errorMessage: string): void {
    _store.update((s) => ({ ...s, status: "error", errorMessage }));
  },
  reset(): void {
    _treeCache.clear();
    _store.set({ ...initial });
  },
  setSidebarWidth(width: number): void {
    _store.update((s) => ({ ...s, sidebarWidth: width }));
  },

  // Tree cache helpers (module-level Map, not in store state)
  setTreeEntries(parentPath: string, entries: DirEntry[]): void {
    _treeCache.set(parentPath, entries);
  },
  getTreeEntries(parentPath: string): DirEntry[] | undefined {
    return _treeCache.get(parentPath);
  },
  invalidateTree(parentPath: string): void {
    _treeCache.delete(parentPath);
  },
};
