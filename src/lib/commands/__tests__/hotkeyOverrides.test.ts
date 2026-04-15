import { describe, it, expect, beforeEach, vi } from "vitest";
import { commandRegistry } from "../registry";
import {
  HOTKEY_OVERRIDES_KEY,
  hotkeyFromEvent,
  initHotkeyOverrides,
  loadHotkeyOverrides,
  resetHotkeyOverride,
  setHotkeyOverride,
  validateHotKey,
} from "../hotkeyOverrides";

function setupLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  });
  return store;
}

describe("hotkeyOverrides — validation", () => {
  it("rejects bindings without Meta/Ctrl", () => {
    expect(validateHotKey({ meta: false, key: "a" }).ok).toBe(false);
  });

  it("rejects bare Escape / Enter / Tab / modifiers", () => {
    expect(validateHotKey({ meta: true, key: "Escape" }).ok).toBe(false);
    expect(validateHotKey({ meta: true, key: "Enter" }).ok).toBe(false);
    expect(validateHotKey({ meta: true, key: "Tab" }).ok).toBe(false);
    expect(validateHotKey({ meta: true, key: "Meta" }).ok).toBe(false);
    expect(validateHotKey({ meta: true, key: "Shift" }).ok).toBe(false);
  });

  it("accepts Meta+letter and Meta+Shift+letter", () => {
    expect(validateHotKey({ meta: true, key: "k" }).ok).toBe(true);
    expect(validateHotKey({ meta: true, shift: true, key: "f" }).ok).toBe(true);
  });
});

describe("hotkeyFromEvent", () => {
  it("returns null for pure modifier presses", () => {
    const ev = new KeyboardEvent("keydown", { key: "Meta", metaKey: true });
    expect(hotkeyFromEvent(ev)).toBeNull();
  });

  it("lowercases single-character keys and preserves named keys", () => {
    const a = new KeyboardEvent("keydown", { key: "K", metaKey: true, shiftKey: true });
    expect(hotkeyFromEvent(a)).toEqual({ meta: true, shift: true, key: "k" });
    const b = new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true });
    expect(hotkeyFromEvent(b)).toEqual({ meta: true, key: "ArrowLeft" });
  });
});

describe("hotkeyOverrides — persistence", () => {
  beforeEach(() => {
    setupLocalStorage();
    commandRegistry._reset();
  });

  it("loadHotkeyOverrides returns {} for missing / malformed entries", () => {
    expect(loadHotkeyOverrides()).toEqual({});
    localStorage.setItem(HOTKEY_OVERRIDES_KEY, "not json");
    expect(loadHotkeyOverrides()).toEqual({});
    localStorage.setItem(HOTKEY_OVERRIDES_KEY, JSON.stringify({ version: 99, overrides: {} }));
    expect(loadHotkeyOverrides()).toEqual({});
    localStorage.setItem(
      HOTKEY_OVERRIDES_KEY,
      JSON.stringify({ version: 1, overrides: { foo: "bad" } })
    );
    expect(loadHotkeyOverrides()).toEqual({});
  });

  it("setHotkeyOverride persists a versioned envelope and updates the registry", () => {
    commandRegistry.register({
      id: "n",
      name: "N",
      callback: () => {},
      hotkey: { meta: true, key: "n" },
    });
    setHotkeyOverride("n", { meta: true, key: "j" });
    const raw = localStorage.getItem(HOTKEY_OVERRIDES_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(1);
    expect(parsed.overrides.n).toEqual({ meta: true, key: "j" });
    expect(commandRegistry.getEffectiveHotkey("n")).toEqual({ meta: true, key: "j" });
  });

  it("setHotkeyOverride with null persists a disabled state", () => {
    commandRegistry.register({
      id: "n",
      name: "N",
      callback: () => {},
      hotkey: { meta: true, key: "n" },
    });
    setHotkeyOverride("n", null);
    const parsed = JSON.parse(localStorage.getItem(HOTKEY_OVERRIDES_KEY)!);
    expect(parsed.overrides.n).toBeNull();
    expect(commandRegistry.getEffectiveHotkey("n")).toBeUndefined();
  });

  it("resetHotkeyOverride removes the entry from the persisted map", () => {
    commandRegistry.register({
      id: "n",
      name: "N",
      callback: () => {},
      hotkey: { meta: true, key: "n" },
    });
    setHotkeyOverride("n", { meta: true, key: "j" });
    resetHotkeyOverride("n");
    const parsed = JSON.parse(localStorage.getItem(HOTKEY_OVERRIDES_KEY)!);
    expect(parsed.overrides.n).toBeUndefined();
    expect(commandRegistry.getEffectiveHotkey("n")).toEqual({ meta: true, key: "n" });
  });

  it("initHotkeyOverrides hydrates the registry from localStorage", () => {
    localStorage.setItem(
      HOTKEY_OVERRIDES_KEY,
      JSON.stringify({
        version: 1,
        overrides: {
          n: { meta: true, shift: true, key: "x" },
          p: null,
        },
      })
    );
    commandRegistry.register({
      id: "n",
      name: "N",
      callback: () => {},
      hotkey: { meta: true, key: "n" },
    });
    commandRegistry.register({
      id: "p",
      name: "P",
      callback: () => {},
      hotkey: { meta: true, key: "p" },
    });
    initHotkeyOverrides();
    expect(commandRegistry.getEffectiveHotkey("n")).toEqual({ meta: true, shift: true, key: "x" });
    expect(commandRegistry.getEffectiveHotkey("p")).toBeUndefined();
  });
});
