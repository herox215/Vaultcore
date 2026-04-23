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
import type { FileChangePayload } from "../ipc/events";

export interface VaultState {
  currentPath: string | null;
  status: VaultStatus;
  fileList: string[];
  fileCount: number;
  errorMessage: string | null;
  sidebarWidth: number;
  vaultReachable: boolean;  // ERR-03: false when vault folder is unmounted/unreachable
}

const initial: VaultState = {
  currentPath: null,
  status: "idle",
  fileList: [],
  fileCount: 0,
  errorMessage: null,
  sidebarWidth: 240,
  vaultReachable: true,
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
    // #345: prime the encrypted-folders store + subscribe to change
    // events. Safe to call on every vault open — the store tears down
    // any previous subscription before re-initialising. Import errors
    // (missing mocks in tests, hot-reload partials) are swallowed so
    // an unrelated vault-open does not fail downstream.
    void import("./encryptedFoldersStore")
      .then((mod) => mod.initEncryptedFoldersStore())
      .catch(() => {});
  },
  setError(errorMessage: string): void {
    _store.update((s) => ({ ...s, status: "error", errorMessage }));
  },
  reset(): void {
    _treeCache.clear();
    _store.set({ ...initial });
    // #345: drop any encrypted-folders state the previous vault owned.
    // Same tolerant pattern as setReady — swallow import errors so
    // reset() always completes cleanly.
    void import("./encryptedFoldersStore")
      .then((mod) => {
        mod.resetEncryptedFoldersStore();
      })
      .catch(() => {});
  },
  setSidebarWidth(width: number): void {
    _store.update((s) => ({ ...s, sidebarWidth: width }));
  },

  setVaultReachable(reachable: boolean): void {
    _store.update((s) => ({ ...s, vaultReachable: reachable }));
  },

  // #307 — incremental fileList updater driven by vault://file_changed events.
  // Keeps the list in sync with the filesystem without re-listing the whole
  // vault (O(log n) per event, survives 100k-note vaults). Out-of-root and
  // non-.md paths are ignored; the vault root is read from `currentPath`.
  applyFileChange(payload: FileChangePayload): void {
    _store.update((s) => {
      if (s.currentPath === null) return s;
      const root = s.currentPath.replace(/\\/g, "/");

      const toRel = (abs: string): string | null => {
        const normalized = abs.replace(/\\/g, "/");
        if (!normalized.startsWith(root)) return null;
        let rel = normalized.slice(root.length);
        if (rel.startsWith("/")) rel = rel.slice(1);
        if (!rel.endsWith(".md")) return null;
        return rel;
      };

      const insert = (list: string[], rel: string): string[] => {
        if (list.includes(rel)) return list;
        let idx = 0;
        while (idx < list.length && list[idx]! < rel) idx++;
        const next = list.slice();
        next.splice(idx, 0, rel);
        return next;
      };

      const remove = (list: string[], rel: string): string[] => {
        const idx = list.indexOf(rel);
        if (idx === -1) return list;
        const next = list.slice();
        next.splice(idx, 1);
        return next;
      };

      let list = s.fileList;
      switch (payload.kind) {
        case "create": {
          const rel = toRel(payload.path);
          if (rel !== null) list = insert(list, rel);
          break;
        }
        case "delete": {
          const rel = toRel(payload.path);
          if (rel !== null) list = remove(list, rel);
          break;
        }
        case "rename": {
          if (payload.new_path === undefined) break;
          const oldRel = toRel(payload.path);
          const newRel = toRel(payload.new_path);
          if (oldRel !== null) list = remove(list, oldRel);
          if (newRel !== null) list = insert(list, newRel);
          break;
        }
        case "modify":
          break;
      }

      if (list === s.fileList) return s;
      return { ...s, fileList: list, fileCount: list.length };
    });
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
