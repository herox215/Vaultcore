// progressStore — scaffold for plan 01-04 (file-walk progress events).
// Classic Svelte `writable` per D-06 / RC-01. Plan 01-04 wires the Tauri
// `vault://index_progress` event stream into `update(...)`.

import { writable } from "svelte/store";

export interface ProgressState {
  active: boolean;
  current: number;
  total: number;
  currentFile: string;
}

const initial: ProgressState = {
  active: false,
  current: 0,
  total: 0,
  currentFile: "",
};

const _store = writable<ProgressState>({ ...initial });

export const progressStore = {
  subscribe: _store.subscribe,
  start(total: number): void {
    _store.set({ active: true, current: 0, total, currentFile: "" });
  },
  update(current: number, total: number, currentFile: string): void {
    _store.set({
      active: current < total,
      current,
      total,
      currentFile,
    });
  },
  finish(): void {
    _store.update((s) => ({ ...s, active: false }));
  },
  reset(): void {
    _store.set({ ...initial });
  },
};
