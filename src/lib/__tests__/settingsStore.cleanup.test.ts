/**
 * #353 — settingsStore.init() must purge the legacy semantic-search toggle
 * key from localStorage so no traces of the removed feature survive past
 * the upgrade.
 *
 * Mirrors the existing legacy-cleanup pattern for `vaultcore-attachment-folder`
 * (see `settingsStore.ts` init()).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

function setupLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  });
  return store;
}

describe("settingsStore legacy-semantic cleanup (#353)", () => {
  beforeEach(() => {
    setupLocalStorage();
    document.documentElement.style.removeProperty("--vc-font-size");
    vi.resetModules();
  });

  it("init() removes `vaultcore-semantic-search=true` from localStorage", async () => {
    localStorage.setItem("vaultcore-semantic-search", "true");
    const { settingsStore } = await import("../../store/settingsStore");
    settingsStore.init();
    expect(localStorage.getItem("vaultcore-semantic-search")).toBeNull();
  });

  it("init() removes `vaultcore-semantic-search=false` from localStorage", async () => {
    localStorage.setItem("vaultcore-semantic-search", "false");
    const { settingsStore } = await import("../../store/settingsStore");
    settingsStore.init();
    expect(localStorage.getItem("vaultcore-semantic-search")).toBeNull();
  });

  it("init() is a no-op when the key is already absent", async () => {
    const { settingsStore } = await import("../../store/settingsStore");
    settingsStore.init();
    expect(localStorage.getItem("vaultcore-semantic-search")).toBeNull();
  });
});
