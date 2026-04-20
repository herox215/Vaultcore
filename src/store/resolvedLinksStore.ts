// resolvedLinksStore — one-shot signal that the wiki-link resolution map in
// `components/Editor/wikiLink.ts` is stale and must be re-fetched.
//
// The module-level `resolvedLinks: Map<stem, relPath>` is populated once per
// vault open via EditorPane and refreshed on click-to-create. It does NOT
// update on user-initiated rename/move, because those paths bypass the
// watcher (write_ignore / D-12) and therefore never reach the pane's
// listenFileChange handler — leaving the map pointing at the OLD rel_path.
// Sidebar call sites that rename or move files dispatch `requestReload()`
// so EditorPane re-runs `getResolvedLinks` + `getResolvedAttachments` and
// nudges every mounted view to rebuild decorations (#277).
//
// Pattern mirrors treeRefreshStore / scrollStore: monotonic token signals a
// new request; consumer (EditorPane) watches for changes and calls
// reloadResolvedLinks().

import { writable } from "svelte/store";

interface ResolvedLinksReloadState {
  /** Opaque token — changes on every request. */
  token: string | null;
}

const _store = writable<ResolvedLinksReloadState>({ token: null });

export const resolvedLinksStore = {
  subscribe: _store.subscribe,

  /** Signal that the stem->relPath map is stale and should be re-fetched. */
  requestReload(): void {
    _store.set({ token: crypto.randomUUID() });
  },
};
