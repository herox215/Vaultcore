// tabStoreCore — shared writable backing the three tab facades (#341).
//
// Decision rule for where a new method belongs — split by data shape,
// not by causal origin. A setter belongs to the facade that owns the
// slice of state it mutates:
//   • tabLifecycleStore — anything that reads/writes the Tab[] slice
//     (open/close/activate/cycle + every per-tab field: isDirty,
//     viewMode, scrollPos, lastSavedContent, lastSavedHash, ...).
//   • tabLayoutStore    — anything that reads/writes the SplitState slice
//     (moveToPane, reorderPane).
//   • tabReloadStore    — disk-sync signal that does NOT live in the
//     shared core; it has its own private writable for the one-shot
//     reload token dispatched by the rename-cascade path.
//
// The three facades share one private writable here. Every cross-concern
// mutation (e.g. closeTab touches tabs + splitState + activeTabId) lives in
// exactly one facade method and performs a single `_core.update(...)` so
// subscribers never observe a torn intermediate state. The atomicity tests
// in tabStore.test.ts assert exactly-one emission per cross-concern op.
//
// tabStore.ts remains as a thin compatibility shim re-exporting the full
// method surface for existing consumers.
//
// Classic Svelte `writable` per D-06 / RC-01.
import { writable } from "svelte/store";

/**
 * Tab `type` discriminant — "file" is the default (normal markdown tab);
 * "graph" is the whole-vault graph view (issue #32). Graph tabs store a
 * sentinel filePath so any existing code paths that look at filePath
 * (e.g. absolute-path matching, sidebar sync) keep working without a
 * widespread refactor.
 */
export type TabType = "file" | "graph";

/**
 * Non-markdown file previews (#49). `viewer` selects which UI branch
 * EditorPane renders. Omitted on markdown tabs for backwards compatibility
 * with existing callers that never set this field.
 */
export type TabViewer = "markdown" | "image" | "text" | "unsupported" | "canvas";

/**
 * Reading Mode vs Edit Mode (#63). Persisted per-tab; only meaningful for
 * markdown tabs (image / unsupported previews ignore this flag). Defaults
 * to "edit" when omitted so existing tabs remain editable.
 */
export type TabViewMode = "edit" | "read";

/** Sentinel filePath used by the singleton graph tab. */
export const GRAPH_TAB_PATH = "vault://graph";

export interface Tab {
  id: string;
  filePath: string;
  isDirty: boolean;
  scrollPos: number;
  cursorPos: number;
  lastSaved: number;
  lastSavedContent: string;  // base snapshot for three-way merge (Plan 05)
  /**
   * SHA-256 of the last content VaultCore wrote to disk for this tab.
   * Per-tab so switching between tabs doesn't leak another tab's hash into
   * the auto-save merge check (#80). `null` when the tab has never been
   * saved in this session — the first auto-save skips the hash-verify
   * merge branch and takes the direct-write path.
   */
  lastSavedHash?: string | null;
  /** Tab kind — "file" when omitted. */
  type?: TabType;
  /**
   * Viewer used to render the tab (#49). Omitted on existing markdown tabs
   * so previous callers continue to work unchanged. "image" / "text" /
   * "unsupported" are set by openFileTab() when opening non-markdown files.
   */
  viewer?: TabViewer;
  /**
   * Reading Mode toggle (#63). "edit" = CM6 editor with live preview,
   * "read" = rendered HTML. Omitted tabs behave as "edit".
   */
  viewMode?: TabViewMode;
  /**
   * Scroll position used by Reading Mode (#63). Tracked separately from
   * `scrollPos` so switching modes can restore each view's last position
   * without clobbering the other.
   */
  readingScrollPos?: number;
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

export function makeInitial(): TabStoreState {
  return {
    tabs: [],
    activeTabId: null,
    splitState: { left: [], right: [], activePane: "left" },
  };
}

/**
 * Shared private writable. Facades import this and call `.update`/`.set`
 * directly — consumers should never see this symbol, they subscribe via
 * the facade's `.subscribe`.
 */
export const _core = writable<TabStoreState>(makeInitial());

export function findTabById(state: TabStoreState, id: string): Tab | undefined {
  return state.tabs.find((t) => t.id === id);
}

export function whichPane(state: TabStoreState, tabId: string): "left" | "right" | null {
  if (state.splitState.left.includes(tabId)) return "left";
  if (state.splitState.right.includes(tabId)) return "right";
  return null;
}

/** Reset the shared writable to its initial empty state. Test helper. */
export function _reset(): void {
  _core.set(makeInitial());
}
