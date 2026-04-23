// tabStore — compatibility shim over the three facades introduced by #341.
//
// New code should import from the specific facade for the concern it touches:
//   • tabLifecycleStore — open/close/activate/cycle/per-tab metadata
//   • tabLayoutStore    — moveToPane / reorderPane
//   • tabReloadStore    — reload request + save snapshot state
//
// This shim exists to keep the existing 38+ consumers of `tabStore` working
// unchanged; it does not add any API beyond what those consumers already use.
//
// The `_reorderPane` alias preserves the pre-refactor method name for
// TabBar.svelte; new callers should use tabLayoutStore.reorderPane directly.

import { _core, _reset } from "./tabStoreCore";
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

  // Layout
  moveToPane: tabLayoutStore.moveToPane,
  /** Preserved alias — new callers: use tabLayoutStore.reorderPane. */
  _reorderPane: tabLayoutStore.reorderPane,

  // Reload / save snapshot
  setLastSavedContent: tabReloadStore.setLastSavedContent,
  setLastSavedHash: tabReloadStore.setLastSavedHash,

  // Test helper
  _reset,
};
