// treeRevealStore — one-shot signal that tells the Sidebar to reveal a given
// vault-relative path in the file tree: expand every ancestor folder and scroll
// the target row into view.
//
// Consumers:
//   - Sidebar adds all ancestor folders to its persisted TreeState.expanded list
//     so newly rendered TreeNodes mount in an expanded state.
//   - TreeNode auto-expands when the request targets a descendant, and scrolls
//     its own row into view when the request targets it directly.
//
// Pattern mirrors treeRefreshStore / scrollStore: a monotonic token makes each
// new request distinguishable so subscribers can de-duplicate.

import { writable } from "svelte/store";

export interface TreeRevealRequest {
  /** Vault-relative path (forward slashes, no leading slash) of the target. */
  relPath: string;
  /** Unique token — changes on every request (crypto.randomUUID()). */
  token: string;
}

interface TreeRevealState {
  pending: TreeRevealRequest | null;
}

const _store = writable<TreeRevealState>({ pending: null });

export const treeRevealStore = {
  subscribe: _store.subscribe,

  /**
   * Request that the sidebar reveal `relPath` — expand its ancestors and
   * scroll the row into view.
   */
  requestReveal(relPath: string): void {
    _store.set({ pending: { relPath, token: crypto.randomUUID() } });
  },

  /** Called by consumers after the request has been processed. */
  clearPending(): void {
    _store.set({ pending: null });
  },
};
