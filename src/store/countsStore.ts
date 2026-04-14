// countsStore — per-pane word/character counts published by the CM6
// countsPlugin and consumed by the status bar in EditorPane.
//
// Two panes can each host their own EditorView, so the store is keyed by
// pane id. `selection` is true when the counts reflect a non-empty
// selection rather than the full document — the status bar uses this to
// switch its label from "X words" to "X words selected".

import { writable } from "svelte/store";

export interface PaneCounts {
  words: number;
  characters: number;
  /** True when the counts reflect a non-empty selection rather than the whole doc. */
  selection: boolean;
}

export type PaneId = "left" | "right";

interface CountsState {
  left: PaneCounts | null;
  right: PaneCounts | null;
}

const initial: CountsState = { left: null, right: null };

const _store = writable<CountsState>({ ...initial });

export const countsStore = {
  subscribe: _store.subscribe,
  set(paneId: PaneId, counts: PaneCounts): void {
    _store.update((s) => ({ ...s, [paneId]: counts }));
  },
  clear(paneId: PaneId): void {
    _store.update((s) => ({ ...s, [paneId]: null }));
  },
  reset(): void {
    _store.set({ ...initial });
  },
};
