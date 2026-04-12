// treeRefreshStore — one-shot signal that tells Sidebar to re-fetch its root listing.
//
// The file watcher's write-ignore-list suppresses events for backend-initiated
// writes (auto-save, create_file from click-to-create, etc.), so Sidebar cannot
// rely on listenFileChange to learn about all new/removed files. Callers that
// know they just mutated the vault (e.g. EditorPane's click-to-create) call
// requestRefresh() to force a sidebar reload.
//
// Pattern mirrors scrollStore: monotonic token signals a new request;
// consumer (Sidebar) watches for changes and calls loadRoot().

import { writable } from "svelte/store";

interface TreeRefreshState {
  /** Opaque token — changes on every request. */
  token: string | null;
}

const _store = writable<TreeRefreshState>({ token: null });

export const treeRefreshStore = {
  subscribe: _store.subscribe,

  /** Signal that the vault tree has changed and should be re-fetched. */
  requestRefresh(): void {
    _store.set({ token: crypto.randomUUID() });
  },
};
