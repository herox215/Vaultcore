// tabReloadStore — signals EditorPane to reload specific files from disk.
//
// Use case: the backend rewrote one or more files on disk (e.g. rename-cascade
// rewrites all wiki-link sources). The rename-cascade suppresses the watcher
// via write_ignore to avoid double-indexing, but that also suppresses any
// editor merge notification — so open tabs would keep showing the stale content
// and the next auto-save would silently revert the cascade's work.
//
// Callers that know they just externally rewrote files call `request(paths)`
// with the vault-relative paths of affected files. EditorPane subscribes and,
// for each path whose absolute form matches an open tab, re-reads the file
// and dispatches a doc-replace transaction to the CM6 view.
//
// Pattern mirrors scrollStore / treeRefreshStore: token-based one-shot signal.

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

const _store = writable<TabReloadState>({ pending: null });

export const tabReloadStore = {
  subscribe: _store.subscribe,

  /** Signal that `paths` were externally rewritten and open tabs need reload. */
  request(paths: string[]): void {
    if (paths.length === 0) return;
    _store.set({ pending: { token: crypto.randomUUID(), paths } });
  },
};
