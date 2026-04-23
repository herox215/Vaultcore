// tabLifecycleStore — tab identity + per-tab metadata (#341).
//
// Owns: open/close/replace/activate/cycle and per-tab attribute mutation
// (dirty flag, view mode, scroll positions, rename). Shares the single
// writable in tabStoreCore.ts with tabLayoutStore and tabReloadStore.
import { get } from "svelte/store";
import {
  _core,
  findTabById,
  GRAPH_TAB_PATH,
  whichPane,
  type SplitState,
  type Tab,
  type TabViewer,
  type TabViewMode,
} from "./tabStoreCore";

function openInActivePane(state: { tabs: Tab[]; splitState: SplitState }, tab: Tab) {
  const activePane = state.splitState.activePane;
  const newPaneIds = [...state.splitState[activePane], tab.id];
  return {
    tabs: [...state.tabs, tab],
    splitState: { ...state.splitState, [activePane]: newPaneIds },
  };
}

export const tabLifecycleStore = {
  subscribe: _core.subscribe,

  /**
   * Open a tab for the given file path.
   * If a tab with the same path already exists, activate it (no duplicate).
   * Otherwise, create a new tab in the currently active pane.
   * Returns the tab ID.
   */
  openTab(filePath: string): string {
    let returnId = "";
    _core.update((state) => {
      const existing = state.tabs.find((t) => t.filePath === filePath);
      if (existing) {
        returnId = existing.id;
        const pane = whichPane(state, existing.id) ?? "left";
        return {
          ...state,
          activeTabId: existing.id,
          splitState: { ...state.splitState, activePane: pane },
        };
      }

      const id = crypto.randomUUID();
      returnId = id;
      const tab: Tab = {
        id,
        filePath,
        isDirty: false,
        scrollPos: 0,
        cursorPos: 0,
        lastSaved: Date.now(),
        lastSavedContent: "",
      };
      const opened = openInActivePane(state, tab);
      return { ...state, ...opened, activeTabId: id };
    });
    return returnId;
  },

  /**
   * Open a tab with an explicit viewer kind (#49). Used for non-markdown
   * files — images, read-only text previews, and unsupported binaries.
   * Same dedupe-by-filePath semantics as openTab().
   */
  openFileTab(filePath: string, viewer: TabViewer): string {
    let returnId = "";
    _core.update((state) => {
      const existing = state.tabs.find((t) => t.filePath === filePath);
      if (existing) {
        returnId = existing.id;
        const pane = whichPane(state, existing.id) ?? "left";
        return {
          ...state,
          activeTabId: existing.id,
          splitState: { ...state.splitState, activePane: pane },
        };
      }

      const id = crypto.randomUUID();
      returnId = id;
      const tab: Tab = {
        id,
        filePath,
        isDirty: false,
        scrollPos: 0,
        cursorPos: 0,
        lastSaved: Date.now(),
        lastSavedContent: "",
        viewer,
      };
      const opened = openInActivePane(state, tab);
      return { ...state, ...opened, activeTabId: id };
    });
    return returnId;
  },

  /**
   * Open (or focus) the singleton whole-vault graph tab.
   * Returns the graph tab's ID. Uses a reserved filePath sentinel so the
   * existing dedupe-by-filePath logic in openTab still applies when called
   * repeatedly.
   */
  openGraphTab(): string {
    let returnId = "";
    _core.update((state) => {
      const existing = state.tabs.find((t) => t.type === "graph");
      if (existing) {
        returnId = existing.id;
        const pane = whichPane(state, existing.id) ?? "left";
        return {
          ...state,
          activeTabId: existing.id,
          splitState: { ...state.splitState, activePane: pane },
        };
      }

      const id = crypto.randomUUID();
      returnId = id;
      const tab: Tab = {
        id,
        filePath: GRAPH_TAB_PATH,
        isDirty: false,
        scrollPos: 0,
        cursorPos: 0,
        lastSaved: Date.now(),
        lastSavedContent: "",
        type: "graph",
      };
      const opened = openInActivePane(state, tab);
      return { ...state, ...opened, activeTabId: id };
    });
    return returnId;
  },

  /**
   * Close a tab by ID.
   * If it was active, activates the left sibling (or right if it was leftmost).
   * If a split pane becomes empty after close, merges it back to one pane.
   */
  closeTab(tabId: string): void {
    _core.update((state) => {
      const pane = whichPane(state, tabId);
      if (pane === null) return state;

      const paneIds = state.splitState[pane];
      const idx = paneIds.indexOf(tabId);
      const newPaneIds = paneIds.filter((id) => id !== tabId);
      const newTabs = state.tabs.filter((t) => t.id !== tabId);

      let newActiveTabId = state.activeTabId;
      let newSplitState: SplitState;

      const otherPane: "left" | "right" = pane === "left" ? "right" : "left";
      if (newPaneIds.length === 0 && state.splitState[otherPane].length > 0) {
        // Source pane empty after close — collapse split: all surviving tabs
        // end up in left pane, preserving order (left's remainder first, then
        // right's remainder). Active tab stays if it survived, otherwise
        // falls through to the merged pane's first tab.
        const allLeft = state.splitState.left
          .filter((id) => id !== tabId)
          .concat(state.splitState.right.filter((id) => id !== tabId));

        newSplitState = { left: allLeft, right: [], activePane: "left" };
        if (newActiveTabId === tabId) {
          newActiveTabId = allLeft[0] ?? null;
        }
      } else {
        newSplitState = { ...state.splitState, [pane]: newPaneIds };

        if (state.activeTabId === tabId) {
          if (idx > 0 && newPaneIds[idx - 1]) {
            newActiveTabId = newPaneIds[idx - 1] ?? null;
          } else if (newPaneIds[idx]) {
            newActiveTabId = newPaneIds[idx] ?? null;
          } else if (newPaneIds.length > 0) {
            newActiveTabId = newPaneIds[newPaneIds.length - 1] ?? null;
          } else {
            const other = state.splitState[otherPane];
            newActiveTabId = other.length > 0 ? (other[0] ?? null) : null;
          }
        }
      }

      return {
        ...state,
        tabs: newTabs,
        activeTabId: newActiveTabId,
        splitState: newSplitState,
      };
    });
  },

  /**
   * Activate a tab by ID, updating activePane to match the pane containing it.
   */
  activateTab(tabId: string): void {
    _core.update((state) => {
      const pane = whichPane(state, tabId) ?? state.splitState.activePane;
      return {
        ...state,
        activeTabId: tabId,
        splitState: { ...state.splitState, activePane: pane },
      };
    });
  },

  /**
   * Cycle to the next (direction=1) or previous (direction=-1) tab within
   * the active pane. Wraps around at the ends.
   */
  cycleTab(direction: 1 | -1): void {
    _core.update((state) => {
      const pane = state.splitState.activePane;
      const paneIds = state.splitState[pane];
      if (paneIds.length === 0) return state;

      const currentIdx = state.activeTabId ? paneIds.indexOf(state.activeTabId) : -1;
      const nextIdx = (currentIdx + direction + paneIds.length) % paneIds.length;
      return { ...state, activeTabId: paneIds[nextIdx] ?? state.activeTabId };
    });
  },

  /**
   * Set the isDirty flag on a tab (true = unsaved changes, shows dirty dot in tab UI).
   */
  setDirty(tabId: string, dirty: boolean): void {
    _core.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, isDirty: dirty } : t)),
    }));
  },

  /**
   * Persist scroll and cursor position for a tab so they can be restored on re-activate.
   */
  updateScrollPos(tabId: string, scrollPos: number, cursorPos: number): void {
    _core.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, scrollPos, cursorPos } : t)),
    }));
  },

  /** Persist Reading Mode scroll position (#63). */
  updateReadingScrollPos(tabId: string, readingScrollPos: number): void {
    _core.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, readingScrollPos } : t)),
    }));
  },

  /** Set the view mode on a tab (#63). */
  setViewMode(tabId: string, viewMode: TabViewMode): void {
    _core.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, viewMode } : t)),
    }));
  },

  /** Toggle between edit / read on a tab; no-op when the tab is missing (#63). */
  toggleViewMode(tabId: string): void {
    _core.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => {
        if (t.id !== tabId) return t;
        const next: TabViewMode = (t.viewMode ?? "edit") === "edit" ? "read" : "edit";
        return { ...t, viewMode: next };
      }),
    }));
  },

  /**
   * When a file is renamed/moved, update the matching tab's filePath.
   * Pure metadata mutation — callers that also need to reload the file
   * from disk must separately invoke tabReloadStore.request().
   */
  updateFilePath(oldPath: string, newPath: string): void {
    _core.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.filePath === oldPath ? { ...t, filePath: newPath } : t)),
    }));
  },

  /**
   * Close any tab with the given filePath (used when a file is deleted).
   * Single snapshot + single `_core.update` via closeTab — no redundant
   * writable emissions.
   */
  closeByPath(filePath: string): void {
    const tab = get(_core).tabs.find((t) => t.filePath === filePath);
    if (tab) {
      tabLifecycleStore.closeTab(tab.id);
    }
  },

  /**
   * Read the current active tab (snapshot — not reactive).
   * Returns null if no tabs are open.
   */
  getActiveTab(): Tab | null {
    const state = get(_core);
    if (!state.activeTabId) return null;
    return findTabById(state, state.activeTabId) ?? null;
  },

  /**
   * Close every tab and collapse the split. Used when the vault changes at
   * runtime — tabs reference absolute paths inside the old vault and must not
   * leak across a switch.
   */
  closeAll(): void {
    _core.set({
      tabs: [],
      activeTabId: null,
      splitState: { left: [], right: [], activePane: "left" },
    });
  },

  /**
   * Update the base snapshot content used for three-way merge (Plan 05).
   * Called after auto-save completes, so the snapshot tracks what's on disk.
   */
  setLastSavedContent(tabId: string, content: string): void {
    _core.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, lastSavedContent: content } : t)),
    }));
  },

  /**
   * Record the SHA-256 hash VaultCore wrote for this tab's last save.
   * Called by EditorPane after every successful writeFile so the auto-save
   * merge-check can compare disk hash against the per-tab expected hash
   * (#80 — global editorStore.lastSavedHash leaked across tabs).
   */
  setLastSavedHash(tabId: string, hash: string | null): void {
    _core.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, lastSavedHash: hash } : t)),
    }));
  },
};
