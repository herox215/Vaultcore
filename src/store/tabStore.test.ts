// tabStore (shim + cross-concern) tests — #341.
//
// Facade-specific tests live in tabLifecycleStore.test.ts / tabLayoutStore
// .test.ts / tabReloadStore.test.ts. This file covers:
//   1. Cross-concern operations that span multiple facades (closeTab with
//      split-collapse is the canonical example).
//   2. Atomicity — subscribers must never observe torn state across a
//      cross-concern op. Exactly one emission per op on the shared core.
//   3. Shim surface — tabStore re-exports every method from the three
//      facades and stays usable by legacy consumers.

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { tabStore } from "./tabStore";

beforeEach(() => {
  tabStore._reset();
});

describe("tabStore shim — cross-concern behavior", () => {
  describe("closeTab merges split pane when pane becomes empty", () => {
    it("closing the only tab in the right pane collapses split to left-only", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      tabStore.activateTab(id2);
      tabStore.moveToPane("right");
      tabStore.activateTab(id2);
      tabStore.closeTab(id2);
      const state = get(tabStore);
      expect(state.splitState.right).toEqual([]);
      expect(state.splitState.activePane).toBe("left");
      expect(state.tabs.find((t) => t.id === id2)).toBeUndefined();
      expect(state.splitState.left).toEqual([id1]);
    });

    it("closing active tab in right pane with sibling leaves right pane intact", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      const id3 = tabStore.openTab("/vault/c.md");
      tabStore.activateTab(id2);
      tabStore.moveToPane("right");
      tabStore.activateTab(id3);
      tabStore.moveToPane("right"); // right pane: [id2, id3]
      tabStore.closeTab(id2);
      const state = get(tabStore);
      expect(state.splitState.right).toEqual([id3]);
      expect(state.splitState.left).toEqual([id1]);
    });

    it("closing only tab in left pane collapses split; right contents move into left", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      tabStore.activateTab(id2);
      tabStore.moveToPane("right");
      tabStore.activateTab(id1);
      tabStore.closeTab(id1);
      const state = get(tabStore);
      expect(state.splitState.right).toEqual([]);
      expect(state.splitState.left).toEqual([id2]);
      expect(state.splitState.activePane).toBe("left");
      expect(state.activeTabId).toBe(id2);
    });
  });
});

describe("tabStore shim — atomicity (exactly one emission per op)", () => {
  // Every cross-concern method must perform a single `_core.update(...)`.
  // Multiple updates produce torn intermediate states — subscribers could
  // observe `tabs` updated before `splitState.left`, or the new `activeTabId`
  // pointing at a tab that isn't yet in any pane. Asserting emission count
  // is the tight regression net.

  function countEmissionsDuring(fn: () => void): number {
    let count = -1; // discount the subscribe-time replay
    const unsub = tabStore.subscribe(() => {
      count += 1;
    });
    fn();
    unsub();
    return count;
  }

  it("openTab emits exactly once", () => {
    const emissions = countEmissionsDuring(() => {
      tabStore.openTab("/vault/a.md");
    });
    expect(emissions).toBe(1);
  });

  it("closeTab with merge-collapse emits exactly once", () => {
    tabStore.openTab("/vault/a.md");
    const id2 = tabStore.openTab("/vault/b.md");
    tabStore.activateTab(id2);
    tabStore.moveToPane("right");
    tabStore.activateTab(id2);
    const emissions = countEmissionsDuring(() => {
      tabStore.closeTab(id2);
    });
    expect(emissions).toBe(1);
  });

  it("moveToPane emits exactly once", () => {
    tabStore.openTab("/vault/a.md");
    const id2 = tabStore.openTab("/vault/b.md");
    tabStore.activateTab(id2);
    const emissions = countEmissionsDuring(() => {
      tabStore.moveToPane("right");
    });
    expect(emissions).toBe(1);
  });

  it("activateTab emits exactly once", () => {
    const id1 = tabStore.openTab("/vault/a.md");
    tabStore.openTab("/vault/b.md");
    const emissions = countEmissionsDuring(() => {
      tabStore.activateTab(id1);
    });
    expect(emissions).toBe(1);
  });

  it("closeByPath emits exactly once when a matching tab exists", () => {
    tabStore.openTab("/vault/a.md");
    tabStore.openTab("/vault/b.md");
    const emissions = countEmissionsDuring(() => {
      tabStore.closeByPath("/vault/a.md");
    });
    expect(emissions).toBe(1);
  });

  it("closeByPath is silent when no tab matches the path", () => {
    tabStore.openTab("/vault/a.md");
    const emissions = countEmissionsDuring(() => {
      tabStore.closeByPath("/vault/missing.md");
    });
    expect(emissions).toBe(0);
  });
});

describe("tabStore shim — surface preservation", () => {
  it("exposes every legacy method via the shim", () => {
    const methods = [
      "openTab",
      "openFileTab",
      "openGraphTab",
      "closeTab",
      "closeAll",
      "closeByPath",
      "activateTab",
      "cycleTab",
      "getActiveTab",
      "setDirty",
      "setViewMode",
      "toggleViewMode",
      "updateScrollPos",
      "updateReadingScrollPos",
      "updateFilePath",
      "moveToPane",
      "_reorderPane",
      "setLastSavedContent",
      "setLastSavedHash",
      "_reset",
    ] as const;
    for (const name of methods) {
      expect(typeof (tabStore as Record<string, unknown>)[name]).toBe("function");
    }
    expect(typeof tabStore.subscribe).toBe("function");
  });
});
