// tagsStore — classic writable per D-06/RC-01.
// Mirrors backlinksStore's loading+error+reload pattern.
// Sourced from listTags() IPC; reloaded on vault open and on treeRefreshStore ticks
// (wired by Sidebar.svelte, not here — keep the store a pure data holder).

import { writable } from "svelte/store";
import { listTags } from "../ipc/commands";
import type { TagUsage } from "../types/tags";
import { isVaultError, vaultErrorCopy } from "../types/errors";

export interface TagsStoreState {
  tags: TagUsage[];       // alphabetically sorted by backend
  loading: boolean;
  error: string | null;   // German copy from vaultErrorCopy, or null
}

const initial: TagsStoreState = { tags: [], loading: false, error: null };

const _store = writable<TagsStoreState>({ ...initial });

export const tagsStore = {
  subscribe: _store.subscribe,

  async reload(): Promise<void> {
    _store.update((s) => ({ ...s, loading: true, error: null }));
    try {
      const tags = await listTags();
      _store.update((s) => ({ ...s, tags, loading: false, error: null }));
    } catch (e) {
      const msg = isVaultError(e) ? vaultErrorCopy(e) : String(e);
      _store.update((s) => ({ ...s, loading: false, error: msg }));
    }
  },

  reset(): void {
    _store.set({ ...initial });
  },
};
