// tabLifecycleStore tests — covers open/close/activate/cycle and per-tab
// metadata mutations (dirty, view mode, scroll, rename, closeByPath,
// getActiveTab). Companion tests in tabLayoutStore.test.ts and
// tabReloadStore.test.ts cover the other two concerns; cross-concern
// behavior lives in tabStore.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { tabLifecycleStore } from "./tabLifecycleStore";
import { _core, _reset } from "./tabStoreCore";

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

  // #351 — when an encrypted folder is locked, every open tab whose file
  // lives under that folder must close. Plaintext buffers are released as
  // the tab's EditorPane unmounts, which satisfies the acceptance criterion
  // of not leaving decrypted content visible or editable.
  describe("closeUnderPath", () => {
    it("closes a tab whose filePath exactly matches the folder path", () => {
      // Edge case: a file tab whose path happens to equal the folder arg.
      // Shouldn't happen in practice (a locked folder is a directory), but
      // the prefix check must not silently miss it.
      const id = tabLifecycleStore.openTab("/vault/secret");
      tabLifecycleStore.closeUnderPath("/vault/secret");
      expect(get(tabLifecycleStore).tabs.find((t) => t.id === id)).toBeUndefined();
    });

    it("closes child-file tabs under the folder", () => {
      const id1 = tabLifecycleStore.openTab("/vault/secret/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/secret/sub/b.md");
      tabLifecycleStore.closeUnderPath("/vault/secret");
      const state = get(tabLifecycleStore);
      expect(state.tabs.find((t) => t.id === id1)).toBeUndefined();
      expect(state.tabs.find((t) => t.id === id2)).toBeUndefined();
      expect(state.tabs).toHaveLength(0);
    });

    it("does NOT close siblings with a shared string prefix", () => {
      // `/vault/secret` is locked; `/vault/secretplans/*` must stay open.
      // String-startsWith alone would incorrectly match this — the check
      // must insist on a path separator boundary.
      tabLifecycleStore.openTab("/vault/secret/a.md");
      const keep = tabLifecycleStore.openTab("/vault/secretplans/note.md");
      tabLifecycleStore.closeUnderPath("/vault/secret");
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0]!.id).toBe(keep);
    });

    it("leaves unrelated tabs alone", () => {
      tabLifecycleStore.openTab("/vault/secret/a.md");
      const keep = tabLifecycleStore.openTab("/vault/other/b.md");
      tabLifecycleStore.closeUnderPath("/vault/secret");
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0]!.id).toBe(keep);
    });

    it("does not touch the graph tab", () => {
      tabLifecycleStore.openTab("/vault/secret/a.md");
      const graphId = tabLifecycleStore.openGraphTab();
      tabLifecycleStore.closeUnderPath("/vault/secret");
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0]!.id).toBe(graphId);
      expect(state.tabs[0]!.type).toBe("graph");
    });

    it("is a no-op when no tab falls under the path", () => {
      const id = tabLifecycleStore.openTab("/vault/other/a.md");
      tabLifecycleStore.closeUnderPath("/vault/secret");
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0]!.id).toBe(id);
    });

    it("reassigns activeTabId to a surviving tab when the active tab is closed", () => {
      const keep = tabLifecycleStore.openTab("/vault/other/a.md");
      const active = tabLifecycleStore.openTab("/vault/secret/x.md");
      tabLifecycleStore.activateTab(active);
      expect(get(tabLifecycleStore).activeTabId).toBe(active);
      tabLifecycleStore.closeUnderPath("/vault/secret");
      const state = get(tabLifecycleStore);
      expect(state.tabs.map((t) => t.id)).toEqual([keep]);
      expect(state.activeTabId).toBe(keep);
    });

    it("sets activeTabId to null when every surviving tab is closed", () => {
      const a = tabLifecycleStore.openTab("/vault/secret/a.md");
      tabLifecycleStore.openTab("/vault/secret/b.md");
      tabLifecycleStore.activateTab(a);
      tabLifecycleStore.closeUnderPath("/vault/secret");
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(0);
      expect(state.activeTabId).toBeNull();
    });

    it("collapses the split when the right pane is fully consumed", () => {
      const left = tabLifecycleStore.openTab("/vault/plain.md");
      const r1 = tabLifecycleStore.openTab("/vault/secret/a.md");
      const r2 = tabLifecycleStore.openTab("/vault/secret/b.md");
      // Manually stage a split — both victims live in the right pane.
      _core.update((s) => ({
        ...s,
        splitState: { left: [left], right: [r1, r2], activePane: "right" },
        activeTabId: r1,
      }));
      tabLifecycleStore.closeUnderPath("/vault/secret");
      const state = get(tabLifecycleStore);
      expect(state.tabs.map((t) => t.id)).toEqual([left]);
      expect(state.splitState.left).toEqual([left]);
      expect(state.splitState.right).toEqual([]);
      expect(state.splitState.activePane).toBe("left");
      expect(state.activeTabId).toBe(left);
    });

    it("collapses the split when the left pane is fully consumed", () => {
      // Mirror of the right-pane-consumed case — survivors live in the
      // right pane, so the collapse must move them into the now-sole
      // left pane and flip activePane to "left".
      const l1 = tabLifecycleStore.openTab("/vault/secret/a.md");
      const l2 = tabLifecycleStore.openTab("/vault/secret/b.md");
      const right = tabLifecycleStore.openTab("/vault/plain.md");
      _core.update((s) => ({
        ...s,
        splitState: { left: [l1, l2], right: [right], activePane: "left" },
        activeTabId: l1,
      }));
      tabLifecycleStore.closeUnderPath("/vault/secret");
      const state = get(tabLifecycleStore);
      expect(state.tabs.map((t) => t.id)).toEqual([right]);
      expect(state.splitState.left).toEqual([right]);
      expect(state.splitState.right).toEqual([]);
      expect(state.splitState.activePane).toBe("left");
      expect(state.activeTabId).toBe(right);
    });

    it("tolerates Windows-style backslash separators in tab paths", () => {
      // Tauri on Windows returns paths with `\\` separators; the prefix
      // check must compare them in a separator-agnostic way.
      tabLifecycleStore.openTab("C:\\vault\\secret\\a.md");
      const keep = tabLifecycleStore.openTab("C:\\vault\\other\\b.md");
      tabLifecycleStore.closeUnderPath("C:\\vault\\secret");
      const state = get(tabLifecycleStore);
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0]!.id).toBe(keep);
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
    it("sets activeTabId on same-pane activation and keeps activePane unchanged", () => {
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.openTab("/vault/b.md");
      tabLifecycleStore.activateTab(id1);
      const state = get(tabLifecycleStore);
      expect(state.activeTabId).toBe(id1);
      expect(state.splitState.activePane).toBe("left");
    });

    it("flips activePane when the target tab lives in the other pane", () => {
      // Seed state directly via _core to keep this lifecycle-scoped test from
      // depending on tabLayoutStore.moveToPane.
      const id1 = tabLifecycleStore.openTab("/vault/a.md");
      const id2 = tabLifecycleStore.openTab("/vault/b.md");
      _core.update((s) => ({
        ...s,
        splitState: { left: [id1], right: [id2], activePane: "left" },
        activeTabId: id1,
      }));
      expect(get(tabLifecycleStore).splitState.activePane).toBe("left");

      tabLifecycleStore.activateTab(id2);

      const state = get(tabLifecycleStore);
      expect(state.activeTabId).toBe(id2);
      expect(state.splitState.activePane).toBe("right");
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

  describe("save-snapshot per-tab metadata", () => {
    it("setLastSavedContent persists the base snapshot for three-way merge", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.setLastSavedContent(id, "snapshot body");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.lastSavedContent).toBe("snapshot body");
    });

    it("setLastSavedHash records the disk hash on the tab", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      tabLifecycleStore.setLastSavedHash(id, "abc123");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.lastSavedHash).toBe("abc123");
    });

    it("setLastSavedHash(id, null) is distinguishable from never-set (#80)", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      const before = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(before?.lastSavedHash).toBeUndefined();
      tabLifecycleStore.setLastSavedHash(id, null);
      const after = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(after?.lastSavedHash).toBeNull();
      expect(after?.lastSavedHash === undefined).toBe(false);
    });

    it("save-snapshot mutations are scoped to the given tab", () => {
      const a = tabLifecycleStore.openTab("/vault/a.md");
      const b = tabLifecycleStore.openTab("/vault/b.md");
      tabLifecycleStore.setLastSavedContent(a, "A body");
      tabLifecycleStore.setLastSavedHash(a, "hash-a");
      const tabA = get(tabLifecycleStore).tabs.find((t) => t.id === a);
      const tabB = get(tabLifecycleStore).tabs.find((t) => t.id === b);
      expect(tabA?.lastSavedContent).toBe("A body");
      expect(tabA?.lastSavedHash).toBe("hash-a");
      expect(tabB?.lastSavedContent).toBe("");
      expect(tabB?.lastSavedHash).toBeUndefined();
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

  // #388 — optional `viewMode` hint on the openers so UI-boundary callers
  // can opt new tabs into Reading Mode (mobile default) without the store
  // itself reading viewportStore. Hint applies on tab CREATION only;
  // existing-tab dedupe preserves the user's last explicit mode.
  describe("Issue #388: viewMode hint on openTab / openFileTab", () => {
    it("openTab with no second arg leaves viewMode undefined (no behavior change)", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.viewMode).toBeUndefined();
    });

    it("openTab with viewMode='read' sets the new tab to Reading Mode", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md", "read");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.viewMode).toBe("read");
    });

    it("openTab with viewMode='edit' writes the field explicitly", () => {
      const id = tabLifecycleStore.openTab("/vault/a.md", "edit");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.viewMode).toBe("edit");
    });

    it("openFileTab with viewMode='read' sets the new tab to Reading Mode", () => {
      const id = tabLifecycleStore.openFileTab("/vault/a.md", "markdown", "read");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.viewMode).toBe("read");
    });

    it("openFileTab passes viewMode through verbatim — store does not filter by viewer kind", () => {
      // The store is environment-agnostic and viewer-agnostic. It writes the
      // hint as given. Filtering is the caller's responsibility (openFileAsTab
      // never passes the hint for image / canvas / text viewers).
      const id = tabLifecycleStore.openFileTab("/vault/img.png", "image", "read");
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id);
      expect(tab?.viewMode).toBe("read");
    });

    it("dedupe path preserves the existing tab's viewMode (hint ignored on re-open)", () => {
      // VaultCore is desktop-only today (no roaming between platforms), so an
      // existing tab's mode reflects the user's last explicit choice. Re-open
      // hints from a different viewport must NOT clobber it. If multi-platform
      // sync is added later, revisit this rule.
      const id1 = tabLifecycleStore.openTab("/vault/a.md", "read");
      tabLifecycleStore.setViewMode(id1, "edit");
      const id2 = tabLifecycleStore.openTab("/vault/a.md", "read");
      expect(id2).toBe(id1);
      const tab = get(tabLifecycleStore).tabs.find((t) => t.id === id1);
      expect(tab?.viewMode).toBe("edit");
    });
  });
});
