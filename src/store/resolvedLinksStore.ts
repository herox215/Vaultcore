// resolvedLinksStore — signals for the wiki-link resolution map in
// `components/Editor/wikiLink.ts`.
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
// Two tokens so producers and consumers see the right edge:
//   - requestToken — bumped by `requestReload()`. Owned by EditorPane, which
//     watches it and kicks off the async fetch.
//   - readyToken   — bumped by `markReady()` after `setResolvedLinks()` has
//     landed the new map. Watched by decoration layers (CM6 template plugin,
//     Reading Mode) that must rebuild against the *fresh* map. Without this
//     split, subscribers firing on `requestReload` would rebuild against the
//     stale map and the decoration would stay unresolved until the next
//     unrelated vault tick (#309).

import { writable } from "svelte/store";

interface ResolvedLinksReloadState {
  /** Bumped by `requestReload()` — map is stale, EditorPane should refetch. */
  requestToken: string | null;
  /** Bumped by `markReady()` after `setResolvedLinks()` lands — decoration layers should rebuild. */
  readyToken: string | null;
}

const _store = writable<ResolvedLinksReloadState>({
  requestToken: null,
  readyToken: null,
});

export const resolvedLinksStore = {
  subscribe: _store.subscribe,

  /** Signal that the stem->relPath map is stale and should be re-fetched. */
  requestReload(): void {
    _store.update((s) => ({ ...s, requestToken: crypto.randomUUID() }));
  },

  /** Signal that `setResolvedLinks()` has just landed a fresh map; decorations should rebuild. */
  markReady(): void {
    _store.update((s) => ({ ...s, readyToken: crypto.randomUUID() }));
  },
};
