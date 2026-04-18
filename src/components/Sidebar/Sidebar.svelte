<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { FilePlus, FolderPlus, Network, ChevronDown, FileText, LayoutDashboard } from "lucide-svelte";
  import { listDirectory, createFile, createFolder, writeFile } from "../../ipc/commands";
  import { serializeCanvas, emptyCanvas } from "../../lib/canvas/parse";
  import { commandRegistry } from "../../lib/commands/registry";
  import { CMD_IDS } from "../../lib/commands/defaultCommands";
  // BUG-05.1: SortMenu was descoped per UAT — keep treeState for FILE-07
  // (expand persistence) but default sortBy stays "name" without a UI toggle.
  import {
    loadTreeState,
    saveTreeState,
    sortEntries,
    type TreeState,
    DEFAULT_TREE_STATE,
  } from "../../lib/treeState";
  import { vaultStore } from "../../store/vaultStore";
  import { toastStore } from "../../store/toastStore";
  import { progressStore } from "../../store/progressStore";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import type { DirEntry } from "../../types/tree";
  import {
    listenFileChange,
    listenBulkChangeStart,
    listenBulkChangeEnd,
    type FileChangePayload,
    type BulkChangePayload,
  } from "../../ipc/events";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import { tabStore } from "../../store/tabStore";
  import { searchStore } from "../../store/searchStore";
  import { treeRefreshStore } from "../../store/treeRefreshStore";
  import { treeRevealStore } from "../../store/treeRevealStore";
  import { tagsStore } from "../../store/tagsStore";
  import { Hash } from "lucide-svelte";
  import TreeNode from "./TreeNode.svelte";
  import ProgressBar from "../Progress/ProgressBar.svelte";
  import SearchPanel from "../Search/SearchPanel.svelte";
  import TagsPanel from "../Tags/TagsPanel.svelte";
  import BookmarksPanel from "../Bookmarks/BookmarksPanel.svelte";
  import { bookmarksStore } from "../../store/bookmarksStore";

  interface Props {
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onOpenFile: (path: string) => void;
  }

  let { selectedPath, onSelect, onOpenFile }: Props = $props();

  let rootEntries = $state<DirEntry[]>([]);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let bulkActive = $state(false);
  let bulkCount = $state(0);
  let treeState = $state<TreeState>({ ...DEFAULT_TREE_STATE });

  // #145 — header "+ New ▾" split/dropdown open state. Primary click of the
  // button creates a note; clicking the chevron opens this menu so canvas
  // creation is visible without right-clicking a folder first.
  let newMenuOpen = $state(false);
  const newNoteHotkey = $derived(commandRegistry.getEffectiveHotkey(CMD_IDS.NEW_NOTE));
  const newCanvasHotkey = $derived(commandRegistry.getEffectiveHotkey(CMD_IDS.NEW_CANVAS));

  function formatHotkey(h: { meta: boolean; shift?: boolean; key: string } | undefined): string {
    if (!h) return "";
    const isMac = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
    const meta = h.meta ? (isMac ? "⌘" : "Ctrl+") : "";
    const shift = h.shift ? (isMac ? "⇧" : "Shift+") : "";
    const key = h.key.length === 1 ? h.key.toUpperCase() : h.key;
    return isMac ? `${meta}${shift}${key}` : `${meta}${shift}${key}`;
  }

  // Watcher unlisten handles — cleaned up on destroy
  let unlistenFileChange: UnlistenFn | null = null;
  let unlistenBulkStart: UnlistenFn | null = null;
  let unlistenBulkEnd: UnlistenFn | null = null;

  const vaultName = $derived(
    $vaultStore.currentPath
      ? $vaultStore.currentPath.split("/").pop() ?? $vaultStore.currentPath
      : "No vault"
  );

  /** Compute vault-relative path from an absolute path. */
  function vaultRel(absPath: string): string {
    const vaultPath = $vaultStore.currentPath ?? "";
    if (absPath.startsWith(vaultPath + "/")) {
      return absPath.slice(vaultPath.length + 1).replace(/\\/g, "/");
    }
    return absPath.replace(/\\/g, "/");
  }

  async function loadRoot() {
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    // Only show loading spinner on initial load — refreshes silently update
    // rootEntries to avoid destroying TreeNode components and losing their
    // local expanded state.
    const isInitialLoad = rootEntries.length === 0;
    if (isInitialLoad) loading = true;
    loadError = null;
    try {
      const raw = await listDirectory(vaultPath);
      rootEntries = sortEntries(raw, treeState.sortBy);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      loadError = vaultErrorCopy(ve);
      toastStore.push({ variant: "error", message: loadError });
    } finally {
      if (isInitialLoad) loading = false;
    }
  }

  // ─── Watcher event handlers ────────────────────────────────────────────────

  function handleFileChange(payload: FileChangePayload) {
    const { path, kind, new_path } = payload;

    if (kind === "create") {
      // Invalidate tree: re-fetch root to show the new file
      void loadRoot();
    } else if (kind === "modify") {
      // No tree structure change needed for content modifications.
      // If the file is open in a tab, EditorPane handles merge (Plan 05).
      // No action needed here.
    } else if (kind === "delete") {
      // Invalidate tree: re-fetch root to remove the deleted entry
      void loadRoot();
      // Close the tab if this file is open
      tabStore.closeByPath(path);
    } else if (kind === "rename") {
      // Invalidate tree for both old and new parent directories
      void loadRoot();
      // Update tab path if file is open in a tab
      if (new_path) {
        tabStore.updateFilePath(path, new_path);
      }
    }
  }

  function handleBulkStart(payload: BulkChangePayload) {
    // Show bulk-change progress UI in sidebar header area (D-13)
    bulkActive = true;
    bulkCount = payload.estimated_count;
    progressStore.start(payload.estimated_count);
  }

  function handleBulkEnd() {
    // Hide bulk progress UI and refresh the full tree
    bulkActive = false;
    bulkCount = 0;
    progressStore.finish();
    void loadRoot();
  }

  // ─── Mount / Destroy ────────────────────────────────────────────────────────

  let prevRefreshToken: string | null = null;
  let unsubTreeRefresh: (() => void) | null = null;
  let prevRevealToken: string | null = null;
  let unsubTreeReveal: (() => void) | null = null;

  /**
   * Collect every ancestor folder rel path of the target. For
   * "notes/daily/today.md" this returns ["notes", "notes/daily"]. The target
   * itself is not included (only its enclosing folders need to be expanded).
   */
  function ancestorFolderPaths(relPath: string): string[] {
    const parts = relPath.split("/").filter((p) => p.length > 0);
    if (parts.length <= 1) return [];
    const out: string[] = [];
    for (let i = 1; i < parts.length; i += 1) {
      out.push(parts.slice(0, i).join("/"));
    }
    return out;
  }

  async function onExpandToggle(relPath: string, isExpanded: boolean) {
    const expanded = new Set(treeState.expanded);
    if (isExpanded) expanded.add(relPath);
    else expanded.delete(relPath);
    treeState = { ...treeState, expanded: Array.from(expanded) };
    await saveTreeState($vaultStore.currentPath ?? "", treeState);
  }

  // BUG-05.1 (#11): on cold start, vault auto-load is async in App.svelte.
  // Sidebar might mount before $vaultStore.currentPath is populated — the
  // onMount loadTreeState() call would run with a null path and skip,
  // leaving treeState at DEFAULT (empty expanded). Fix by subscribing to
  // vaultStore and re-loading treeState whenever currentPath transitions
  // from null/old to a new value. Mirrors EditorPane's reloadResolvedLinks pattern.
  let prevVaultPathSeen: string | null = null;
  const unsubVaultPathSidebar = vaultStore.subscribe(async (state) => {
    if (state.currentPath !== prevVaultPathSeen) {
      prevVaultPathSeen = state.currentPath;
      if (state.currentPath) {
        treeState = await loadTreeState(state.currentPath);
        void loadRoot();
        void tagsStore.reload();
        void bookmarksStore.load(state.currentPath);
      } else {
        bookmarksStore.reset();
      }
    }
  });

  onMount(async () => {
    // Subscribe to watcher events (SYNC-01, SYNC-05)
    unlistenFileChange = await listenFileChange(handleFileChange);
    unlistenBulkStart = await listenBulkChangeStart(handleBulkStart);
    unlistenBulkEnd = await listenBulkChangeEnd(handleBulkEnd);

    // Subscribe to tree-refresh signal — callers that create files through
    // backend paths (which bypass the watcher via write-ignore) use this
    // to force a sidebar reload. See EditorPane click-to-create.
    // Also reload tags on the same signal (watcher dispatches UpdateTags
    // on the same event batch that triggers tree refresh).
    unsubTreeRefresh = treeRefreshStore.subscribe((state) => {
      if (state.token && state.token !== prevRefreshToken) {
        prevRefreshToken = state.token;
        void loadRoot();
        if ($vaultStore.currentPath) void tagsStore.reload();
      }
    });

    // Reveal requests — issued by the breadcrumb bar. Flip to the files
    // tab and ensure every ancestor folder is in the persisted expanded
    // list so freshly rendered TreeNodes mount expanded. TreeNode owns
    // the scroll-into-view + per-instance expansion via its own
    // treeRevealStore subscription.
    unsubTreeReveal = treeRevealStore.subscribe(async (state) => {
      if (!state.pending) return;
      if (state.pending.token === prevRevealToken) return;
      prevRevealToken = state.pending.token;

      searchStore.setActiveTab("files");

      const ancestors = ancestorFolderPaths(state.pending.relPath);
      if (ancestors.length === 0) return;
      const expanded = new Set(treeState.expanded);
      let changed = false;
      for (const p of ancestors) {
        if (!expanded.has(p)) {
          expanded.add(p);
          changed = true;
        }
      }
      if (changed) {
        treeState = { ...treeState, expanded: Array.from(expanded) };
        await saveTreeState($vaultStore.currentPath ?? "", treeState);
      }
    });
  });

  onDestroy(() => {
    unlistenFileChange?.();
    unlistenBulkStart?.();
    unlistenBulkEnd?.();
    unsubTreeRefresh?.();
    unsubTreeReveal?.();
    unsubVaultPathSidebar?.();
    tagsStore.reset();
  });

  async function handleNewFile() {
    newMenuOpen = false;
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    const targetFolder = getSelectedFolder() ?? vaultPath;
    try {
      await createFile(targetFolder, "");
      await loadRoot();
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  // #145 — header-level canvas creation. Targets the selected folder so
  // dropdown + context-menu behavior stay symmetric. Seeds the file with an
  // empty canvas doc (matches TreeNode.handleNewCanvasHere) so Obsidian
  // accepts it on first open.
  async function handleNewCanvas() {
    newMenuOpen = false;
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    const targetFolder = getSelectedFolder() ?? vaultPath;
    try {
      const newPath = await createFile(targetFolder, "Untitled.canvas");
      await writeFile(newPath, serializeCanvas(emptyCanvas()));
      await loadRoot();
      tabStore.openFileTab(newPath, "canvas");
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleNewFolder() {
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    const targetFolder = getSelectedFolder() ?? vaultPath;
    try {
      await createFolder(targetFolder, "");
      await loadRoot();
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  function getSelectedFolder(): string | null {
    if (!selectedPath) return null;
    // Check if selectedPath is a directory in root entries
    const entry = rootEntries.find((e) => e.path === selectedPath);
    if (entry?.is_dir) return selectedPath;
    return null;
  }

  function handlePathChanged(oldPath: string, newPath: string) {
    tabStore.updateFilePath(oldPath, newPath);
    void loadRoot();
  }
</script>

<aside class="vc-sidebar" data-testid="sidebar">
  <!-- Tab bar — Dateien / Suche switching (D-01) -->
  <div class="vc-sidebar-tabs" role="tablist">
    <button
      class="vc-sidebar-tab"
      role="tab"
      aria-selected={$searchStore.activeTab === 'files'}
      onclick={() => searchStore.setActiveTab('files')}
    >Dateien</button>
    <button
      class="vc-sidebar-tab"
      role="tab"
      aria-selected={$searchStore.activeTab === 'search'}
      onclick={() => searchStore.setActiveTab('search')}
    >Suche</button>
    <button
      type="button"
      class="vc-sidebar-tab"
      role="tab"
      aria-selected={$searchStore.activeTab === 'tags'}
      aria-label="Tags-Bereich"
      onclick={() => searchStore.setActiveTab('tags')}
    >
      <Hash size={14} />
      <span>Tags</span>
    </button>
  </div>

  {#if $searchStore.activeTab === 'search'}
    <!-- Search panel tab panel -->
    <div class="vc-sidebar-tabpanel" role="tabpanel">
      <SearchPanel {onOpenFile} />
    </div>
  {:else if $searchStore.activeTab === 'tags'}
    <!-- Tags panel tab panel -->
    <div class="vc-sidebar-tabpanel" role="tabpanel">
      <TagsPanel />
    </div>
  {:else}
  <!-- Files tab panel — Header strip and tree -->
  <!-- Header strip — replaced by bulk progress bar when bulk changes arrive -->
  <header class="vc-sidebar-header">
    {#if bulkActive}
      <!-- Bulk-change progress UI (D-13): replaces normal header during burst -->
      <div class="vc-sidebar-bulk-progress">
        <span class="vc-sidebar-bulk-label">Scanning changes...</span>
        <span class="vc-sidebar-bulk-count">{bulkCount.toLocaleString()} files</span>
      </div>
    {:else}
      <span class="vc-sidebar-vaultname" title={$vaultStore.currentPath ?? ""}>
        {vaultName}
      </span>
      <div class="vc-sidebar-actions" style="position: relative;">
        <!-- #145: split/dropdown "+ New ▾". Primary click = new note (parity
             with the previous lone FilePlus button); chevron toggles a menu
             that exposes canvas creation as a first-class action. -->
        <div class="vc-new-split" data-testid="sidebar-new-split">
          <button
            class="vc-sidebar-action-btn vc-new-split-primary"
            onclick={handleNewFile}
            aria-label="New note"
            title={`New note${newNoteHotkey ? ` (${formatHotkey(newNoteHotkey)})` : ""}`}
            data-testid="sidebar-new-note"
          >
            <FilePlus size={16} strokeWidth={1.5} />
          </button>
          <button
            class="vc-sidebar-action-btn vc-new-split-chevron"
            onclick={() => { newMenuOpen = !newMenuOpen; }}
            aria-label="More file types"
            aria-haspopup="menu"
            aria-expanded={newMenuOpen}
            title="More file types"
            data-testid="sidebar-new-menu-toggle"
          >
            <ChevronDown size={12} strokeWidth={1.5} />
          </button>
          {#if newMenuOpen}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              class="vc-new-overlay"
              onclick={() => { newMenuOpen = false; }}
              role="presentation"
            ></div>
            <div class="vc-new-menu" role="menu" data-testid="sidebar-new-menu">
              <button
                class="vc-new-menu-item"
                role="menuitem"
                onclick={handleNewFile}
                data-testid="sidebar-new-menu-note"
              >
                <FileText size={14} strokeWidth={1.5} />
                <span class="vc-new-menu-label">New note</span>
                {#if newNoteHotkey}
                  <span class="vc-new-menu-hotkey">{formatHotkey(newNoteHotkey)}</span>
                {/if}
              </button>
              <button
                class="vc-new-menu-item"
                role="menuitem"
                onclick={handleNewCanvas}
                data-testid="sidebar-new-menu-canvas"
              >
                <LayoutDashboard size={14} strokeWidth={1.5} />
                <span class="vc-new-menu-label">New canvas</span>
                {#if newCanvasHotkey}
                  <span class="vc-new-menu-hotkey">{formatHotkey(newCanvasHotkey)}</span>
                {/if}
              </button>
            </div>
          {/if}
        </div>
        <button
          class="vc-sidebar-action-btn"
          onclick={handleNewFolder}
          aria-label="New folder"
          title="New folder"
        >
          <FolderPlus size={16} strokeWidth={1.5} />
        </button>
        <button
          class="vc-sidebar-action-btn"
          onclick={() => tabStore.openGraphTab()}
          aria-label="Open graph"
          title="Open graph (Cmd/Ctrl+Shift+G)"
        >
          <Network size={16} strokeWidth={1.5} />
        </button>
      </div>
    {/if}
  </header>

  <!-- Bookmarks panel (#12) — collapsible, sits above the tree -->
  <BookmarksPanel />

  <!-- Tree area -->
  <div class="vc-sidebar-tree" role="tree" aria-label="Vault file tree">
    {#if loading}
      <p class="vc-sidebar-status">Loading...</p>
    {:else if loadError}
      <p class="vc-sidebar-status vc-sidebar-status--error">{loadError}</p>
    {:else if rootEntries.length === 0}
      <p class="vc-sidebar-status">No files in vault.</p>
    {:else}
      <ul class="vc-tree-root" role="group">
        {#each rootEntries as entry (entry.path)}
          <TreeNode
            {entry}
            depth={0}
            {selectedPath}
            {onSelect}
            {onOpenFile}
            onRefreshParent={loadRoot}
            onPathChanged={handlePathChanged}
            {onExpandToggle}
            initiallyExpanded={treeState.expanded.includes(vaultRel(entry.path))}
            expandedPaths={treeState.expanded}
            sortBy={treeState.sortBy}
          />
        {/each}
      </ul>
    {/if}
  </div>
  {/if}
</aside>

<style>
  .vc-sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg);
    overflow: hidden;
  }

  .vc-sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 40px;
    min-height: 40px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    flex-shrink: 0;
  }

  .vc-sidebar-vaultname {
    font-size: 14px;
    font-weight: 700;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    margin-right: 8px;
  }

  .vc-sidebar-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .vc-sidebar-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-text-muted);
    padding: 0;
  }

  .vc-sidebar-action-btn:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  /* #145 — split/dropdown "+ New ▾". The two buttons share a hover state so
     users read the group as one control; the chevron is narrower to signal
     it's a secondary target. */
  .vc-new-split {
    display: inline-flex;
    align-items: stretch;
    border-radius: 4px;
  }

  .vc-new-split-primary {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    padding-right: 4px;
  }

  .vc-new-split-chevron {
    width: 18px;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    padding: 0;
    margin-left: -2px;
  }

  .vc-new-split:hover .vc-sidebar-action-btn {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-new-overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .vc-new-menu {
    position: absolute;
    top: 36px;
    right: 0;
    z-index: 100;
    min-width: 200px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
    padding: 4px 0;
  }

  .vc-new-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    font-size: 14px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text);
  }

  .vc-new-menu-item:hover {
    background: var(--color-accent-bg);
  }

  .vc-new-menu-label {
    flex: 1;
  }

  .vc-new-menu-hotkey {
    font-size: 12px;
    color: var(--color-text-muted);
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  /* Bulk-change progress strip — replaces vault name + action buttons */
  .vc-sidebar-bulk-progress {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0 4px;
  }

  .vc-sidebar-bulk-label {
    font-size: 12px;
    color: var(--color-accent);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .vc-sidebar-bulk-count {
    font-size: 11px;
    color: var(--color-text-muted);
    flex-shrink: 0;
    margin-left: 8px;
  }

  .vc-sidebar-tree {
    flex: 1 1 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .vc-tree-root {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }

  .vc-sidebar-status {
    padding: 16px;
    font-size: 12px;
    color: var(--color-text-muted);
    margin: 0;
  }

  .vc-sidebar-status--error {
    color: var(--color-error);
  }

  .vc-sidebar-tabpanel {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }
</style>
