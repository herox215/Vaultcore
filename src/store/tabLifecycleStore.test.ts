// tabLifecycleStore tests — covers open/close/activate/cycle and per-tab
// metadata mutations (dirty, view mode, scroll, rename, closeByPath,
// getActiveTab). Companion tests in tabLayoutStore.test.ts and
// tabReloadStore.test.ts cover the other two concerns; cross-concern
// behavior lives in tabStore.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { tabLifecycleStore } from "./tabLifecycleStore";
import { _reset } from "./tabStoreCore";

beforeEach(() => {
  _reset();
});

describe("tabLifecycleStore", () => {
  describe("initial state", () => {
    it("has empty tabs array, null activeTabId, splitState with empty right pane", () => {
      const state = get(tabLifecycleStore);
      expect(state.tabs).toEqual([]);
      expect(state.activeTabId).toBeNull();
      expect(state.splitState.left).toEqual([]);
      expect(state.splitState.right).toEqual([]);
      expect(state.splitState.activePane).toBe("left");
    });
  });

  describe("openTab", () => {
    it("adds a tab and sets it as activeTabId", () => {
      const id = tabLifecycleStore.openTab("/vault/note-a.md");
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0]!.filePath).toBe("/vault/note-a.md");
      expect(state.tabs[0]!.id).toBe(id);
      expect(state.activeTabId).toBe(id);
      expect(state.splitState.left).toContain(id);
    });

    it("opening a second file adds another tab", () => {
      const id1 = tabLifecycleStore.openTab("/vault/note-a.md");
      const id2 = tabLifecycleStore.openTab("/vault/note-b.md");
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe(id2);
      expect(state.splitState.left).toEqual([id1, id2]);
    });

    it("opening a duplicate filePath activates existing tab (no duplicate)", () => {
      const id1 = tabLifecycleStore.openTab("/vault/note-a.md");
      tabLifecycleStore.openTab("/vault/note-b.md");
      const id1Again = tabLifecycleStore.openTab("/vault/note-a.md");
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(2);
      expect(id1Again).toBe(id1);
      expect(state.activeTabId).toBe(id1);
    });
  });

  describe("closeTab", () => {
    it("removes the tab from the store", () => {
      const id = tabLifecycleStore.openTab("/vault/note-a.md");
      tabLifecycleStore.closeTab(id);
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(0);
      expect(state.splitState.left).not.toContain(id);
    });

    it("if active, activates the left sibling (preferred)", () => {
      tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/b.md");
      const id3 = tabLifecycleStore.openTab("/vault/c.md");
      tabLifecycleStore.closeTab(id3);
      expect(get(tabLifecycleStore).activeTabId).toBe(id2);
    });

    it("falls back to right sibling when closing leftmost active tab", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/b.md");
      tabLifecycleStore.activateTab(id1);
      tabLifecycleStore.closeTab(id1);
      expect(get(tabLifecycleStore).activeTabId).toBe(id2);
    });

    it("sets activeTabId to null when last tab is closed", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.closeTab(id);
      expect(get(tabLifecycleStore).activeTabId).toBeNull();
    });
  });

  describe("cycleTab", () => {
    it("cycles forward through tabs in same pane (wraps around)", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/b.md");
      const id3 = tabLifecycleStore.openTab("/vault/c.md");
      tabLifecycleStore.activateTab(id1);

      tabLifecycleStore.cycleTab(1);
      expect(get(tabLifecycleStore).activeTabId).toBe(id2);
      tabLifecycleStore.cycleTab(1);
      expect(get(tabLifecycleStore).activeTabId).toBe(id3);
      tabLifecycleStore.cycleTab(1);
      expect(get(tabLifecycleStore).activeTabId).toBe(id1);
    });

    it("cycles backward through tabs (wraps around)", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/b.md");
      const id3 = tabLifecycleStore.openTab("/vault/c.md");
      tabLifecycleStore.activateTab(id3);

      tabLifecycleStore.cycleTab(-1);
      expect(get(tabLifecycleStore).activeTabId).toBe(id2);

      tabLifecycleStore.activateTab(id1);
      tabLifecycleStore.cycleTab(-1);
      expect(get(tabLifecycleStore).activeTabId).toBe(id3);
    });
  });

  describe("setDirty", () => {
    it("setDirty(tabId, true) sets isDirty to true", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.setDirty(id, true);
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.isDirty).toBe(true);
    });

    it("setDirty(tabId, false) clears isDirty", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.setDirty(id, true);
      tabLifecycleStore.setDirty(id, false);
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.isDirty).toBe(false);
    });
  });

  describe("updateScrollPos", () => {
    it("persists scrollPos and cursorPos for a tab", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.updateScrollPos(id, 42, 100);
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.scrollPos).toBe(42);
      expect(tab?.cursorPos).toBe(100);
    });
  });

  describe("updateFilePath", () => {
    it("updates the filePath of a tab when renamed", () => {
      const id = tabLifecycleStore.openTab("/vault/old-name.md");
      tabLifecycleStore.updateFilePath("/vault/old-name.md", "/vault/new-name.md");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.filePath).toBe("/vault/new-name.md");
    });

    it("does nothing if oldPath does not match any tab", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.updateFilePath("/vault/nonexistent.md", "/vault/other.md");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.filePath).toBe("/vault/a.md");
    });
  });

  describe("closeByPath", () => {
    it("closes any tab with matching filePath", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/b.md");
      tabLifecycleStore.closeByPath("/vault/a.md");
      const state = get(tabLifecycleStore);
      expect(state.tabs.find((t) => t.id === id1)).toBeUndefined();
      expect(state.tabs.find((t) => t.id === id2)).toBeDefined();
    });

    it("is a no-op when no tab has the given path", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.closeByPath("/vault/missing.md");
      expect(get(tabLifecycleStore).tabs.find((t) => t.id === id)).toBeDefined();
    });
  });

  describe("openGraphTab", () => {
    it("creates a singleton graph tab and activates it", () => {
      const id = tabLifecycleStore.openGraphTab();
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(1);
      const tab = state.tabs.find((t) => t.id === id);
      expect(tab?.type).toBe("graph");
      expect(tab?.filePath).toBe("vault://graph");
      expect(state.activeTabId).toBe(id);
    });

    it("focuses the existing graph tab when called twice (no duplicate)", () => {
      const id1 = tabLifecycleStore.openGraphTab();
      tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openGraphTab();
      const state = get(tabLifecycleStore);
      expect(id2).toBe(id1);
      expect(state.tabs.filter((t) => t.type === "graph")).toHaveLength(1);
      expect(state.activeTabId).toBe(id1);
    });

    it("graph tab can be closed like any other tab", () => {
      tabLifecycleStore.openTab("/vault/a.md");
      const gid = tabLifecycleStore.openGraphTab();
      tabLifecycleStore.closeTab(gid);
      const state = get(tabLifecycleStore);
      expect(state.tabs.find((t) => t.type === "graph")).toBeUndefined();
    });

    it("cycleTab traverses graph + file tabs uniformly", () => {
      const a = tabLifecycleStore.openTab("/vault/a.md");
      const gid = tabLifecycleStore.openGraphTab();
      tabLifecycleStore.activateTab(a);
      tabLifecycleStore.cycleTab(1);
      expect(get(tabLifecycleStore).activeTabId).toBe(gid);
    });

    it("file tabs default to type undefined (backwards-compatible)", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.type).toBeUndefined();
    });
  });

  describe("activateTab", () => {
    it("sets activeTabId and switches activePane", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/b.md");
      tabLifecycleStore.activateTab(id2);
      // move id2 to right via the tabStore shim would be nicer but this keeps
      // the test within lifecycle; use the core through a direct move-to-pane
      // integration in tabStore.test.ts instead. Here, just confirm identity.
      tabLifecycleStore.activateTab(id1);
      const state = get(tabLifecycleStore);
      expect(state.activeTabId).toBe(id1);
      expect(state.splitState.activePane).toBe("left");
    });
  });

  describe("getActiveTab", () => {
    it("returns null when no tabs are open", () => {
      expect(tabLifecycleStore.getActiveTab()).toBeNull();
    });

    it("returns the active tab snapshot", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      const tab = tabLifecycleStore.getActiveTab();
      expect(tab?.id).toBe(id);
      expect(tab?.filePath).toBe("/vault/a.md");
    });
  });

  describe("closeAll", () => {
    it("clears all tabs and resets split/active state", () => {
      tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.openTab("/vault/b.md");
      tabLifecycleStore.closeAll();
      const state = get(tabLifecycleStore);
      expect(state.tabs).toEqual([]);
      expect(state.activeTabId).toBeNull();
      expect(state.splitState.left).toEqual([]);
      expect(state.splitState.right).toEqual([]);
    });
  });

  describe("Issue #63: Reading Mode per-tab view mode", () => {
    it("new tabs default viewMode to undefined (implicitly 'edit')", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.viewMode).toBeUndefined();
    });

    it("setViewMode('read') flips the tab to Reading Mode", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.setViewMode(id, "read");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.viewMode).toBe("read");
    });

    it("toggleViewMode flips between edit and read, treating undefined as edit", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.toggleViewMode(id);
      expect(get(tabLifecycleStore).tabs.find((t) => t.id === id)?.viewMode).toBe("read");
      tabLifecycleStore.toggleViewMode(id);
      expect(get(tabLifecycleStore).tabs.find((t) => t.id === id)?.viewMode).toBe("edit");
    });

    it("toggleViewMode is scoped to the given tab id", () => {
      const a = tabLifecycleStore.openTab("/vault/a.md");
      const b = tabLifecycleStore.openTab("/vault/b.md");
      tabLifecycleStore.toggleViewMode(a);
      expect(get(tabLifecycleStore).tabs.find((t) => t.id === a)?.viewMode).toBe("read");
      expect(get(tabLifecycleStore).tabs.find((t) => t.id === b)?.viewMode).toBeUndefined();
    });

    it("updateReadingScrollPos persists the reader's scroll position", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.updateReadingScrollPos(id, 420);
      expect(get(tabLifecycleStore).tabs.find((t) => t.id === id)?.readingScrollPos).toBe(420);
    });
  });
});
