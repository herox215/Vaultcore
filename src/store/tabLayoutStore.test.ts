// tabLayoutStore tests — covers moveToPane (split creation + collapse)
// and reorderPane. Cross-concern behavior (e.g. closeTab spanning lifecycle
// and layout) lives in tabStore.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { tabLifecycleStore } from "./tabLifecycleStore";
import { tabLayoutStore } from "./tabLayoutStore";
import { _reset } from "./tabStoreCore";

beforeEach(() => {
  _reset();
});

describe("tabLayoutStore", () => {
  describe("moveToPane", () => {
    it("moves active tab to right pane, creating split if empty", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/b.md");
      tabLifecycleStore.activateTab(id2);
      tabLayoutStore.moveToPane("right");
      const state = get(tabLayoutStore);
      expect(state.splitState.left).toContain(id1);
      expect(state.splitState.left).not.toContain(id2);
      expect(state.splitState.right).toContain(id2);
    });

    it("moving to current pane does nothing", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      tabLayoutStore.moveToPane("left");
      const state = get(tabLayoutStore);
      expect(state.splitState.left).toContain(id1);
      expect(state.splitState.right).toEqual([]);
    });

    it("moving from source pane that becomes empty closes the split", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      tabLayoutStore.moveToPane("right");
      tabLayoutStore.moveToPane("left");
      const state = get(tabLayoutStore);
      expect(state.splitState.right).toEqual([]);
      expect(state.splitState.left).toContain(id1);
    });
  });

  describe("reorderPane", () => {
    it("replaces pane tab-id order without touching tabs list or active", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/b.md");
      const id3 = tabLifecycleStore.openTab("/vault/c.md");
      const before = get(tabLayoutStore);
      expect(before.splitState.left).toEqual([id1, id2, id3]);

      tabLayoutStore.reorderPane("left", [id3, id1, id2]);

      const after = get(tabLayoutStore);
      expect(after.splitState.left).toEqual([id3, id1, id2]);
      expect(after.tabs).toHaveLength(3);
      expect(after.activeTabId).toBe(id3);
      expect(after.splitState.right).toEqual([]);
    });

    it("reorders right pane independently", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/b.md");
      tabLifecycleStore.activateTab(id2);
      tabLayoutStore.moveToPane("right");
      const id3 = tabLifecycleStore.openTab("/vault/c.md");
      tabLayoutStore.moveToPane("right");
      const before = get(tabLayoutStore);
      expect(before.splitState.right).toEqual([id2, id3]);

      tabLayoutStore.reorderPane("right", [id3, id2]);

      expect(get(tabLayoutStore).splitState.right).toEqual([id3, id2]);
      expect(get(tabLayoutStore).splitState.left).toEqual([id1]);
    });
  });
});
