// tabReloadStore — one-shot reload signal for externally rewritten files.
//
// Callers that know they just externally rewrote files on disk (e.g. rename-
// cascade) call `request(paths)` with the vault-relative paths of affected
// files. EditorPane subscribes and, for each path whose absolute form matches
// an open tab, re-reads the file and dispatches a doc-replace transaction to
// the CM6 view. Token-based one-shot pattern mirrors scrollStore /
// treeRefreshStore.
//
// Background: the rename-cascade suppresses the watcher via write_ignore to
// avoid double-indexing, but that also suppresses any editor merge
// notification — so open tabs would keep showing stale content and the next
// auto-save would silently revert the cascade's work.
//
// This facade is its own private writable (`_signal`), independent of
// tabStoreCore. Per-tab save-snapshot mutations (setLastSavedContent /
// setLastSavedHash) live on tabLifecycleStore alongside the rest of the
// per-tab metadata — they share the Tab-shape slice of the core store.

import { writable } from "svelte/store";

export interface TabReloadRequest {
  /** Opaque token — changes on every request to detect re-subscribe re-triggers. */
  token: string;
  /** Vault-relative paths of files to reload. */
  paths: string[];
}

interface TabReloadState {
  pending: TabReloadRequest | null;
}

const _signal = writable<TabReloadState>({ pending: null });

export const tabReloadStore = {
  subscribe: _signal.subscribe,

  /** Signal that `paths` were externally rewritten and open tabs need reload. */
  request(paths: string[]): void {
    if (paths.length === 0) return;
    _signal.set({ pending: { token: crypto.randomUUID(), paths } });
  },

  /** Test helper — clears the one-shot reload signal. */
  _reset(): void {
    _signal.set({ pending: null });
  },
};
