// tabStore — compatibility shim over the three facades introduced by #341.
//
// New code should import from the specific facade for the concern it touches:
//   • tabLifecycleStore — Tab[] slice (open/close/activate/cycle + per-tab
//     metadata including save snapshot state)
//   • tabLayoutStore    — SplitState slice (moveToPane / reorderPane)
//   • tabReloadStore    — disk-sync one-shot reload signal (independent
//     private writable; own .subscribe)
//
// This shim exists to keep the existing 38+ consumers of `tabStore` working
// unchanged; it does not add any API beyond what those consumers already use.
//
// The `_reorderPane` alias preserves the pre-refactor method name for
// TabBar.svelte; new callers should use tabLayoutStore.reorderPane directly.

import { _core, _reset as _resetCore } from "./tabStoreCore";
import { tabLifecycleStore } from "./tabLifecycleStore";
import { tabLayoutStore } from "./tabLayoutStore";
import { tabReloadStore } from "./tabReloadStore";

export {
  GRAPH_TAB_PATH,
  type SplitState,
  type Tab,
  type TabStoreState,
  type TabType,
  type TabViewer,
  type TabViewMode,
} from "./tabStoreCore";

export const tabStore = {
  subscribe: _core.subscribe,

  // Lifecycle
  openTab: tabLifecycleStore.openTab,
  openFileTab: tabLifecycleStore.openFileTab,
  openGraphTab: tabLifecycleStore.openGraphTab,
  closeTab: tabLifecycleStore.closeTab,
  closeAll: tabLifecycleStore.closeAll,
  closeByPath: tabLifecycleStore.closeByPath,
  activateTab: tabLifecycleStore.activateTab,
  cycleTab: tabLifecycleStore.cycleTab,
  getActiveTab: tabLifecycleStore.getActiveTab,
  setDirty: tabLifecycleStore.setDirty,
  setViewMode: tabLifecycleStore.setViewMode,
  toggleViewMode: tabLifecycleStore.toggleViewMode,
  updateScrollPos: tabLifecycleStore.updateScrollPos,
  updateReadingScrollPos: tabLifecycleStore.updateReadingScrollPos,
  updateFilePath: tabLifecycleStore.updateFilePath,
  setLastSavedContent: tabLifecycleStore.setLastSavedContent,
  setLastSavedHash: tabLifecycleStore.setLastSavedHash,

  // Layout
  moveToPane: tabLayoutStore.moveToPane,
  /** Preserved alias — new callers: use tabLayoutStore.reorderPane. */
  _reorderPane: tabLayoutStore.reorderPane,

  /**
   * Full reset: clears both the shared core (tabs + split) and the
   * disk-sync reload signal. Tests that need only the core reset can
   * import `_reset` from tabStoreCore directly.
   */
  _reset(): void {
    _resetCore();
    tabReloadStore._reset();
  },
};
