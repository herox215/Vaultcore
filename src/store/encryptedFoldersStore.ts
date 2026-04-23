// #345 — frontend store for the encrypted-folders registry.
//
// Mirrors the backend `list_encrypted_folders` IPC + subscribes to
// the `vault://encrypted_folders_changed` event stream. Every
// encrypt / unlock / lock / lock_all mutation on the backend causes
// this store to re-fetch the list — there is no partial-update
// protocol because the manifest is small (< 10 entries in practice).
//
// Contract:
// - `initFromVault(absoluteVaultPath)` is called by `vaultStore`
//   when it transitions to `ready`. Subsequent vault switches call
//   it again; the previous subscription is cleaned up first.
// - `reset()` clears the store and unsubscribes. Called on vault
//   close.
// - Components subscribe via the Svelte store contract; the public
//   state carries the salt-less `EncryptedFolderView[]` and a
//   convenience `lockedPaths: Set<string>` of vault-relative paths
//   that the sidebar and command palette can consult without doing
//   their own filtering.

import { writable, derived, type Readable } from "svelte/store";

import { listEncryptedFolders } from "../ipc/commands";
import { listenEncryptedFoldersChanged } from "../ipc/events";
import { treeRefreshStore } from "./treeRefreshStore";
import type { EncryptedFolderView } from "../types/encryption";

interface StoreState {
  entries: EncryptedFolderView[];
  /** True once the first `list_encrypted_folders` call completes. */
  ready: boolean;
}

const internal = writable<StoreState>({ entries: [], ready: false });

let unlisten: (() => void) | null = null;

/** Read-only view of the raw manifest entries (salt stripped). */
export const encryptedFolders: Readable<EncryptedFolderView[]> = derived(
  internal,
  ($s) => $s.entries,
);

/**
 * Precomputed set of **vault-relative, forward-slash** paths whose
 * entry is tracked in the manifest. Does NOT distinguish locked vs
 * unlocked — that signal lives on `DirEntry.encryption` straight from
 * the backend. Callers that hold absolute paths must normalize first
 * (strip the vault prefix) before checking membership — see the
 * helper in `openFileAsTab.ts`.
 */
export const encryptedPaths: Readable<Set<string>> = derived(
  internal,
  ($s) => new Set($s.entries.map((e) => e.path)),
);

/** `true` once the store has completed its first fetch. */
export const encryptedFoldersReady: Readable<boolean> = derived(
  internal,
  ($s) => $s.ready,
);

async function refresh(): Promise<void> {
  try {
    const entries = await listEncryptedFolders();
    internal.set({ entries, ready: true });
  } catch (e) {
    // Don't throw on refresh — transient IPC failure keeps the last
    // known state; the next `encrypted_folders_changed` event will
    // re-try. Log so bugs are observable in dev.
    // eslint-disable-next-line no-console
    console.warn("encryptedFoldersStore refresh failed", e);
  }
}

/**
 * Populate the store and subscribe to update events. Safe to call on
 * every vault open — tears down the previous subscription first.
 *
 * Both the fetch and the subscribe are guarded so a broken IPC layer
 * (offline test fixtures, partial hot-reload) cannot break vault
 * open. The store simply stays empty.
 */
export async function initEncryptedFoldersStore(): Promise<void> {
  if (unlisten) {
    try {
      unlisten();
    } catch { /* swallow */ }
    unlisten = null;
  }
  await refresh();
  try {
    unlisten = await listenEncryptedFoldersChanged(() => {
      void refresh();
      // #345: the sidebar's `DirEntry.encryption` is cached via the
      // tree model built from `list_directory`. Encrypt / unlock /
      // lock mutate that field on the backend but the cached tree
      // still shows the old state until we force a re-fetch. A
      // treeRefreshStore pulse here makes the unlock actually
      // reveal children and the lock actually re-hide them.
      treeRefreshStore.requestRefresh();
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("encryptedFoldersStore subscribe failed", e);
    unlisten = null;
  }
}

/** Clear state and unsubscribe. Called on vault close / app teardown. */
export function resetEncryptedFoldersStore(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  internal.set({ entries: [], ready: false });
}

/** Test-only: manually push state. Do not use in production code. */
export function _setEncryptedFoldersForTest(entries: EncryptedFolderView[]): void {
  internal.set({ entries, ready: true });
}
