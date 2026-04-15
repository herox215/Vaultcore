import { describe, it, expect, beforeEach, vi } from "vitest";
import { commandRegistry } from "../registry";
import { get } from "svelte/store";

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

describe("commandRegistry", () => {
  beforeEach(() => {
    setupLocalStorage();
    commandRegistry._reset();
  });

  it("register + list exposes registered commands", () => {
    const cb = vi.fn();
    commandRegistry.register({ id: "a", name: "Alpha", callback: cb });
    commandRegistry.register({
      id: "b",
      name: "Beta",
      callback: () => {},
      hotkey: { meta: true, key: "b" },
    });
    const list = commandRegistry.list();
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("execute invokes the matching callback", () => {
    const cb = vi.fn();
    commandRegistry.register({ id: "run", name: "Run", callback: cb });
    commandRegistry.execute("run");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("execute is a no-op for unknown ids", () => {
    expect(() => commandRegistry.execute("missing")).not.toThrow();
  });

  it("unregister removes the command", () => {
    commandRegistry.register({ id: "a", name: "A", callback: () => {} });
    commandRegistry.unregister("a");
    expect(commandRegistry.list()).toHaveLength(0);
  });

  it("executing a command pushes it to the front of the MRU list", () => {
    commandRegistry.register({ id: "a", name: "A", callback: () => {} });
    commandRegistry.register({ id: "b", name: "B", callback: () => {} });
    commandRegistry.register({ id: "c", name: "C", callback: () => {} });

    commandRegistry.execute("a");
    commandRegistry.execute("b");
    commandRegistry.execute("c");
    expect(commandRegistry.getMru().slice(0, 3)).toEqual(["c", "b", "a"]);

    // Re-execute a moves it to front, no duplicates.
    commandRegistry.execute("a");
    expect(commandRegistry.getMru().slice(0, 3)).toEqual(["a", "c", "b"]);
  });

  it("persists MRU list to localStorage", () => {
    commandRegistry.register({ id: "a", name: "A", callback: () => {} });
    commandRegistry.execute("a");
    const raw = localStorage.getItem("vaultcore-command-palette-mru");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual(["a"]);
  });

  it("subscribe fires when commands change", () => {
    const snapshot = get(commandRegistry);
    expect(snapshot).toEqual([]);
    commandRegistry.register({ id: "x", name: "X", callback: () => {} });
    expect(get(commandRegistry).map((c) => c.id)).toEqual(["x"]);
  });

  it("findByHotkey matches meta+key", () => {
    const cb = vi.fn();
    commandRegistry.register({
      id: "n",
      name: "New",
      callback: cb,
      hotkey: { meta: true, key: "n" },
    });
    const ev = new KeyboardEvent("keydown", { key: "n", metaKey: true });
    const match = commandRegistry.findByHotkey(ev);
    expect(match?.id).toBe("n");
  });

  it("findByHotkey respects shift modifier", () => {
    commandRegistry.register({
      id: "plain",
      name: "Plain",
      callback: () => {},
      hotkey: { meta: true, key: "f" },
    });
    commandRegistry.register({
      id: "shifted",
      name: "Shifted",
      callback: () => {},
      hotkey: { meta: true, shift: true, key: "f" },
    });
    const plainEv = new KeyboardEvent("keydown", { key: "f", metaKey: true });
    const shiftEv = new KeyboardEvent("keydown", { key: "f", metaKey: true, shiftKey: true });
    expect(commandRegistry.findByHotkey(plainEv)?.id).toBe("plain");
    expect(commandRegistry.findByHotkey(shiftEv)?.id).toBe("shifted");
  });

  it("findByHotkey returns null without meta/ctrl", () => {
    commandRegistry.register({
      id: "n",
      name: "New",
      callback: () => {},
      hotkey: { meta: true, key: "n" },
    });
    const ev = new KeyboardEvent("keydown", { key: "n" });
    expect(commandRegistry.findByHotkey(ev)).toBeNull();
  });

  describe("hotkey overrides (#65)", () => {
    it("setHotkeyOverride replaces the effective binding in findByHotkey", () => {
      const cb = vi.fn();
      commandRegistry.register({
        id: "n",
        name: "New",
        callback: cb,
        hotkey: { meta: true, key: "n" },
      });
      commandRegistry.setHotkeyOverride("n", { meta: true, key: "j" });
      // Old binding no longer matches.
      const oldEv = new KeyboardEvent("keydown", { key: "n", metaKey: true });
      expect(commandRegistry.findByHotkey(oldEv)).toBeNull();
      // New binding matches.
      const newEv = new KeyboardEvent("keydown", { key: "j", metaKey: true });
      expect(commandRegistry.findByHotkey(newEv)?.id).toBe("n");
    });

    it("override=null disables the default but keeps the command runnable", () => {
      const cb = vi.fn();
      commandRegistry.register({
        id: "n",
        name: "New",
        callback: cb,
        hotkey: { meta: true, key: "n" },
      });
      commandRegistry.setHotkeyOverride("n", null);
      const ev = new KeyboardEvent("keydown", { key: "n", metaKey: true });
      expect(commandRegistry.findByHotkey(ev)).toBeNull();
      // execute still works.
      commandRegistry.execute("n");
      expect(cb).toHaveBeenCalledOnce();
    });

    it("clearHotkeyOverride restores the spec default", () => {
      commandRegistry.register({
        id: "n",
        name: "New",
        callback: () => {},
        hotkey: { meta: true, key: "n" },
      });
      commandRegistry.setHotkeyOverride("n", { meta: true, key: "j" });
      commandRegistry.clearHotkeyOverride("n");
      const ev = new KeyboardEvent("keydown", { key: "n", metaKey: true });
      expect(commandRegistry.findByHotkey(ev)?.id).toBe("n");
    });

    it("getEffective reflects overrides (replaces and strips disabled)", () => {
      commandRegistry.register({
        id: "a",
        name: "A",
        callback: () => {},
        hotkey: { meta: true, key: "a" },
      });
      commandRegistry.register({
        id: "b",
        name: "B",
        callback: () => {},
        hotkey: { meta: true, key: "b" },
      });
      commandRegistry.setHotkeyOverride("a", { meta: true, shift: true, key: "x" });
      commandRegistry.setHotkeyOverride("b", null);
      const eff = commandRegistry.getEffective();
      const a = eff.find((c) => c.id === "a");
      const b = eff.find((c) => c.id === "b");
      expect(a?.hotkey).toEqual({ meta: true, shift: true, key: "x" });
      expect(b?.hotkey).toBeUndefined();
    });

    it("subscribe re-emits after override changes", () => {
      commandRegistry.register({
        id: "n",
        name: "N",
        callback: () => {},
        hotkey: { meta: true, key: "n" },
      });
      const snapshots: Array<string | undefined> = [];
      const unsub = commandRegistry.subscribe((list) => {
        const c = list.find((x) => x.id === "n");
        snapshots.push(c?.hotkey?.key);
      });
      commandRegistry.setHotkeyOverride("n", { meta: true, key: "j" });
      commandRegistry.setHotkeyOverride("n", null);
      commandRegistry.clearHotkeyOverride("n");
      unsub();
      // Initial emit, plus one per override change.
      expect(snapshots).toEqual(["n", "j", undefined, "n"]);
    });
  });
});
