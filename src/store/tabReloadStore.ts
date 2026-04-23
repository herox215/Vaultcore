// tabReloadStore — disk-sync signals and post-save snapshot state (#341).
//
// Two responsibilities:
//
//   1. One-shot reload signal — callers that externally rewrote files on
//      disk (e.g. rename-cascade) call `request(paths)` with vault-relative
//      paths. EditorPane subscribes and, for each path whose absolute form
//      matches an open tab, re-reads the file and dispatches a doc-replace
//      transaction to the CM6 view. Token-based one-shot pattern mirrors
//      scrollStore / treeRefreshStore.
//
//      Background: the rename-cascade suppresses the watcher via
//      write_ignore to avoid double-indexing, but that also suppresses any
//      editor merge notification — so open tabs would keep showing stale
//      content and the next auto-save would silently revert the cascade's
//      work.
//
//   2. Per-tab save snapshot state — setLastSavedContent writes the base
//      snapshot used for three-way merge (Plan 05); setLastSavedHash
//      records the SHA-256 VaultCore wrote so auto-save can verify the
//      disk hasn't drifted (#80 — previously a global hash leaked across
//      tabs).
//
// These two concerns live together because both react to disk-sync events
// produced by the save/watcher pipeline.

import { writable } from "svelte/store";
import { _core } from "./tabStoreCore";

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

  /**
   * Update the base snapshot content used for three-way merge (Plan 05).
   * Called after auto-save completes, so the snapshot tracks what's on disk.
   */
  setLastSavedContent(tabId: string, content: string): void {
    _core.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, lastSavedContent: content } : t)),
    }));
  },

  /**
   * Record the SHA-256 hash VaultCore wrote for this tab's last save.
   * Called by EditorPane after every successful writeFile so the auto-save
   * merge-check can compare disk hash against the per-tab expected hash
   * (#80 — global editorStore.lastSavedHash leaked across tabs).
   */
  setLastSavedHash(tabId: string, hash: string | null): void {
    _core.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, lastSavedHash: hash } : t)),
    }));
  },

  /** Test helper — clears the one-shot reload signal. */
  _reset(): void {
    _signal.set({ pending: null });
  },
};
