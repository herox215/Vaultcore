/**
 * themeStore tests — whitelist guard, DOM mutation, localStorage persistence
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

/** Create a fresh in-memory localStorage mock and stub it globally. */
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

describe("themeStore", () => {
  beforeEach(() => {
    setupLocalStorage();
    document.documentElement.removeAttribute("data-theme");
    vi.resetModules();
  });

  it("Test 1: init reads stored 'dark' from localStorage and sets dataset.theme", async () => {
    localStorage.setItem("vaultcore-theme", "dark");
    const { themeStore } = await import("../../store/themeStore");
    themeStore.init();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("Test 2: set('dark') updates both localStorage and dataset.theme", async () => {
    const { themeStore } = await import("../../store/themeStore");
    themeStore.init();
    themeStore.set("dark");
    expect(localStorage.getItem("vaultcore-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("Test 3: set with invalid value is rejected — DOM and localStorage unchanged", async () => {
    const { themeStore } = await import("../../store/themeStore");
    themeStore.init();
    themeStore.set("light"); // valid first
    const domBefore = document.documentElement.dataset.theme;
    const lsBefore = localStorage.getItem("vaultcore-theme");
    const storeBefore = get(themeStore);
    // @ts-expect-error - testing invalid input
    themeStore.set('evil"<script>');
    expect(document.documentElement.dataset.theme).toBe(domBefore);
    expect(localStorage.getItem("vaultcore-theme")).toBe(lsBefore);
    expect(get(themeStore)).toBe(storeBefore);
  });

  it("Test 4: init with no stored value defaults to 'auto'", async () => {
    const { themeStore } = await import("../../store/themeStore");
    themeStore.init();
    expect(document.documentElement.dataset.theme).toBe("auto");
  });
});
