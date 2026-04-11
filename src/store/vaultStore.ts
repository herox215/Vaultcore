// vaultStore — classic Svelte `writable` store per D-06 / RC-01.
// Do NOT refactor to a Svelte 5 `$state` class wrapper: this decision is
// locked for Phase 1 in CONTEXT.md. Components subscribe via `$vaultStore`.

import { writable } from "svelte/store";
import type { VaultStatus } from "../types/vault";

export interface VaultState {
  currentPath: string | null;
  status: VaultStatus;
  fileList: string[];
  fileCount: number;
  errorMessage: string | null;
}

const initial: VaultState = {
  currentPath: null,
  status: "idle",
  fileList: [],
  fileCount: 0,
  errorMessage: null,
};

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
    _store.set({ ...initial });
  },
};
