// tabStore — classic Svelte `writable` store per D-06 / RC-01.
// Manages multi-tab layout and split-view state for Plan 03 (EDIT-05, EDIT-06).
// editorStore continues to handle per-active-tab CM6 content and hash state.

import { writable } from "svelte/store";

export interface Tab {
  id: string;
  filePath: string;
  isDirty: boolean;
  scrollPos: number;
  cursorPos: number;
  lastSaved: number;
  lastSavedContent: string;  // base snapshot for three-way merge (Plan 05)
}

export interface SplitState {
  left: string[];  // Tab IDs in left pane
  right: string[]; // Tab IDs in right pane (empty = no split)
  activePane: "left" | "right";
}

export interface TabStoreState {
  tabs: Tab[];
  activeTabId: string | null;
  splitState: SplitState;
}

const initial: TabStoreState = {
  tabs: [],
  activeTabId: null,
  splitState: { left: [], right: [], activePane: "left" },
};

function makeInitial(): TabStoreState {
  return {
    tabs: [],
    activeTabId: null,
    splitState: { left: [], right: [], activePane: "left" },
  };
}

const _store = writable<TabStoreState>(makeInitial());

function findTabById(state: TabStoreState, id: string): Tab | undefined {
  return state.tabs.find((t) => t.id === id);
}

function whichPane(state: TabStoreState, tabId: string): "left" | "right" | null {
  if (state.splitState.left.includes(tabId)) return "left";
  if (state.splitState.right.includes(tabId)) return "right";
  return null;
}

