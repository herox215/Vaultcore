/**
 * settingsStore tests — font-size clamp, font whitelist, localStorage persistence, init
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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

describe("settingsStore", () => {
  beforeEach(() => {
    setupLocalStorage();
    document.documentElement.style.removeProperty("--vc-font-size");
    document.documentElement.style.removeProperty("--vc-font-body");
    document.documentElement.style.removeProperty("--vc-font-mono");
    vi.resetModules();
  });

  it("Test 5: setFontSize(18) sets CSS var to '18px' and localStorage to '18'", async () => {
    const { settingsStore } = await import("../../store/settingsStore");
    settingsStore.init();
    settingsStore.setFontSize(18);
    expect(
      document.documentElement.style.getPropertyValue("--vc-font-size")
    ).toBe("18px");
    expect(localStorage.getItem("vaultcore-font-size")).toBe("18");
  });

  it("Test 6: setFontSize clamps — 99 → 20, 5 → 12", async () => {
    const { settingsStore } = await import("../../store/settingsStore");
    settingsStore.init();
    settingsStore.setFontSize(99);
    expect(
      document.documentElement.style.getPropertyValue("--vc-font-size")
    ).toBe("20px");
    settingsStore.setFontSize(5);
    expect(
      document.documentElement.style.getPropertyValue("--vc-font-size")
    ).toBe("12px");
  });

  it("Test 7: setFontBody('inter') sets --vc-font-body; invalid key is rejected", async () => {
    const { settingsStore } = await import("../../store/settingsStore");
    settingsStore.init();
    settingsStore.setFontBody("inter");
    const interStack = document.documentElement.style.getPropertyValue("--vc-font-body");
    expect(interStack).toContain("Inter");
    // Save current state
    const prevBody = document.documentElement.style.getPropertyValue("--vc-font-body");
    const prevKey = localStorage.getItem("vaultcore-font-body");
    // @ts-expect-error - testing invalid input
    settingsStore.setFontBody("javascript:alert(1)");
    expect(document.documentElement.style.getPropertyValue("--vc-font-body")).toBe(prevBody);
    expect(localStorage.getItem("vaultcore-font-body")).toBe(prevKey);
  });

  it("Test 8: init reads stored font-size=17 and applies it; 'NaN' falls back to 14", async () => {
    // Part A: valid stored value
    localStorage.setItem("vaultcore-font-size", "17");
    const { settingsStore } = await import("../../store/settingsStore");
    settingsStore.init();
    expect(
      document.documentElement.style.getPropertyValue("--vc-font-size")
    ).toBe("17px");

    // Part B: reset and test invalid stored value
    vi.resetModules();
    setupLocalStorage();
    localStorage.setItem("vaultcore-font-size", "NaN");
    document.documentElement.style.removeProperty("--vc-font-size");
    const { settingsStore: s2 } = await import("../../store/settingsStore");
    s2.init();
    expect(
      document.documentElement.style.getPropertyValue("--vc-font-size")
    ).toBe("14px");
  });
});
