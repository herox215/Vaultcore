// bookmarksStore — classic writable per D-06 / RC-01 (#12).
// Holds the user-ordered list of vault-relative bookmarked paths.
// Every mutation persists immediately via the saveBookmarks IPC.

import { writable, get } from "svelte/store";
import { loadBookmarks, saveBookmarks } from "../ipc/commands";
import { toastStore } from "./toastStore";
import { isVaultError, vaultErrorCopy } from "../types/errors";

export interface BookmarksState {
  paths: string[];
  loaded: boolean;
}

const initial: BookmarksState = { paths: [], loaded: false };

const _store = writable<BookmarksState>({ ...initial });

function pushError(e: unknown): void {
  const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
  toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
}

async function persist(vaultPath: string, paths: string[]): Promise<void> {
  try {
    await saveBookmarks(vaultPath, paths);
  } catch (e) {
    pushError(e);
  }
}

export const bookmarksStore = {
  subscribe: _store.subscribe,

  async load(vaultPath: string): Promise<void> {
    try {
      const paths = await loadBookmarks(vaultPath);
      _store.set({ paths, loaded: true });
    } catch (e) {
      _store.set({ paths: [], loaded: true });
      pushError(e);
    }
  },

  async toggle(relPath: string, vaultPath: string): Promise<void> {
    if (!relPath) return;
    const current = get(_store).paths;
    const idx = current.indexOf(relPath);
    const next = idx >= 0 ? current.filter((p) => p !== relPath) : [...current, relPath];
    _store.update((s) => ({ ...s, paths: next }));
    await persist(vaultPath, next);
  },

  async remove(relPath: string, vaultPath: string): Promise<void> {
    const current = get(_store).paths;
    if (!current.includes(relPath)) return;
    const next = current.filter((p) => p !== relPath);
    _store.update((s) => ({ ...s, paths: next }));
    await persist(vaultPath, next);
  },

  async reorder(newPaths: string[], vaultPath: string): Promise<void> {
    _store.update((s) => ({ ...s, paths: [...newPaths] }));
    await persist(vaultPath, newPaths);
  },

  /**
   * Internal helper used by the rename-tracker. Replaces `oldRel` with
   * `newRel` in-place (preserves order). Persists when the path was bookmarked.
   */
  async renamePath(oldRel: string, newRel: string, vaultPath: string): Promise<void> {
    const current = get(_store).paths;
    const idx = current.indexOf(oldRel);
    if (idx < 0) return;
    const next = [...current];
    next[idx] = newRel;
    _store.update((s) => ({ ...s, paths: next }));
    await persist(vaultPath, next);
  },

  isBookmarked(relPath: string): boolean {
    return get(_store).paths.includes(relPath);
  },

  reset(): void {
    _store.set({ ...initial });
  },
};
