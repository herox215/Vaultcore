// scrollStore — coordinates scroll-to-match requests between OmniSearch and EditorPane.
// When a content-mode search result is clicked, OmniSearch calls requestScrollToMatch().
// EditorPane watches for pending requests and executes them once the EditorView is ready.
//
// This is a one-shot event store: EditorPane consumes the request immediately after
// executing it to prevent re-triggering on tab switches.
//
// #62: a wiki-link click on `[[Note^id]]` / `[[Note#H]]` produces a
// `ScrollRequest` with an explicit `range` instead of a `searchText` —
// EditorPane uses the precomputed JS code-unit offsets directly so the
// scroll is exact (no string-search fallback that could hit the wrong
// occurrence in the document).

import { writable } from "svelte/store";

export interface ScrollRequest {
  /** Absolute file path to scroll in. */
  filePath: string;
  /** Plain text to search for. Used when `range` is omitted (legacy
   * OmniSearch flow). */
  searchText: string;
  /** Optional explicit JS code-unit range — when present, EditorPane scrolls
   * directly to `[from, to)` instead of running a string search. Anchor
   * navigation (#62) populates this. */
  range?: { from: number; to: number };
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
   * Request a scroll to an explicit JS code-unit range — used by the
   * wiki-link click handler when an anchor (`^id` / `#H`) resolved (#62).
   * `searchText` is left empty because the range is authoritative.
   */
  requestScrollToRange(filePath: string, from: number, to: number): void {
    _store.set({
      pending: { filePath, searchText: "", range: { from, to }, token: crypto.randomUUID() },
    });
  },

  /**
   * Called by EditorPane after it has consumed and executed the request.
   */
  clearPending(): void {
    _store.set({ pending: null });
  },
};
