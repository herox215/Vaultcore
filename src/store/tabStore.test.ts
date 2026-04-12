// tabStore tests — covers all behaviors from 02-03-PLAN.md
// Test 1: openTab adds a tab and sets it as activeTabId
// Test 2: openTab with an already-open file path activates the existing tab (no duplicate)
// Test 3: closeTab removes the tab; if it was active, activates the nearest sibling (left preferred)
// Test 4: closeTab on the last tab in a split pane closes the pane and merges remaining tabs into one pane
// Test 5: cycleTab moves activeTabId to the next tab in the same pane (wraps around)
// Test 6: moveToPane("right") moves the active tab from left to right pane, creating split if right was empty
// Test 7: setDirty(tabId, true) sets isDirty on the tab; setDirty(tabId, false) clears it
// Test 8: updateScrollPos(tabId, pos) persists scroll position for tab restore
// Test 9: initial state has empty tabs array, null activeTabId, splitState with empty right pane

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { tabStore } from "./tabStore";

beforeEach(() => {
  tabStore._reset();
});

describe("tabStore", () => {
  describe("Test 9: initial state", () => {
    it("has empty tabs array, null activeTabId, splitState with empty right pane", () => {
      const state = get(tabStore);
      expect(state.tabs).toEqual([]);
      expect(state.activeTabId).toBeNull();
      expect(state.splitState.left).toEqual([]);
      expect(state.splitState.right).toEqual([]);
      expect(state.splitState.activePane).toBe("left");
    });
  });

  describe("Test 1: openTab", () => {
    it("adds a tab and sets it as activeTabId", () => {
      const id = tabStore.openTab("/vault/note-a.md");
      const state = get(tabStore);

      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].filePath).toBe("/vault/note-a.md");
      expect(state.tabs[0].id).toBe(id);
      expect(state.activeTabId).toBe(id);
      // Tab goes in left pane by default
      expect(state.splitState.left).toContain(id);
    });

    it("opening a second file adds another tab", () => {
      const id1 = tabStore.openTab("/vault/note-a.md");
      const id2 = tabStore.openTab("/vault/note-b.md");
      const state = get(tabStore);

      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe(id2);
      expect(state.splitState.left).toEqual([id1, id2]);
    });
  });

  describe("Test 2: openTab with duplicate path", () => {
    it("activates existing tab and returns its id (no duplicate)", () => {
      const id1 = tabStore.openTab("/vault/note-a.md");
      tabStore.openTab("/vault/note-b.md");
      const id1Again = tabStore.openTab("/vault/note-a.md");
      const state = get(tabStore);

      expect(state.tabs).toHaveLength(2); // no new tab created
      expect(id1Again).toBe(id1);
      expect(state.activeTabId).toBe(id1);
    });
  });

  describe("Test 3: closeTab", () => {
    it("removes the tab from the store", () => {
      const id = tabStore.openTab("/vault/note-a.md");
      tabStore.closeTab(id);
      const state = get(tabStore);

      expect(state.tabs).toHaveLength(0);
      expect(state.splitState.left).not.toContain(id);
    });

    it("if active, activates the left sibling (preferred)", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      const id3 = tabStore.openTab("/vault/c.md");
      // id3 is currently active; close it => should activate id2
      tabStore.closeTab(id3);

      expect(get(tabStore).activeTabId).toBe(id2);
    });

    it("falls back to right sibling when closing leftmost active tab", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      tabStore.activateTab(id1);
      tabStore.closeTab(id1);

      expect(get(tabStore).activeTabId).toBe(id2);
    });

    it("sets activeTabId to null when last tab is closed", () => {
      const id = tabStore.openTab("/vault/a.md");
      tabStore.closeTab(id);

      expect(get(tabStore).activeTabId).toBeNull();
    });
  });

  describe("Test 4: closeTab merges split pane when last tab in pane is closed", () => {
    it("closing last tab in right pane collapses split to left pane only", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      // Move id2 to right pane to create split
      tabStore.activateTab(id2);
      tabStore.moveToPane("right");

      // Now close the only tab in the right pane (id2)
      tabStore.activateTab(id2);
      tabStore.closeTab(id2);
      const state = get(tabStore);

      expect(state.splitState.right).toEqual([]);
      expect(state.splitState.activePane).toBe("left");
      expect(state.tabs.find((t) => t.id === id2)).toBeUndefined();
    });
  });

  describe("Test 5: cycleTab", () => {
    it("cycles forward through tabs in same pane (wraps around)", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      const id3 = tabStore.openTab("/vault/c.md");
      tabStore.activateTab(id1);

      tabStore.cycleTab(1);
      expect(get(tabStore).activeTabId).toBe(id2);

      tabStore.cycleTab(1);
      expect(get(tabStore).activeTabId).toBe(id3);

      // Wrap around
      tabStore.cycleTab(1);
      expect(get(tabStore).activeTabId).toBe(id1);
    });

    it("cycles backward through tabs (wraps around)", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      const id3 = tabStore.openTab("/vault/c.md");
      tabStore.activateTab(id3);

      tabStore.cycleTab(-1);
      expect(get(tabStore).activeTabId).toBe(id2);

      // Wrap backward
      tabStore.activateTab(id1);
      tabStore.cycleTab(-1);
      expect(get(tabStore).activeTabId).toBe(id3);
    });
  });

  describe("Test 6: moveToPane", () => {
    it("moves active tab to right pane, creating split if empty", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      tabStore.activateTab(id2);
      tabStore.moveToPane("right");
      const state = get(tabStore);

      expect(state.splitState.left).toContain(id1);
      expect(state.splitState.left).not.toContain(id2);
      expect(state.splitState.right).toContain(id2);
    });

    it("moving to current pane does nothing", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      tabStore.moveToPane("left"); // already in left pane
      const state = get(tabStore);

      expect(state.splitState.left).toContain(id1);
      expect(state.splitState.right).toEqual([]);
    });

    it("moving from source pane that becomes empty closes the split", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      // Move to right to create split
      tabStore.moveToPane("right");
      // Now move back to left; right pane becomes empty
      tabStore.moveToPane("left");
      const state = get(tabStore);

      expect(state.splitState.right).toEqual([]);
      expect(state.splitState.left).toContain(id1);
    });
  });

  describe("Test 7: setDirty", () => {
    it("setDirty(tabId, true) sets isDirty to true", () => {
      const id = tabStore.openTab("/vault/a.md");
      tabStore.setDirty(id, true);
      const tab = get(tabStore).tabs.find((t) => t.id === id);
      expect(tab?.isDirty).toBe(true);
    });

    it("setDirty(tabId, false) clears isDirty", () => {
      const id = tabStore.openTab("/vault/a.md");
      tabStore.setDirty(id, true);
      tabStore.setDirty(id, false);
      const tab = get(tabStore).tabs.find((t) => t.id === id);
      expect(tab?.isDirty).toBe(false);
    });
  });

  describe("Test 8: updateScrollPos", () => {
    it("persists scrollPos and cursorPos for a tab", () => {
      const id = tabStore.openTab("/vault/a.md");
      tabStore.updateScrollPos(id, 42, 100);
      const tab = get(tabStore).tabs.find((t) => t.id === id);
      expect(tab?.scrollPos).toBe(42);
      expect(tab?.cursorPos).toBe(100);
    });
  });

  describe("updateFilePath", () => {
    it("updates the filePath of a tab when renamed", () => {
      const id = tabStore.openTab("/vault/old-name.md");
      tabStore.updateFilePath("/vault/old-name.md", "/vault/new-name.md");
      const tab = get(tabStore).tabs.find((t) => t.id === id);
      expect(tab?.filePath).toBe("/vault/new-name.md");
    });

    it("does nothing if oldPath does not match any tab", () => {
      const id = tabStore.openTab("/vault/a.md");
      tabStore.updateFilePath("/vault/nonexistent.md", "/vault/other.md");
      const tab = get(tabStore).tabs.find((t) => t.id === id);
      expect(tab?.filePath).toBe("/vault/a.md");
    });
  });

  describe("closeByPath", () => {
    it("closes any tab with matching filePath", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      tabStore.closeByPath("/vault/a.md");
      const state = get(tabStore);

      expect(state.tabs.find((t) => t.id === id1)).toBeUndefined();
      expect(state.tabs.find((t) => t.id === id2)).toBeDefined();
    });
  });

  describe("activateTab", () => {
    it("sets activeTabId and switches activePane", () => {
      const id1 = tabStore.openTab("/vault/a.md");
      const id2 = tabStore.openTab("/vault/b.md");
      tabStore.activateTab(id2);
      tabStore.moveToPane("right");
      // Now id1 is in left, id2 is in right; activate id1
      tabStore.activateTab(id1);
      const state = get(tabStore);

      expect(state.activeTabId).toBe(id1);
      expect(state.splitState.activePane).toBe("left");
    });
  });
});
