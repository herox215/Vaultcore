// Persistence + validation for user-configured hotkey overrides (#65).
// Overrides live in localStorage under a versioned envelope so we have room
// to migrate the schema later. The registry resolves them at lookup time —
// see registry.ts.

import { commandRegistry, type HotKey, type HotkeyOverrideMap } from "./registry";

export const HOTKEY_OVERRIDES_KEY = "vaultcore-command-hotkey-overrides";
const SCHEMA_VERSION = 1;

interface Envelope {
  version: number;
  overrides: HotkeyOverrideMap;
}

/** Keys that must never be bound on their own — they'd swallow common UX. */
const BLOCKED_BARE_KEYS = new Set(["escape", "enter", "tab", " ", "meta", "control", "shift", "alt"]);

function isHotKey(v: unknown): v is HotKey {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.meta !== "boolean") return false;
  if (o.shift !== undefined && typeof o.shift !== "boolean") return false;
  if (typeof o.key !== "string" || o.key.length === 0) return false;
  return true;
}

function isOverrideMap(v: unknown): v is HotkeyOverrideMap {
  if (typeof v !== "object" || v === null) return false;
  for (const [, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null) continue;
    if (!isHotKey(val)) return false;
  }
  return true;
}

/**
 * Load overrides from localStorage, validate, install into the registry.
 * Malformed data is dropped silently (after a single console.warn).
 */
export function loadHotkeyOverrides(): HotkeyOverrideMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(HOTKEY_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Envelope).version !== SCHEMA_VERSION ||
      !isOverrideMap((parsed as Envelope).overrides)
    ) {
      console.warn("[hotkey-overrides] dropping malformed localStorage entry");
      return {};
    }
    return (parsed as Envelope).overrides;
  } catch (err) {
    console.warn("[hotkey-overrides] parse failed, starting fresh", err);
    return {};
  }
}

function persist(overrides: HotkeyOverrideMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    const envelope: Envelope = { version: SCHEMA_VERSION, overrides };
    localStorage.setItem(HOTKEY_OVERRIDES_KEY, JSON.stringify(envelope));
  } catch {
    // Best-effort.
  }
}

/** Hydrate the registry from localStorage. Call once at app mount. */
export function initHotkeyOverrides(): void {
  const overrides = loadHotkeyOverrides();
  commandRegistry.setHotkeyOverrides(overrides);
}

/**
 * Validate a candidate binding recorded from a keydown event. Rejects bare
 * keys (no modifier), the modifier-only case, and blocked bare keys.
 */
export function validateHotKey(candidate: HotKey): { ok: true } | { ok: false; reason: string } {
  if (!candidate.meta) {
    return { ok: false, reason: "Tastenkürzel muss Cmd/Ctrl enthalten." };
  }
  const key = candidate.key.toLowerCase();
  if (key.length === 0) {
    return { ok: false, reason: "Taste fehlt." };
  }
  if (BLOCKED_BARE_KEYS.has(key)) {
    return { ok: false, reason: "Diese Taste kann nicht als Kürzel verwendet werden." };
  }
  return { ok: true };
}

/**
 * Extract a HotKey from a keydown event. Returns null if no non-modifier
 * key is pressed yet (i.e. user is still holding down modifiers).
 */
export function hotkeyFromEvent(e: KeyboardEvent): HotKey | null {
  const key = e.key;
  if (!key) return null;
  const keyLower = key.toLowerCase();
  // Ignore pure modifier presses — we only commit when a real key lands.
  if (keyLower === "meta" || keyLower === "control" || keyLower === "shift" || keyLower === "alt") {
    return null;
  }
  const meta = e.metaKey || e.ctrlKey;
  const hk: HotKey = {
    meta,
    key: key.length === 1 ? key.toLowerCase() : key,
  };
  if (e.shiftKey) hk.shift = true;
  return hk;
}

/** Set a user override and persist. Pass `null` to disable the spec default. */
export function setHotkeyOverride(id: string, override: HotKey | null): void {
  commandRegistry.setHotkeyOverride(id, override);
  persist(commandRegistry.getHotkeyOverrides());
}

/** Revert a command to its spec default (drops the override entry). */
export function resetHotkeyOverride(id: string): void {
  commandRegistry.clearHotkeyOverride(id);
  persist(commandRegistry.getHotkeyOverrides());
}
