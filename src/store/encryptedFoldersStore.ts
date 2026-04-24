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
//
// #351: the store also owns the "close tabs on lock" side effect.
// Each refresh tracks which roots were locked last time; when a root
// transitions unlocked → locked (or appears freshly locked after an
// `encrypt_folder`), every open tab whose absolute path sits under
// that root is closed via `tabLifecycleStore.closeUnderPath`. The
// initial populate seeds the previous-locked snapshot without closing
// anything so that tabs restored from a persisted session are not
// retroactively evicted on vault open.

import { writable, derived, get, type Readable } from "svelte/store";

import { listEncryptedFolders } from "../ipc/commands";
import { listenEncryptedFoldersChanged } from "../ipc/events";
import { treeRefreshStore } from "./treeRefreshStore";
import { tabLifecycleStore } from "./tabLifecycleStore";
import { vaultStore } from "./vaultStore";
import type { EncryptedFolderView } from "../types/encryption";

interface StoreState {
  entries: EncryptedFolderView[];
  /** True once the first `list_encrypted_folders` call completes. */
  ready: boolean;
}

const internal = writable<StoreState>({ entries: [], ready: false });

let unlisten: (() => void) | null = null;

/**
 * #351: vault-relative paths that were reported as `locked: true` in
 * the most recent successful refresh. Drives the unlocked → locked
 * diff that triggers `tabLifecycleStore.closeUnderPath`. Lives at
 * module scope alongside `unlisten` — same lifecycle, cleared by
 * `resetEncryptedFoldersStore`.
 */
let previousLockedRelPaths = new Set<string>();

/**
 * #351: skip the close-tabs side effect on the very first refresh
 * after `initEncryptedFoldersStore`. A persisted-session scenario
 * (vault closed with tabs open inside an encrypted root; re-opened
 * later — the manifest always reports locked=true on cold start)
 * would otherwise close those tabs on every vault open. Seeding
 * once at init means the diff only fires on real transitions.
 */
let seeded = false;

/**
 * #351: serialize overlapping refreshes so the locked-path diff is
 * well-defined. Two `encrypted_folders_changed` events can arrive in
 * quick succession (e.g., auto-lock timers for two folders firing
 * within a few ms); without a chain guard the two async refreshes
 * both read-then-write `previousLockedRelPaths` against different
 * snapshots and one transition can be lost. The chain ensures each
 * refresh runs to completion before the next starts.
 */
let refreshChain: Promise<void> = Promise.resolve();

/** Read-only view of the raw manifest entries (salt stripped). */
export const encryptedFolders: Readable<EncryptedFolderView[]> = derived(
  internal,
  ($s) => $s.entries,
);

/**
 * Precomputed set of **vault-relative, forward-slash** paths whose
 * entry is tracked in the manifest. Does NOT distinguish locked vs
 * unlocked — use `EncryptedFolderView.locked` or consult
 * `DirEntry.encryption` for that signal. Callers that hold absolute
 * paths must normalize first (strip the vault prefix) before checking
 * membership — see the helper in `openFileAsTab.ts`.
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

/**
 * Compare `entries` against the previous locked-paths snapshot and
 * close tabs for every root that has newly transitioned into the
 * locked state. The first call after init only seeds the snapshot;
 * subsequent calls emit close events.
 *
 * Absolute path reconstruction mirrors `openFileAsTab.ts::findLockingRoot`:
 * take the vault root from `vaultStore.currentPath`, strip any trailing
 * separators, and join with the manifest's vault-relative path using
 * a forward slash. This is the same code path the tab originally used
 * when it was opened, so prefix matching against `tab.filePath` works
 * without an extra canonicalization round-trip.
 */
function reconcileLockedTabs(entries: EncryptedFolderView[]): void {
  const currentLocked = new Set(
    entries.filter((e) => e.locked).map((e) => e.path),
  );
  if (!seeded) {
    previousLockedRelPaths = currentLocked;
    seeded = true;
    return;
  }
  const newlyLocked: string[] = [];
  for (const rel of currentLocked) {
    if (!previousLockedRelPaths.has(rel)) newlyLocked.push(rel);
  }
  previousLockedRelPaths = currentLocked;
  if (newlyLocked.length === 0) return;

  const vaultRoot = get(vaultStore).currentPath;
  if (!vaultRoot) return;
  const normalizedVault = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const rel of newlyLocked) {
    const abs = `${normalizedVault}/${rel}`;
    tabLifecycleStore.closeUnderPath(abs);
  }
}

async function refresh(): Promise<void> {
  try {
    const entries = await listEncryptedFolders();
    internal.set({ entries, ready: true });
    reconcileLockedTabs(entries);
  } catch (e) {
    // Don't throw on refresh — transient IPC failure keeps the last
    // known state; the next `encrypted_folders_changed` event will
    // re-try. `previousLockedRelPaths` is intentionally NOT mutated
    // so the next successful refresh still observes the pending
    // unlocked → locked deltas. Log so bugs are observable in dev.
    // eslint-disable-next-line no-console
    console.warn("encryptedFoldersStore refresh failed", e);
  }
}

/** Chain a refresh onto the in-flight one so concurrent events serialize. */
function scheduleRefresh(): Promise<void> {
  // `refresh` catches its own errors internally — the chain never rejects,
  // so no second handler is needed.
  refreshChain = refreshChain.then(refresh);
  return refreshChain;
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
  // Reset the lock-diff state on every init so a vault switch does not
  // leak the previous vault's locked-paths snapshot into the new vault.
  // Also reset `refreshChain` — any in-flight refresh tail from the old
  // vault would otherwise drain AFTER `seeded` was cleared and seed
  // `previousLockedRelPaths` with stale old-vault paths, causing
  // spurious or missed close events on the new vault's first real diff.
  previousLockedRelPaths = new Set();
  seeded = false;
  refreshChain = Promise.resolve();
  await scheduleRefresh();
  try {
    unlisten = await listenEncryptedFoldersChanged(() => {
      void scheduleRefresh().then(() => {
        // #345: the sidebar's `DirEntry.encryption` is cached via the
        // tree model built from `list_directory`. Encrypt / unlock /
        // lock mutate that field on the backend but the cached tree
        // still shows the old state until we force a re-fetch. A
        // treeRefreshStore pulse here makes the unlock actually
        // reveal children and the lock actually re-hide them.
        treeRefreshStore.requestRefresh();
      });
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
  previousLockedRelPaths = new Set();
  seeded = false;
}

/** Test-only: manually push state. Do not use in production code. */
export function _setEncryptedFoldersForTest(entries: EncryptedFolderView[]): void {
  internal.set({ entries, ready: true });
}
