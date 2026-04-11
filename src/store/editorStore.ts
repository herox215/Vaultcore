// editorStore — classic Svelte `writable` store per D-06 / RC-01.
// Plan 01-03 wires the CodeMirror 6 editor on top of this. The shape is
// intentionally minimal: `lastSavedHash` is the handshake with the auto-save
// loop (2-second fixed interval, no manual save, no dirty indicator).

import { writable } from "svelte/store";

export interface EditorState {
  activePath: string | null;
  content: string;
  lastSavedHash: string | null;
}

const initial: EditorState = {
  activePath: null,
  content: "",
  lastSavedHash: null,
};

const _store = writable<EditorState>({ ...initial });

export const editorStore = {
  subscribe: _store.subscribe,
  openFile(path: string, content: string): void {
    _store.set({ activePath: path, content, lastSavedHash: null });
  },
  setContent(content: string): void {
    _store.update((s) => ({ ...s, content }));
  },
  setLastSavedHash(hash: string): void {
    _store.update((s) => ({ ...s, lastSavedHash: hash }));
  },
  close(): void {
    _store.set({ ...initial });
  },
};
