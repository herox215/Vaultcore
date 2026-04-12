import { writable } from "svelte/store";
import type { BacklinkEntry } from "../types/links";
import { getBacklinks } from "../ipc/commands";

interface BacklinksState {
  open: boolean;
  width: number;
  activeFilePath: string | null;
  backlinks: BacklinkEntry[];
  loading: boolean;
}

const STORAGE_KEY_OPEN = "vaultcore-backlinks-open";
const STORAGE_KEY_WIDTH = "vaultcore-backlinks-width";
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 180;
const MAX_WIDTH = 400;

function loadOpen(): boolean {
  try { return localStorage.getItem(STORAGE_KEY_OPEN) === "true"; }
  catch { return false; }
}

function loadWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_KEY_WIDTH) || "", 10);
    if (isNaN(v)) return DEFAULT_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, v));
  } catch { return DEFAULT_WIDTH; }
}

const { subscribe, set: _set, update } = writable<BacklinksState>({
  open: loadOpen(),
  width: loadWidth(),
  activeFilePath: null,
  backlinks: [],
  loading: false,
});

export const backlinksStore = {
  subscribe,
  toggle(): void {
    update((s) => {
      const next = !s.open;
      try { localStorage.setItem(STORAGE_KEY_OPEN, String(next)); } catch { /* ignore */ }
      return { ...s, open: next };
    });
  },
  setOpen(open: boolean): void {
    update((s) => {
      try { localStorage.setItem(STORAGE_KEY_OPEN, String(open)); } catch { /* ignore */ }
      return { ...s, open };
    });
  },
  setWidth(width: number): void {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
    update((s) => {
      try { localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped)); } catch { /* ignore */ }
      return { ...s, width: clamped };
    });
  },
  async setActiveFile(relPath: string | null): Promise<void> {
    update((s) => ({ ...s, activeFilePath: relPath, loading: true }));
    if (!relPath) {
      update((s) => ({ ...s, backlinks: [], loading: false }));
      return;
    }
    try {
      const entries = await getBacklinks(relPath);
      update((s) => ({ ...s, backlinks: entries, loading: false }));
    } catch {
      update((s) => ({ ...s, backlinks: [], loading: false }));
    }
  },
};
