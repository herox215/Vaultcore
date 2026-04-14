// Exposes the currently active CodeMirror 6 EditorView so right-sidebar
// panels (e.g. PropertiesPanel) can read and dispatch changes to the
// visible document. Updated by EditorPane whenever the active tab/pane
// changes and when views mount/unmount.
//
// `docVersion` is a simple counter bumped on every doc-changed update of
// ANY mounted view. Panels that derive state from `activeView.state.doc`
// re-read on each bump — inactive-view bumps are cheap no-ops because the
// active view's doc is unchanged.

import { writable } from "svelte/store";
import type { EditorView } from "@codemirror/view";

export interface ActiveViewState {
  view: EditorView | null;
  docVersion: number;
}

const _store = writable<ActiveViewState>({ view: null, docVersion: 0 });

export const activeViewStore = {
  subscribe: _store.subscribe,
  setActive(view: EditorView | null): void {
    _store.update((s) => ({ view, docVersion: s.docVersion + 1 }));
  },
  bumpDocVersion(): void {
    _store.update((s) => ({ ...s, docVersion: s.docVersion + 1 }));
  },
  clear(): void {
    _store.set({ view: null, docVersion: 0 });
  },
};
