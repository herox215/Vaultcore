// tabReloadStore tests — covers the reload signal (request/token) and
// per-tab save-snapshot mutations (setLastSavedContent/setLastSavedHash).

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { tabLifecycleStore } from "./tabLifecycleStore";
import { tabReloadStore } from "./tabReloadStore";
import { _core, _reset } from "./tabStoreCore";

beforeEach(() => {
  _reset();
  tabReloadStore._reset();
});

describe("tabReloadStore — reload signal", () => {
  it("request() emits a new token with the given paths", () => {
    let observed: { token: string; paths: string[] } | null = null;
    const unsub = tabReloadStore.subscribe((s) => {
      if (s.pending) observed = s.pending;
    });
    tabReloadStore.request(["notes/a.md", "notes/b.md"]);
    unsub();
    expect(observed).not.toBeNull();
    expect(observed!.paths).toEqual(["notes/a.md", "notes/b.md"]);
    expect(observed!.token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("request() with an empty array is a no-op", () => {
    let emissions = 0;
    const unsub = tabReloadStore.subscribe(() => {
      emissions += 1;
    });
    const initial = emissions; // subscribe-time replay already counted
    tabReloadStore.request([]);
    unsub();
    expect(emissions).toBe(initial);
  });

  it("two consecutive request() calls produce different tokens", () => {
    const tokens: string[] = [];
    const unsub = tabReloadStore.subscribe((s) => {
      if (s.pending) tokens.push(s.pending.token);
    });
    tabReloadStore.request(["a.md"]);
    tabReloadStore.request(["a.md"]); // same paths, must still re-trigger
    unsub();
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});

describe("tabReloadStore — per-tab save snapshot", () => {
  it("setLastSavedContent persists the base snapshot for three-way merge", () => {
    const id = tabLifecycleStore.openTab("/vault/a.md");
    tabReloadStore.setLastSavedContent(id, "snapshot body");
    const tab = get(_core).tabs.find((t) => t.id === id);
    expect(tab?.lastSavedContent).toBe("snapshot body");
  });

  it("setLastSavedHash records the disk hash on the tab", () => {
    const id = tabLifecycleStore.openTab("/vault/a.md");
    tabReloadStore.setLastSavedHash(id, "abc123");
    const tab = get(_core).tabs.find((t) => t.id === id);
    expect(tab?.lastSavedHash).toBe("abc123");
  });

  it("setLastSavedHash(id, null) is distinguishable from never-set (#80)", () => {
    const id = tabLifecycleStore.openTab("/vault/a.md");
    const before = get(_core).tabs.find((t) => t.id === id);
    expect(before?.lastSavedHash).toBeUndefined();
    tabReloadStore.setLastSavedHash(id, null);
    const after = get(_core).tabs.find((t) => t.id === id);
    expect(after?.lastSavedHash).toBeNull();
    expect(after?.lastSavedHash === undefined).toBe(false);
  });

  it("save-snapshot mutations are scoped to the given tab", () => {
    const a = tabLifecycleStore.openTab("/vault/a.md");
    const b = tabLifecycleStore.openTab("/vault/b.md");
    tabReloadStore.setLastSavedContent(a, "A body");
    tabReloadStore.setLastSavedHash(a, "hash-a");
    const tabA = get(_core).tabs.find((t) => t.id === a);
    const tabB = get(_core).tabs.find((t) => t.id === b);
    expect(tabA?.lastSavedContent).toBe("A body");
    expect(tabA?.lastSavedHash).toBe("hash-a");
    expect(tabB?.lastSavedContent).toBe("");
    expect(tabB?.lastSavedHash).toBeUndefined();
  });
});
