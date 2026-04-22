<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { FilePlus, FolderPlus, Network, ChevronDown, FileText, LayoutDashboard, BookOpen } from "lucide-svelte";
  import { listDirectory, createFile, createFolder, writeFile } from "../../ipc/commands";
  import { serializeCanvas, emptyCanvas } from "../../lib/canvas/parse";
  import { commandRegistry } from "../../lib/commands/registry";
  import { CMD_IDS } from "../../lib/commands/defaultCommands";
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
  import { openHomeCanvas } from "../../lib/homeCanvas";
  import { openDocsPage } from "../../lib/docsPage";
  import { searchStore } from "../../store/searchStore";
  import { treeRefreshStore } from "../../store/treeRefreshStore";
  import { treeRevealStore } from "../../store/treeRevealStore";
  import { tagsStore } from "../../store/tagsStore";
  import { Hash } from "lucide-svelte";
  import TreeRow from "./TreeRow.svelte";
  import ProgressBar from "../Progress/ProgressBar.svelte";
  import TagsPanel from "../Tags/TagsPanel.svelte";
  import BookmarksPanel from "../Bookmarks/BookmarksPanel.svelte";
  import { bookmarksStore } from "../../store/bookmarksStore";
  import {
    flattenTree,
    ancestorRelPaths,
    toRelPath as flatToRelPath,
    type FlatRow,
    type FolderState,
    type TreeModel,
  } from "../../lib/flattenTree";

  // #253 — the sidebar is now the single owner of:
  //   - the tree model (per-folder FolderState + persisted `expanded`)
  //   - the `treeRevealStore` subscription (rows do NOT subscribe individually)
  //   - the flattened row list + virtualized renderer

  interface Props {
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onOpenFile: (path: string) => void;
    onOpenContentSearch: (query: string) => void;
  }

  let { selectedPath, onSelect, onOpenFile, onOpenContentSearch }: Props = $props();

  // ─── Tree model ────────────────────────────────────────────────────────────
  let rootEntries = $state<DirEntry[]>([]);
  let folders = $state<Map<string, FolderState>>(new Map());
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let bulkActive = $state(false);
  let bulkCount = $state(0);
  let treeState = $state<TreeState>({ ...DEFAULT_TREE_STATE });

  // ─── Header split/dropdown state ───────────────────────────────────────────
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

  // ─── Flat-list derivation ──────────────────────────────────────────────────
  const treeModel = $derived<TreeModel>({
    vaultPath: $vaultStore.currentPath ?? "",
    rootEntries,
    folders,
    expanded: new Set(treeState.expanded),
    sortBy: treeState.sortBy,
  });

  const flatRows = $derived(flattenTree(treeModel));

  // ─── Virtualization state ──────────────────────────────────────────────────
  const ROW_HEIGHT = 28; // px — keep in sync with the CSS var below
  const OVERSCAN = 10;   // rows above + below the viewport

  let scrollerEl = $state<HTMLDivElement | null>(null);
  let viewportHeight = $state(600);
  let scrollTop = $state(0);

  // The row currently inline-renaming. We always keep it inside the window so
  // the InlineRename input never recycles out.
  let renamingPath = $state<string | null>(null);

  const startIdx = $derived.by(() => {
    const first = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
    return Math.max(0, first);
  });
  const endIdx = $derived.by(() => {
    const visibleRows = Math.ceil(viewportHeight / ROW_HEIGHT);
    const last = Math.floor(scrollTop / ROW_HEIGHT) + visibleRows + OVERSCAN;
    return Math.min(flatRows.length, last);
  });

  /** Rows we render in the DOM — window slice plus the rename-target pin. */
  const windowRows = $derived.by<Array<{ row: FlatRow; index: number }>>(() => {
    const slice: Array<{ row: FlatRow; index: number }> = [];
    for (let i = startIdx; i < endIdx; i += 1) {
      slice.push({ row: flatRows[i]!, index: i });
    }
    // Pin the renaming row if it's outside the window — never destroy the
    // input while the user is typing.
    if (renamingPath) {
      const already = slice.some((s) => s.row.path === renamingPath);
      if (!already) {
        const ri = flatRows.findIndex((r) => r.path === renamingPath);
        if (ri !== -1) slice.push({ row: flatRows[ri]!, index: ri });
      }
    }
    return slice;
  });

  const topSpacer = $derived(startIdx * ROW_HEIGHT);
  const bottomSpacer = $derived(Math.max(0, (flatRows.length - endIdx) * ROW_HEIGHT));

  // ─── IPC loaders ───────────────────────────────────────────────────────────
  async function loadRoot() {
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
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

  async function loadFolder(folderAbsPath: string): Promise<DirEntry[] | null> {
    const existing = folders.get(folderAbsPath);
    if (existing?.loading) return existing.children ? [...existing.children] : null;
    setFolderState(folderAbsPath, {
      children: existing?.children,
      childrenLoaded: existing?.childrenLoaded ?? false,
      loading: true,
    });
    try {
      const raw = await listDirectory(folderAbsPath);
      setFolderState(folderAbsPath, {
        children: raw,
        childrenLoaded: true,
        loading: false,
      });
      return raw;
    } catch (e) {
      setFolderState(folderAbsPath, {
        children: existing?.children,
        childrenLoaded: existing?.childrenLoaded ?? false,
        loading: false,
      });
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
      return null;
    }
  }

  function setFolderState(path: string, next: FolderState) {
    // Assign a fresh Map so Svelte's reactivity picks up the change — Svelte 5
    // doesn't deeply track Map mutations.
    const m = new Map(folders);
    m.set(path, next);
    folders = m;
  }

  /** Re-fetch a folder whose children may have changed on disk. */
  async function refreshFolder(folderAbsPath: string) {
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    if (folderAbsPath === vaultPath || folderAbsPath === "") {
      await loadRoot();
      return;
    }
    await loadFolder(folderAbsPath);
  }

  // ─── Toggle expand / persist ───────────────────────────────────────────────
  async function onToggleExpand(row: FlatRow) {
    if (!row.isDir) return;
    const expanded = new Set(treeState.expanded);
    const willExpand = !expanded.has(row.relPath);
    if (willExpand) expanded.add(row.relPath);
    else expanded.delete(row.relPath);
    treeState = { ...treeState, expanded: Array.from(expanded) };
    void saveTreeState($vaultStore.currentPath ?? "", treeState);
    if (willExpand) {
      const existing = folders.get(row.path);
      if (!existing || !existing.childrenLoaded) {
        await loadFolder(row.path);
      }
    }
  }

  async function setExpanded(relPath: string, absPath: string, on: boolean) {
    const expanded = new Set(treeState.expanded);
    if (on) expanded.add(relPath);
    else expanded.delete(relPath);
    treeState = { ...treeState, expanded: Array.from(expanded) };
    // Fire-and-forget the persistence — it uses crypto.subtle.digest which
    // can hang several ticks; we don't want that delaying the user-visible
    // listDirectory that populates the expanded folder.
    void saveTreeState($vaultStore.currentPath ?? "", treeState);
    if (on) {
      const existing = folders.get(absPath);
      if (!existing || !existing.childrenLoaded) {
        await loadFolder(absPath);
      }
    }
  }

  // ─── Watcher handlers ──────────────────────────────────────────────────────
  let unlistenFileChange: UnlistenFn | null = null;
  let unlistenBulkStart: UnlistenFn | null = null;
  let unlistenBulkEnd: UnlistenFn | null = null;

  function handleFileChange(payload: FileChangePayload) {
    const { path, kind, new_path } = payload;
    if (kind === "create" || kind === "delete" || kind === "rename") {
      // Invalidate the entire tree cache — safest for arbitrary watcher events.
      invalidateAllFolders();
      void loadRoot();
      if (kind === "delete") tabStore.closeByPath(path);
      if (kind === "rename" && new_path) tabStore.updateFilePath(path, new_path);
    }
  }

  function invalidateAllFolders() {
    // Keep `expanded` state intact (persisted), but drop cached child lists so
    // folders re-fetch next time they're expanded / walked.
    folders = new Map();
  }

  function handleBulkStart(payload: BulkChangePayload) {
    bulkActive = true;
    bulkCount = payload.estimated_count;
    progressStore.start(payload.estimated_count);
  }

  function handleBulkEnd() {
    bulkActive = false;
    bulkCount = 0;
    progressStore.finish();
    invalidateAllFolders();
    void loadRoot();
  }

  // ─── Mount / destroy ───────────────────────────────────────────────────────
  let prevRefreshToken: string | null = null;
  let unsubTreeRefresh: (() => void) | null = null;
  let prevRevealToken: string | null = null;
  let unsubTreeReveal: (() => void) | null = null;

  let prevVaultPathSeen: string | null = null;
  let unsubVaultPathSidebar: (() => void) | null = null;

  function handleVaultStateChange(state: { currentPath: string | null }) {
    if (state.currentPath !== prevVaultPathSeen) {
      prevVaultPathSeen = state.currentPath;
      if (state.currentPath) {
        invalidateAllFolders();
        const cp = state.currentPath;
        void (async () => {
          try {
            const ts = await loadTreeState(cp);
            treeState = { ...ts };
          } catch {
            /* keep defaults */
          }
        })();
        void loadRoot();
        void tagsStore.reload();
        void bookmarksStore.load(state.currentPath);
      } else {
        bookmarksStore.reset();
      }
    }
  }

  onMount(async () => {
    // #253 — vault subscription must live inside onMount so that async
    // treeState assignments flow through Svelte 5's reactive graph (a
    // top-level-script subscription fires during component construction,
    // before the reactive root is fully wired, and mutations from its
    // async continuation never reach the `$derived` graph).
    unsubVaultPathSidebar = vaultStore.subscribe(handleVaultStateChange);

    unlistenFileChange = await listenFileChange(handleFileChange);
    unlistenBulkStart = await listenBulkChangeStart(handleBulkStart);
    unlistenBulkEnd = await listenBulkChangeEnd(handleBulkEnd);

    unsubTreeRefresh = treeRefreshStore.subscribe((state) => {
      if (state.token && state.token !== prevRefreshToken) {
        prevRefreshToken = state.token;
        invalidateAllFolders();
        void loadRoot();
        if ($vaultStore.currentPath) void tagsStore.reload();
      }
    });

    // #253 — single reveal-store subscription. Handles: expand ancestors →
    // wait for listDirectory → re-flatten → scroll target into view.
    unsubTreeReveal = treeRevealStore.subscribe((state) => {
      if (!state.pending) return;
      if (state.pending.token === prevRevealToken) return;
      prevRevealToken = state.pending.token;
      void performReveal(state.pending.relPath);
    });

    // Measure viewport height once mounted.
    measureViewport();
    if (typeof ResizeObserver !== "undefined" && scrollerEl) {
      const ro = new ResizeObserver(measureViewport);
      ro.observe(scrollerEl);
      onDestroyCallbacks.push(() => ro.disconnect());
    }
  });

  const onDestroyCallbacks: Array<() => void> = [];

  onDestroy(() => {
    unlistenFileChange?.();
    unlistenBulkStart?.();
    unlistenBulkEnd?.();
    unsubTreeRefresh?.();
    unsubTreeReveal?.();
    unsubVaultPathSidebar?.();
    onDestroyCallbacks.forEach((fn) => fn());
    tagsStore.reset();
  });

  function measureViewport() {
    if (scrollerEl) {
      viewportHeight = scrollerEl.clientHeight || viewportHeight;
    }
  }

  function onScroll(e: Event) {
    const el = e.currentTarget as HTMLDivElement;
    scrollTop = el.scrollTop;
  }

  // ─── Reveal pipeline ───────────────────────────────────────────────────────
  /**
   * Expand every ancestor folder of `relPath`, await each listDirectory, then
   * scroll the target row into view. Sequenced so the flat list has grown to
   * include the target before we try to scroll to it.
   */
  async function performReveal(relPath: string) {
    searchStore.setActiveTab("files");

    const vaultPath = $vaultStore.currentPath ?? "";
    if (!vaultPath) return;

    const ancestors = ancestorRelPaths(relPath);
    // Walk ancestors top-down so each subsequent listDirectory has its parent
    // already resolved.
    for (const ancestorRel of ancestors) {
      const ancestorAbs = vaultPath + "/" + ancestorRel;
      await setExpanded(ancestorRel, ancestorAbs, true);
    }

    // Recompute the flat list after the DOM has caught up with the new state.
    await tick();

    // Find the target row and scroll it into view. If the target is outside
    // the current window, bring it in first so the virtualized renderer
    // mounts its row element before we call scrollIntoView.
    const targetAbs = relPath.length > 0 ? vaultPath + "/" + relPath : vaultPath;
    const idx = flatRows.findIndex((r) => r.path === targetAbs);
    if (idx === -1) {
      // Target path isn't in the flat list (maybe points at a .md file under
      // an ancestor whose listDirectory hasn't landed yet). Best-effort: no
      // scroll — the caller can re-dispatch after the user's next keystroke.
      return;
    }
    if (scrollerEl) {
      // Place the target ~1/3 down the viewport so it's visibly centered.
      const targetTop = idx * ROW_HEIGHT;
      const vh = scrollerEl.clientHeight || viewportHeight;
      const desiredTop = Math.max(0, targetTop - vh / 3);
      if (targetTop < scrollerEl.scrollTop || targetTop > scrollerEl.scrollTop + vh - ROW_HEIGHT) {
        scrollerEl.scrollTop = desiredTop;
        scrollTop = desiredTop;
        await tick();
      }
    }
    // Find the row element (it now must exist in the DOM window) and
    // scroll-into-view — matches the old TreeNode behaviour. Try now, and
    // again on the next frame in case the flat renderer hasn't mounted the
    // row yet (the window-slice update is reactive but pixel-level scroll
    // happens after the next paint).
    const scrollTarget = () => {
      const el = scrollerEl?.querySelector<HTMLElement>(
        `[data-tree-row="${cssEscape(targetAbs)}"]`,
      );
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    scrollTarget();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(scrollTarget);
    }
  }

  function cssEscape(value: string): string {
    // Lightweight CSS escape — we only need to guard quotes/backslashes/newlines.
    // (CSS.escape is not reliably available in the Tauri webview.)
    return value.replace(/["\\\n\r]/g, (c) => "\\" + c);
  }

  // ─── Row callbacks ─────────────────────────────────────────────────────────
  function onRenameStateChange(path: string, renaming: boolean) {
    renamingPath = renaming ? path : renamingPath === path ? null : renamingPath;
  }

  function handlePathChanged(oldPath: string, newPath: string) {
    tabStore.updateFilePath(oldPath, newPath);
    // Invalidate the containing folder — a rename may have reordered entries.
    const parent = parentOf(oldPath);
    if (parent) void refreshFolder(parent);
    else void loadRoot();
  }

  function parentOf(absPath: string): string | null {
    const i = absPath.lastIndexOf("/");
    if (i <= 0) return null;
    return absPath.slice(0, i);
  }

  // ─── Header actions ────────────────────────────────────────────────────────
  async function handleNewFile() {
    newMenuOpen = false;
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    const targetFolder = getSelectedFolder() ?? vaultPath;
    try {
      await createFile(targetFolder, "");
      if (targetFolder === vaultPath) await loadRoot();
      else await refreshFolder(targetFolder);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleNewCanvas() {
    newMenuOpen = false;
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    const targetFolder = getSelectedFolder() ?? vaultPath;
    try {
      const newPath = await createFile(targetFolder, "Untitled.canvas");
      await writeFile(newPath, serializeCanvas(emptyCanvas()));
      if (targetFolder === vaultPath) await loadRoot();
      else await refreshFolder(targetFolder);
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
      if (targetFolder === vaultPath) await loadRoot();
      else await refreshFolder(targetFolder);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  function getSelectedFolder(): string | null {
    if (!selectedPath) return null;
    const entry = rootEntries.find((e) => e.path === selectedPath);
    if (entry?.is_dir) return selectedPath;
    return null;
  }

  const vaultName = $derived(
    $vaultStore.currentPath
      ? $vaultStore.currentPath.split("/").pop() ?? $vaultStore.currentPath
      : "No vault",
  );
</script>

<aside class="vc-sidebar" data-testid="sidebar">
  <div class="vc-sidebar-tabs" role="tablist">
    <button
      class="vc-sidebar-tab"
      role="tab"
      aria-selected={$searchStore.activeTab === 'files'}
      onclick={() => searchStore.setActiveTab('files')}
    >Dateien</button>
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

  {#if $searchStore.activeTab === 'tags'}
    <div class="vc-sidebar-tabpanel" role="tabpanel">
      <TagsPanel {onOpenContentSearch} />
    </div>
  {:else}
  <header class="vc-sidebar-header">
    {#if bulkActive}
      <div class="vc-sidebar-bulk-progress">
        <span class="vc-sidebar-bulk-label">Scanning changes...</span>
        <span class="vc-sidebar-bulk-count">{bulkCount.toLocaleString()} files</span>
      </div>
    {:else}
      <button
        type="button"
        class="vc-sidebar-vaultname"
        title={`Open home (${$vaultStore.currentPath ?? ""})`}
        onclick={() => { void openHomeCanvas(); }}
        data-testid="sidebar-vaultname-home"
      >
        {vaultName}
      </button>
      <div class="vc-sidebar-actions" style="position: relative;">
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
        <button
          class="vc-sidebar-action-btn"
          onclick={() => { void openDocsPage(); }}
          aria-label="Open docs"
          title="Open documentation (Cmd/Ctrl+Shift+/)"
          data-testid="sidebar-open-docs"
        >
          <BookOpen size={16} strokeWidth={1.5} />
        </button>
      </div>
    {/if}
  </header>

  <BookmarksPanel />

  <!-- Tree area (virtualized) -->
  <div
    class="vc-sidebar-tree"
    role="tree"
    aria-label="Vault file tree"
    bind:this={scrollerEl}
    onscroll={onScroll}
  >
    {#if loading}
      <p class="vc-sidebar-status">Loading...</p>
    {:else if loadError}
      <p class="vc-sidebar-status vc-sidebar-status--error">{loadError}</p>
    {:else if flatRows.length === 0}
      <p class="vc-sidebar-status">No files in vault.</p>
    {:else}
      <ul
        class="vc-tree-root"
        role="group"
        style="padding-top: {topSpacer}px; padding-bottom: {bottomSpacer}px;"
      >
        {#each windowRows as { row, index } (row.path)}
          <TreeRow
            {row}
            {selectedPath}
            {onSelect}
            {onOpenFile}
            onToggleExpand={(r) => onToggleExpand(r)}
            onRefreshFolder={refreshFolder}
            onPathChanged={handlePathChanged}
            {onRenameStateChange}
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
    background: none;
    border: none;
    padding: 4px 6px;
    margin-left: -6px;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
    font-family: inherit;
  }

  .vc-sidebar-vaultname:hover {
    background: var(--color-bg);
  }

  .vc-sidebar-vaultname:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
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
    --vc-tree-row-height: 28px;
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