export const tabStore = {
  subscribe: _store.subscribe,

  /**
   * Open a tab for the given file path.
   * If a tab with the same path already exists, activate it (no duplicate).
   * Otherwise, create a new tab in the currently active pane.
   * Returns the tab ID.
   */
  openTab(filePath: string): string {
    let returnId = "";
    _store.update((state) => {
      // Check for existing tab with same filePath
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

      // Create new tab
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

      const activePane = state.splitState.activePane;
      const newPaneIds = [...state.splitState[activePane], id];
      return {
        ...state,
        tabs: [...state.tabs, tab],
        activeTabId: id,
        splitState: {
          ...state.splitState,
          [activePane]: newPaneIds,
        },
      };
    });
    return returnId;
  },

  /**
   * Close a tab by ID.
   * If it was active, activates the left sibling (or right if it was leftmost).
   * If a split pane becomes empty after close, merges it back to one pane.
   */
  closeTab(tabId: string): void {
    _store.update((state) => {
      const pane = whichPane(state, tabId);
      if (pane === null) return state; // tab not found

      const paneIds = state.splitState[pane];
      const idx = paneIds.indexOf(tabId);
      const newPaneIds = paneIds.filter((id) => id !== tabId);
      const newTabs = state.tabs.filter((t) => t.id !== tabId);

      // Determine new active tab
      let newActiveTabId = state.activeTabId;
      let newSplitState: SplitState;

      // Handle pane becoming empty
      const otherPane: "left" | "right" = pane === "left" ? "right" : "left";
      if (newPaneIds.length === 0 && state.splitState[otherPane].length > 0) {
        // Merge remaining tabs into left pane
        const mergedLeft = pane === "left"
          ? state.splitState[otherPane]
          : newPaneIds.concat(state.splitState.right.filter((id) => id !== tabId));

        const allLeft = state.splitState.left
          .filter((id) => id !== tabId)
          .concat(state.splitState.right.filter((id) => id !== tabId));

        newSplitState = { left: allLeft, right: [], activePane: "left" };
        // Active tab: keep current or pick first from merged
        if (newActiveTabId === tabId) {
          newActiveTabId = allLeft[0] ?? null;
        }
      } else {
        newSplitState = { ...state.splitState, [pane]: newPaneIds };

        if (state.activeTabId === tabId) {
          // Prefer left sibling, then right sibling
          if (idx > 0 && newPaneIds[idx - 1]) {
            newActiveTabId = newPaneIds[idx - 1];
          } else if (newPaneIds[idx]) {
            newActiveTabId = newPaneIds[idx];
          } else if (newPaneIds.length > 0) {
            newActiveTabId = newPaneIds[newPaneIds.length - 1];
          } else {
            // Pane empty but split still exists — pick from other pane
            const other = state.splitState[otherPane];
            newActiveTabId = other.length > 0 ? other[0] : null;
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
    _store.update((state) => {
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
    _store.update((state) => {
      const pane = state.splitState.activePane;
      const paneIds = state.splitState[pane];
      if (paneIds.length === 0) return state;

      const currentIdx = state.activeTabId ? paneIds.indexOf(state.activeTabId) : -1;
      const nextIdx = (currentIdx + direction + paneIds.length) % paneIds.length;
      return { ...state, activeTabId: paneIds[nextIdx] };
    });
  },

  /**
   * Move the currently active tab to the specified pane.
   * Creates a split if the target pane was empty.
   * If the source pane becomes empty, closes that pane (merge back to one pane).
   */
  moveToPane(targetPane: "left" | "right"): void {
    _store.update((state) => {
      const activeTabId = state.activeTabId;
      if (!activeTabId) return state;

      const sourcePane = whichPane(state, activeTabId);
      if (sourcePane === null) return state;
      if (sourcePane === targetPane) return state; // already there

      const newSourceIds = state.splitState[sourcePane].filter((id) => id !== activeTabId);
      const newTargetIds = [...state.splitState[targetPane], activeTabId];

      let newSplitState: SplitState;
      if (newSourceIds.length === 0) {
        // Source pane is now empty — collapse split to one pane (always left)
        // All tabs end up in left pane
        const leftIds = targetPane === "left" ? newTargetIds : newTargetIds;
        newSplitState = {
          left: leftIds,
          right: [],
          activePane: "left",
        };
      } else {
        newSplitState = {
          ...state.splitState,
          [sourcePane]: newSourceIds,
          [targetPane]: newTargetIds,
          activePane: targetPane,
        };
      }

      return {
        ...state,
        splitState: newSplitState,
      };
    });
  },

  /**
   * Set the isDirty flag on a tab (true = unsaved changes, shows dirty dot in tab UI).
   */
  setDirty(tabId: string, dirty: boolean): void {
    _store.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, isDirty: dirty } : t)),
    }));
  },

  /**
   * Persist scroll and cursor position for a tab so they can be restored on re-activate.
   */
  updateScrollPos(tabId: string, scrollPos: number, cursorPos: number): void {
    _store.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, scrollPos, cursorPos } : t)),
    }));
  },

  /**
   * When a file is renamed/moved, update the matching tab's filePath.
   */
  updateFilePath(oldPath: string, newPath: string): void {
    _store.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.filePath === oldPath ? { ...t, filePath: newPath } : t)),
    }));
  },

  /**
   * Close any tab with the given filePath (used when a file is deleted).
   */
  closeByPath(filePath: string): void {
    _store.update((state) => {
      const tab = state.tabs.find((t) => t.filePath === filePath);
      if (!tab) return state;
      // Reuse closeTab logic via internal state mutation
      return state;
    });
    // Get current state, find tab, then closeTab
    let tabId: string | undefined;
    const unsub = _store.subscribe((state) => {
      tabId = state.tabs.find((t) => t.filePath === filePath)?.id;
    });
    unsub();
    if (tabId) {
      tabStore.closeTab(tabId);
    }
  },

  /**
   * Read the current active tab (snapshot — not reactive).
   * Returns null if no tabs are open.
   */
  getActiveTab(): Tab | null {
    let result: Tab | null = null;
    const unsub = _store.subscribe((state) => {
      result = state.activeTabId
        ? (state.tabs.find((t) => t.id === state.activeTabId) ?? null)
        : null;
    });
    unsub();
    return result;
  },

  /**
   * Update the base snapshot content used for three-way merge (Plan 05).
   * Called after auto-save completes, so the snapshot tracks what's on disk.
   */
  setLastSavedContent(tabId: string, content: string): void {
    _store.update((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, lastSavedContent: content } : t)),
    }));
  },

  /**
   * Close every tab and collapse the split. Used when the vault changes at
   * runtime — tabs reference absolute paths inside the old vault and must not
   * leak across a switch.
   */
  closeAll(): void {
    _store.set(makeInitial());
  },

  /**
   * Reorder the tab IDs in a specific pane (used by drag-to-reorder in TabBar).
   */
  _reorderPane(pane: "left" | "right", newIds: string[]): void {
    _store.update((state) => ({
      ...state,
      splitState: { ...state.splitState, [pane]: newIds },
    }));
  },

  /**
   * Test helper — resets to initial state.
   */
  _reset(): void {
    _store.set(makeInitial());
  },
};
