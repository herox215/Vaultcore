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
});
