// Extensible command registry (#13) with user-configurable hotkey overrides (#65).
// Wraps a Map<id, Command> in a classic writable store so the palette and
// settings table stay reactive. Overrides are resolved at lookup time — the
// registered Command.hotkey stays as the spec default; findByHotkey and
// getEffective consult the override map first.

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

/** `null` means "user disabled this default binding". Missing key means
 *  "use the spec default". */
export type HotkeyOverrideMap = Record<string, HotKey | null>;

export interface CommandRegistry {
  subscribe: ReturnType<typeof writable<Command[]>>["subscribe"];
  register(cmd: Command): void;
  unregister(id: string): void;
  execute(id: string): void;
  list(): Command[];
  findByHotkey(event: KeyboardEvent): Command | null;
  /** Ids ordered most-recently-executed first (capped at MRU_CAP). */
  getMru(): string[];
  /** Resolve a command's currently-active hotkey (override || default || undefined). */
  getEffectiveHotkey(id: string): HotKey | undefined;
  /** Commands with their effective (override-applied) hotkey baked in. */
  getEffective(): Command[];
  /** Install a new override entry and re-emit. `null` disables the default. */
  setHotkeyOverride(id: string, override: HotKey | null): void;
  /** Remove a user override so the spec default takes over again. */
  clearHotkeyOverride(id: string): void;
  /** Bulk replace the override map (used on initial load). */
  setHotkeyOverrides(map: HotkeyOverrideMap): void;
  getHotkeyOverrides(): HotkeyOverrideMap;
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

function hotkeysEqual(a: HotKey, b: HotKey): boolean {
  return (
    a.meta === b.meta &&
    (a.shift === true) === (b.shift === true) &&
    a.key.toLowerCase() === b.key.toLowerCase()
  );
}

function createRegistry(): CommandRegistry {
  const map = new Map<string, Command>();
  const store = writable<Command[]>([]);
  let mru: string[] = loadMru();
  let overrides: HotkeyOverrideMap = {};

  function resolveHotkey(id: string, specHotkey: HotKey | undefined): HotKey | undefined {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) {
      const o = overrides[id];
      // null => disabled; any hotkey => use override.
      return o === null ? undefined : o;
    }
    return specHotkey;
  }

  function effective(cmd: Command): Command {
    const h = resolveHotkey(cmd.id, cmd.hotkey);
    if (h) return { ...cmd, hotkey: h };
    // Strip hotkey when it's disabled or absent.
    const { hotkey: _unused, ...rest } = cmd;
    void _unused;
    return rest;
  }

  function emit(): void {
    store.set(Array.from(map.values()).map(effective));
  }

  function register(cmd: Command): void {
    map.set(cmd.id, cmd);
    emit();
  }

  function unregister(id: string): void {
    if (map.delete(id)) emit();
  }

  function list(): Command[] {
    return Array.from(map.values()).map(effective);
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
      const h = resolveHotkey(cmd.id, cmd.hotkey);
      if (!h) continue;
      if (h.meta !== isMeta) continue;
      if (h.key.toLowerCase() !== keyLower) continue;
      // Tab bindings accept either direction — Shift picks prev vs next
      // at the handler level, so don't filter on shiftKey here.
      if (h.key.toLowerCase() !== "tab") {
        const shiftOk = h.shift === true ? event.shiftKey : !event.shiftKey;
        if (!shiftOk) continue;
      }
      return effective(cmd);
    }
    return null;
  }

  function getEffectiveHotkey(id: string): HotKey | undefined {
    const cmd = map.get(id);
    if (!cmd) return undefined;
    return resolveHotkey(id, cmd.hotkey);
  }

  function getEffective(): Command[] {
    return list();
  }

  function setHotkeyOverride(id: string, override: HotKey | null): void {
    overrides = { ...overrides, [id]: override };
    emit();
  }

  function clearHotkeyOverride(id: string): void {
    if (!(id in overrides)) return;
    const next = { ...overrides };
    delete next[id];
    overrides = next;
    emit();
  }

  function setHotkeyOverrides(next: HotkeyOverrideMap): void {
    overrides = { ...next };
    emit();
  }

  function getHotkeyOverrides(): HotkeyOverrideMap {
    return { ...overrides };
  }

  return {
    subscribe: store.subscribe,
    register,
    unregister,
    execute,
    list,
    findByHotkey,
    getMru: () => [...mru],
    getEffectiveHotkey,
    getEffective,
    setHotkeyOverride,
    clearHotkeyOverride,
    setHotkeyOverrides,
    getHotkeyOverrides,
    _reset: () => {
      map.clear();
      mru = [];
      overrides = {};
      persistMru(mru);
      emit();
    },
  };
}

export const commandRegistry = createRegistry();

/** Exported for override-equality checks in the Settings UI. */
export { hotkeysEqual };
