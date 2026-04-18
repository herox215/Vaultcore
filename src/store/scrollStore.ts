// scrollStore — coordinates scroll-to-match requests between OmniSearch and EditorPane.
// When a content-mode search result is clicked, OmniSearch calls requestScrollToMatch().
// EditorPane watches for pending requests and executes them once the EditorView is ready.
//
// This is a one-shot event store: EditorPane consumes the request immediately after
// executing it to prevent re-triggering on tab switches.

import { writable } from "svelte/store";

export interface ScrollRequest {
  /** Absolute file path to scroll in. */
  filePath: string;
  /** Plain text to search for in the CM6 document (first occurrence). */
  searchText: string;
  /** Unique token to detect new requests (crypto.randomUUID()). */
  token: string;
}

interface ScrollStoreState {
  pending: ScrollRequest | null;
}

const _store = writable<ScrollStoreState>({ pending: null });

export const scrollStore = {
  subscribe: _store.subscribe,

  /**
   * Request that EditorPane scroll to the first occurrence of `searchText`
   * in the file at `filePath` and apply a flash highlight.
   */
  requestScrollToMatch(filePath: string, searchText: string): void {
    _store.set({ pending: { filePath, searchText, token: crypto.randomUUID() } });
  },

  /**
   * Called by EditorPane after it has consumed and executed the request.
   */
  clearPending(): void {
    _store.set({ pending: null });
  },
};
