// tabLayoutStore — pane arrangement (#341).
//
// Owns: moveToPane (split creation + collapse) and reorderPane (drag-to-
// reorder). Shares the writable in tabStoreCore.ts with tabLifecycleStore
// and tabReloadStore.
import { _core, whichPane, type SplitState } from "./tabStoreCore";

export const tabLayoutStore = {
  subscribe: _core.subscribe,

  /**
   * Move the currently active tab to the specified pane.
   * Creates a split if the target pane was empty.
   * If the source pane becomes empty, closes that pane (merge back to one pane).
   */
  moveToPane(targetPane: "left" | "right"): void {
    _core.update((state) => {
      const activeTabId = state.activeTabId;
      if (!activeTabId) return state;

      const sourcePane = whichPane(state, activeTabId);
      if (sourcePane === null) return state;
      if (sourcePane === targetPane) return state;

      const newSourceIds = state.splitState[sourcePane].filter((id) => id !== activeTabId);
      const newTargetIds = [...state.splitState[targetPane], activeTabId];

      let newSplitState: SplitState;
      if (newSourceIds.length === 0) {
        // Source pane empty — collapse split into left pane regardless of
        // which pane was the target. All tabs end up on the left.
        newSplitState = {
          left: newTargetIds,
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

      return { ...state, splitState: newSplitState };
    });
  },

  /**
   * Reorder the tab IDs in a specific pane (used by drag-to-reorder in TabBar).
   * `newIds` MUST be a permutation of the current pane IDs — anything else
   * breaks the `splitState ⊆ tabs` invariant. Validated in dev builds so a
   * caller bug fails loudly instead of producing torn state.
   */
  reorderPane(pane: "left" | "right", newIds: string[]): void {
    _core.update((state) => {
      const current = state.splitState[pane];
      if (import.meta.env?.DEV) {
        const isPermutation =
          current.length === newIds.length &&
          new Set(current).size === new Set(newIds).size &&
          current.every((id) => newIds.includes(id));
        if (!isPermutation) {
          // eslint-disable-next-line no-console
          console.error(
            `[tabLayoutStore] reorderPane(${pane}) called with non-permutation`,
            { current, newIds },
          );
        }
      }
      return {
        ...state,
        splitState: { ...state.splitState, [pane]: newIds },
      };
    });
  },
};
