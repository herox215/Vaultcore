// Extensible command registry (#13).
// Wraps a Map<id, Command> in a classic writable store so the palette and
// settings table stay reactive.

import { writable } from "svelte/store";

export interface HotKey {
  /** Cmd (Mac) or Ctrl (other) — treated equivalently. */
  meta: boolean;
  shift?: boolean;
  /** Case-insensitive; compared via toLowerCase of event.key. */
  key: string;
}

export interface Command {
  id: string;
  name: string;
  callback: () => void | Promise<void>;
  hotkey?: HotKey;
}

export interface CommandRegistry {
  subscribe: ReturnType<typeof writable<Command[]>>["subscribe"];
  register(cmd: Command): void;
  unregister(id: string): void;
  execute(id: string): void;
  list(): Command[];
  findByHotkey(event: KeyboardEvent): Command | null;
  /** Ids ordered most-recently-executed first (capped at MRU_CAP). */
  getMru(): string[];
  /** Clear the MRU list and in-memory map. Tests only. */
  _reset(): void;
}

const MRU_KEY = "vaultcore-command-palette-mru";
const MRU_CAP = 20;

function loadMru(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(MRU_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, MRU_CAP);
  } catch {
    return [];
  }
}

function persistMru(mru: string[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MRU_KEY, JSON.stringify(mru.slice(0, MRU_CAP)));
  } catch {
    // Best-effort.
  }
}

function createRegistry(): CommandRegistry {
  const map = new Map<string, Command>();
  const store = writable<Command[]>([]);
  let mru: string[] = loadMru();

  function emit(): void {
    store.set(Array.from(map.values()));
  }

  function register(cmd: Command): void {
    map.set(cmd.id, cmd);
    emit();
  }

  function unregister(id: string): void {
    if (map.delete(id)) emit();
  }

  function list(): Command[] {
    return Array.from(map.values());
  }

  function bumpMru(id: string): void {
    mru = [id, ...mru.filter((x) => x !== id)].slice(0, MRU_CAP);
    persistMru(mru);
  }

  function execute(id: string): void {
    const cmd = map.get(id);
    if (!cmd) return;
    bumpMru(id);
    try {
      void cmd.callback();
    } catch {
      // Swallow — callers should not break the UI.
    }
  }

  function findByHotkey(event: KeyboardEvent): Command | null {
    const isMeta = event.metaKey || event.ctrlKey;
    if (!isMeta) return null;
    const keyLower = event.key.toLowerCase();
    for (const cmd of map.values()) {
      const h = cmd.hotkey;
      if (!h) continue;
      if (h.meta !== isMeta) continue;
      if (h.key.toLowerCase() !== keyLower) continue;
      // Tab bindings accept either direction — Shift picks prev vs next
      // at the handler level, so don't filter on shiftKey here.
      if (h.key.toLowerCase() !== "tab") {
        const shiftOk = h.shift === true ? event.shiftKey : !event.shiftKey;
        if (!shiftOk) continue;
      }
      return cmd;
    }
    return null;
  }

  return {
    subscribe: store.subscribe,
    register,
    unregister,
    execute,
    list,
    findByHotkey,
    getMru: () => [...mru],
    _reset: () => {
      map.clear();
      mru = [];
      persistMru(mru);
      emit();
    },
  };
}

export const commandRegistry = createRegistry();
