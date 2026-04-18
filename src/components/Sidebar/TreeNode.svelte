<script lang="ts">
  import { ChevronRight, Folder, FolderOpen, FileText, File, MoreHorizontal, Star } from "lucide-svelte";
  import { listDirectory, createFile, createFolder, deleteFile, moveFile, updateLinksAfterRename, getBacklinks, writeFile } from "../../ipc/commands";
  import { serializeCanvas, emptyCanvas } from "../../lib/canvas/parse";
  import { toastStore } from "../../store/toastStore";
  import type { RenameResult } from "../../types/links";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import type { DirEntry } from "../../types/tree";
  import InlineRename from "./InlineRename.svelte";
  import ContextMenu from "../common/ContextMenu.svelte";
  import TreeNode from "./TreeNode.svelte";
  import { vaultStore } from "../../store/vaultStore";
  import { tabReloadStore } from "../../store/tabReloadStore";
  import { tabStore } from "../../store/tabStore";
  import { treeRevealStore } from "../../store/treeRevealStore";
  import { bookmarksStore } from "../../store/bookmarksStore";
  import { sortEntries, type SortBy } from "../../lib/treeState";
  import { onMount, onDestroy, untrack } from "svelte";

  interface Props {
    entry: DirEntry;
    depth: number;
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onOpenFile: (path: string) => void;
    onRefreshParent: () => void;
    onPathChanged: (oldPath: string, newPath: string) => void;
    onExpandToggle?: ((relPath: string, isExpanded: boolean) => void) | undefined;
    initiallyExpanded?: boolean;
    /** Vault-relative folder paths persisted as expanded — propagated through
     *  the recursive tree so deeply nested descendants can restore their
     *  open/closed state on mount instead of always starting collapsed. */
    expandedPaths?: readonly string[];
    sortBy?: SortBy;
  }

  let {
    entry,
    depth,
    selectedPath,
    onSelect,
    onOpenFile,
    onRefreshParent,
    onPathChanged,
    onExpandToggle,
    initiallyExpanded = false,
    expandedPaths = [],
    sortBy = "name",
  }: Props = $props();

  // `initiallyExpanded` is a one-shot seed: the prop reflects the persisted
  // tree state at mount time, but local expand/collapse is driven by the
  // user (see `toggleExpand`) and must not be overwritten when the prop
  // changes. `untrack` makes that intent explicit and silences Svelte 5's
  // `state_referenced_locally` warning.
  let expanded = $state(untrack(() => initiallyExpanded));
  let children = $state<DirEntry[]>([]);
  let childrenLoaded = $state(false);
  let loading = $state(false);

  // Rename/inline edit state
  let renaming = $state(false);
  let isNewFile = $state(false);

  // Context menu state. Anchored at the cursor point when opened via
  // right-click, and at the three-dots button's bounding rect when opened
  // via click. Shared ContextMenu handles overflow-flip + ESC.
  let showContextMenu = $state(false);
  let menuPos = $state<{ x: number; y: number }>({ x: 0, y: 0 });

  // Delete confirmation state
  let showDeleteConfirm = $state(false);

  // Drag-drop state
  let isDragSource = $state(false);
  let isDragTarget = $state(false);

  // Wiki-link rename confirmation
  // newPath: absolute path after rename (InlineRename already executed renameFile)
  // oldRelPath: vault-relative old path (for updateLinksAfterRename)
  // newRelPath: vault-relative new path (for updateLinksAfterRename)
  // linkCount: total number of wiki-links pointing to the file
  // fileCount: number of unique source files with links
  let pendingRename = $state<{
    newPath: string;
    oldRelPath: string;
    newRelPath: string;
    linkCount: number;
    fileCount: number;
  } | null>(null);

  // Move confirmation state (drag-drop, D-11)
  let pendingMove = $state<{
    sourcePath: string;
    targetDirPath: string;
    sourceRelPath: string;
    newRelPath: string;
    linkCount: number;
    fileCount: number;
  } | null>(null);

  const isActive = $derived(selectedPath === entry.path);

  // Bookmark state for this entry (#12). Files only — folders aren't
  // bookmarkable in the MVP.
  const entryRelPath = $derived(relPathOf(entry.path));
  const isBookmarked = $derived(
    !entry.is_dir && entryRelPath !== null && $bookmarksStore.paths.includes(entryRelPath)
  );

  function relPathOf(absPath: string): string | null {
    const vault = getVaultRoot();
    if (!vault) return null;
    return toRelPath(absPath, vault);
  }

  async function toggleBookmark() {
    closeContextMenu();
    const vault = getVaultRoot();
    if (!vault || entry.is_dir) return;
    const rel = toRelPath(entry.path, vault);
    await bookmarksStore.toggle(rel, vault);
  }

  // DOM ref for scroll-into-view on reveal requests.
  let rowEl = $state<HTMLDivElement | undefined>();

  // Auto-load children if this node starts expanded (restored from persisted state, FILE-07)
  onMount(() => {
    if (initiallyExpanded && entry.is_dir && !childrenLoaded) {
      void loadChildren();
    }
  });

  // ─── Reveal-in-tree support ────────────────────────────────────────────────
  // Subscribe to treeRevealStore. When a request lands we either:
  //   - scroll our row into view (our rel path matches exactly), or
  //   - auto-expand + load children (our rel path is an ancestor of the target),
  // so the descendant row becomes visible in the DOM before it too scrolls into view.
  let prevRevealToken: string | null = null;
  const unsubTreeReveal = treeRevealStore.subscribe((state) => {
    if (!state.pending) return;
    if (state.pending.token === prevRevealToken) return;
    prevRevealToken = state.pending.token;

    const vault = getVaultRoot();
    if (!vault) return;
    const myRel = toRelPath(entry.path, vault);
    const target = state.pending.relPath;
    if (!myRel || !target) return;

    if (myRel === target) {
      // Exact match — scroll our row into view (AC-03). Defer so any
      // ancestor-triggered expansion has landed in the DOM first.
      requestAnimationFrame(() => {
        rowEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      return;
    }

    // Ancestor match — expand ourselves so the descendant becomes renderable.
    if (entry.is_dir && (target === myRel + "/" || target.startsWith(myRel + "/"))) {
      if (!expanded) {
        expanded = true;
        if (!childrenLoaded) void loadChildren();
      }
    }
  });

  onDestroy(() => {
    unsubTreeReveal();
  });

  async function loadChildren() {
    if (loading) return;
    loading = true;
    try {
      const raw = await listDirectory(entry.path);
      children = sortEntries(raw, sortBy);
      childrenLoaded = true;
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    } finally {
      loading = false;
    }
  }

  async function toggleExpand() {
    if (!entry.is_dir) return;
    expanded = !expanded;
    if (expanded && !childrenLoaded) {
      await loadChildren();
    }
    // Notify Sidebar to persist expand state (FILE-07)
    const vault = getVaultRoot();
    const relPath = vault ? toRelPath(entry.path, vault) : entry.path;
    onExpandToggle?.(relPath, expanded);
  }

  function handleClick() {
    onSelect(entry.path);
    if (entry.is_dir) {
      void toggleExpand();
    } else {
      // #49: open any non-folder entry. The tab classifier inside EditorPane
      // / onOpenFile decides whether to render it as markdown, image,
      // read-only text, or an unsupported-file placeholder.
      onOpenFile(entry.path);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      handleClick();
    }
  }

  // Context menu
  function openContextMenu(e: MouseEvent) {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    menuPos = { x: rect.left, y: rect.bottom };
    showContextMenu = true;
  }

  // Issue #47: right-click handler on the row. Suppresses the webview default
  // menu and anchors our menu at the cursor position.
  function handleRowContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    menuPos = { x: e.clientX, y: e.clientY };
    showContextMenu = true;
  }

  function closeContextMenu() {
    showContextMenu = false;
  }

  function startRename() {
    closeContextMenu();
    renaming = true;
    isNewFile = false;
  }

  function handleOpenInSplit() {
    closeContextMenu();
    tabStore.openTab(entry.path);
    tabStore.moveToPane("right");
  }

  function getVaultRoot(): string | null {
    let v: string | null = null;
    const u = vaultStore.subscribe((s) => { v = s.currentPath; });
    u();
    return v;
  }

  function toRelPath(absPath: string, vaultRoot: string): string {
    return absPath.startsWith(vaultRoot + "/")
      ? absPath.slice(vaultRoot.length + 1)
      : absPath;
  }

  async function handleRenameConfirm(newPath: string, linkCount: number) {
    renaming = false;
    const vault = getVaultRoot();
    const oldRelPath = vault ? toRelPath(entry.path, vault) : entry.path;
    const newRelPath = vault ? toRelPath(newPath, vault) : newPath;
    // Rename tracking for bookmarks (#12): update any matching bookmark entry.
    if (vault) {
      void bookmarksStore.renamePath(oldRelPath, newRelPath, vault);
    }
    if (linkCount > 0) {
      // Get unique source file count for the dialog copy
      let fileCount = 1;
      try {
        const backlinks = await getBacklinks(oldRelPath);
        fileCount = new Set(backlinks.map((b) => b.sourcePath)).size || 1;
      } catch { /* fallback to 1 */ }
      pendingRename = { newPath, oldRelPath, newRelPath, linkCount, fileCount };
    } else {
      onPathChanged(entry.path, newPath);
      onRefreshParent();
    }
  }

  function handleRenameCancel() {
    renaming = false;
  }

  async function confirmRenameWithLinks() {
    if (!pendingRename) return;
    const { newPath, oldRelPath, newRelPath } = pendingRename;
    pendingRename = null;
    onPathChanged(entry.path, newPath);
    onRefreshParent();
    try {
      const result = await updateLinksAfterRename(oldRelPath, newRelPath);
      // Reload any open tabs whose content was rewritten — the cascade writes
      // through write_ignore so the watcher/editor never learns about them.
      if (result.updatedPaths.length > 0) {
        tabReloadStore.request(result.updatedPaths);
      }
      if (result.failedFiles.length > 0) {
        const total = result.updatedLinks + result.failedFiles.length;
        toastStore.push({
          variant: "error",
          message: `${result.updatedLinks} von ${total} Links aktualisiert. ${result.failedFiles.length} Dateien konnten nicht geändert werden.`,
        });
      }
    } catch {
      toastStore.push({
        variant: "error",
        message: "Links konnten nicht aktualisiert werden.",
      });
    }
  }

  function cancelRenameWithLinks() {
    pendingRename = null;
  }

  function openDeleteConfirm() {
    closeContextMenu();
    showDeleteConfirm = true;
  }

  async function confirmDelete() {
    showDeleteConfirm = false;
    try {
      await deleteFile(entry.path);
      onRefreshParent();
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  function cancelDelete() {
    showDeleteConfirm = false;
  }

  /**
   * Persist this folder as expanded in the Sidebar's TreeState so later
   * re-mounts (e.g. triggered by a tree refresh) start expanded too.
   */
  function persistExpanded() {
    if (!entry.is_dir) return;
    const vault = getVaultRoot();
    const rel = vault ? toRelPath(entry.path, vault) : entry.path;
    onExpandToggle?.(rel, true);
  }

  async function handleNewFileHere() {
    closeContextMenu();
    try {
      const newPath = await createFile(entry.path, "");
      // Issue #50: keep the containing folder expanded after a create.
      // The assignments are intentional even when `expanded` was already
      // true — a simultaneous watcher-driven tree refresh can otherwise
      // race with the local state flip. Persist the expanded flag so a
      // full re-mount of this subtree restores it.
      expanded = true;
      persistExpanded();
      await loadChildren();
      expanded = true;
      // Open the new note so the active-tab reveal hook (VaultLayout)
      // selects it in the tree automatically.
      tabStore.openTab(newPath);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleNewCanvasHere() {
    closeContextMenu();
    try {
      const newPath = await createFile(entry.path, "Untitled.canvas");
      // Seed the file with an empty canvas doc so Obsidian recognizes the
      // format immediately — an empty string would otherwise parse to a
      // blank doc but fail Obsidian's schema validation on first open.
      await writeFile(newPath, serializeCanvas(emptyCanvas()));
      expanded = true;
      persistExpanded();
      await loadChildren();
      expanded = true;
      tabStore.openFileTab(newPath, "canvas");
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleNewFolderHere() {
    closeContextMenu();
    try {
      await createFolder(entry.path, "");
      // Issue #50: same expanded-state protection as handleNewFileHere.
      expanded = true;
      persistExpanded();
      await loadChildren();
      expanded = true;
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  // Drag-and-drop (FILE-05 / D-17)
  // #146: files use `text/vaultcore-file`, directories use `text/vaultcore-folder`
  // so the editor pane can accept file drops for split-view while rejecting folders.
  function handleDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    const mime = entry.is_dir ? "text/vaultcore-folder" : "text/vaultcore-file";
    e.dataTransfer.setData(mime, entry.path);
    e.dataTransfer.effectAllowed = "move";
    isDragSource = true;
  }

  function handleDragEnd() {
    isDragSource = false;
  }

  function isSidebarDrag(types: readonly string[]): boolean {
    return types.includes("text/vaultcore-file") || types.includes("text/vaultcore-folder");
  }

  function handleDragOver(e: DragEvent) {
    if (!entry.is_dir) return;
    if (!e.dataTransfer || !isSidebarDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    isDragTarget = true;
  }

  function handleDragLeave() {
    isDragTarget = false;
  }

  async function handleDrop(e: DragEvent) {
    isDragTarget = false;
    if (!entry.is_dir) return;
    if (!e.dataTransfer || !isSidebarDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    const sourcePath =
      e.dataTransfer.getData("text/vaultcore-file") ||
      e.dataTransfer.getData("text/vaultcore-folder");
    if (!sourcePath || sourcePath === entry.path) return;

    // D-11: check backlinks before move and prompt cascade confirmation
    const vault = getVaultRoot();
    const sourceRelPath = vault ? toRelPath(sourcePath, vault) : sourcePath;
    const sourceFilename = sourcePath.split("/").pop() ?? sourcePath;
    const newAbsPath = entry.path + "/" + sourceFilename;
    const newRelPath = vault ? toRelPath(newAbsPath, vault) : newAbsPath;

    let linkCount = 0;
    let fileCount = 0;
    try {
      const backlinks = await getBacklinks(sourceRelPath);
      linkCount = backlinks.length;
      fileCount = new Set(backlinks.map((b) => b.sourcePath)).size;
    } catch { /* proceed without cascade */ }

    if (linkCount > 0) {
      // Show confirmation dialog for move cascade
      pendingMove = { sourcePath, targetDirPath: entry.path, sourceRelPath, newRelPath, linkCount, fileCount };
      return;
    }

    // No backlinks — proceed directly
    try {
      await moveFile(sourcePath, entry.path);
      // Update bookmark in-place if the moved file was bookmarked (#12).
      if (vault) {
        void bookmarksStore.renamePath(sourceRelPath, newRelPath, vault);
      }
      await loadChildren();
      onRefreshParent();
    } catch (err) {
      const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function confirmMoveWithLinks() {
    if (!pendingMove) return;
    const { sourcePath, targetDirPath, sourceRelPath, newRelPath } = pendingMove;
    pendingMove = null;
    try {
      await moveFile(sourcePath, targetDirPath);
      // Update bookmark in-place if the moved file was bookmarked (#12).
      const vaultForBookmarks = getVaultRoot();
      if (vaultForBookmarks) {
        void bookmarksStore.renamePath(sourceRelPath, newRelPath, vaultForBookmarks);
      }
      await loadChildren();
      onRefreshParent();
      const result = await updateLinksAfterRename(sourceRelPath, newRelPath);
      // Reload open tabs for rewritten source files (see confirmRenameWithLinks).
      if (result.updatedPaths.length > 0) {
        tabReloadStore.request(result.updatedPaths);
      }
      if (result.failedFiles.length > 0) {
        const total = result.updatedLinks + result.failedFiles.length;
        toastStore.push({
          variant: "error",
          message: `${result.updatedLinks} von ${total} Links aktualisiert. ${result.failedFiles.length} Dateien konnten nicht geändert werden.`,
        });
      }
    } catch (err) {
      const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  function cancelMoveWithLinks() {
    pendingMove = null;
  }

  async function refreshChildren() {
    if (childrenLoaded) {
      await loadChildren();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<li
  role="treeitem"
  aria-expanded={entry.is_dir ? expanded : undefined}
  aria-selected={isActive}
  tabindex="0"
  class="vc-tree-node"
  class:vc-tree-node--active={isActive}
  class:vc-tree-node--drag-source={isDragSource}
  class:vc-tree-node--drag-target={isDragTarget}
  draggable={!renaming}
  ondragstart={handleDragStart}
  ondragend={handleDragEnd}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  onkeydown={handleKeydown}
>
  <!-- Row -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-tree-row"
    style="padding-left: calc({depth} * 16px + 8px)"
    bind:this={rowEl}
    onclick={handleClick}
    oncontextmenu={handleRowContextMenu}
    role="button"
    tabindex="-1"
    title={entry.path}
  >
    <!-- Chevron / spacer -->
    {#if entry.is_dir}
      <button
        class="vc-tree-chevron"
        class:vc-tree-chevron--expanded={expanded}
        onclick={(e) => { e.stopPropagation(); void toggleExpand(); }}
        aria-label={expanded ? "Collapse" : "Expand"}
        tabindex="-1"
      >
        <ChevronRight size={16} strokeWidth={1.5} />
      </button>
    {:else}
      <span class="vc-tree-spacer" aria-hidden="true"></span>
    {/if}

    <!-- File/Folder icon -->
    <span class="vc-tree-icon" class:vc-tree-icon--active={isActive} aria-hidden="true">
      {#if entry.is_dir}
        {#if expanded}
          <FolderOpen size={16} strokeWidth={1.5} />
        {:else}
          <Folder size={16} strokeWidth={1.5} />
        {/if}
      {:else if entry.is_md}
        <FileText size={16} strokeWidth={1.5} />
      {:else}
        <File size={16} strokeWidth={1.5} />
      {/if}
    </span>

    <!-- Filename / inline rename -->
    {#if renaming}
      <InlineRename
        currentName={entry.name}
        oldPath={entry.path}
        {isNewFile}
        onConfirm={handleRenameConfirm}
        onCancel={handleRenameCancel}
      />
    {:else}
      <span class="vc-tree-name">
        {entry.name}
        {#if entry.is_symlink}
          <em class="vc-tree-symlink">(link)</em>
        {/if}
      </span>
      {#if isBookmarked}
        <span class="vc-tree-bookmark" aria-label="Bookmarked" title="Bookmark">
          <Star size={12} strokeWidth={1.5} />
        </span>
      {/if}
    {/if}

    <!-- More options button (hover-visible) -->
    {#if !renaming}
      <button
        class="vc-tree-more"
        onclick={openContextMenu}
        aria-label="More options for {entry.name}"
        tabindex="-1"
      >
        <MoreHorizontal size={16} strokeWidth={1.5} />
      </button>
    {/if}
  </div>

  <!-- Context menu -->
  <ContextMenu open={showContextMenu} x={menuPos.x} y={menuPos.y} onClose={closeContextMenu}>
    {#if !entry.is_dir}
      <button class="vc-context-item" onclick={handleOpenInSplit}>Open in split</button>
    {/if}
    <button class="vc-context-item" onclick={startRename}>Rename</button>
    {#if !entry.is_dir}
      <button class="vc-context-item" onclick={() => void toggleBookmark()}>
        {isBookmarked ? "Remove bookmark" : "Bookmark"}
      </button>
    {/if}
    <button class="vc-context-item vc-context-item--danger" onclick={openDeleteConfirm}>Move to Trash</button>
    {#if entry.is_dir}
      <button class="vc-context-item" onclick={handleNewFileHere}>New file here</button>
      <button class="vc-context-item" onclick={handleNewCanvasHere}>New canvas here</button>
      <button class="vc-context-item" onclick={handleNewFolderHere}>New folder here</button>
    {/if}
  </ContextMenu>

  <!-- Delete confirmation dialog -->
  {#if showDeleteConfirm}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="vc-confirm-overlay"
      onclick={cancelDelete}
      role="presentation"
    ></div>
    <div class="vc-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-heading">
      <h2 id="delete-heading" class="vc-confirm-heading">Move to Trash?</h2>
      <p class="vc-confirm-body">
        "{entry.name}" will be moved to .trash/ and can be recovered from there.
      </p>
      <div class="vc-confirm-actions">
        <button class="vc-confirm-btn vc-confirm-btn--cancel" onclick={cancelDelete}>Keep File</button>
        <button class="vc-confirm-btn vc-confirm-btn--danger" onclick={confirmDelete}>Move to Trash</button>
      </div>
    </div>
  {/if}

  <!-- Rename with wiki-links confirmation (German copy per D-09) -->
  {#if pendingRename}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="vc-confirm-overlay"
      onclick={cancelRenameWithLinks}
      role="presentation"
    ></div>
    <div class="vc-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-heading">
      <h2 id="rename-heading" class="vc-confirm-heading">Links aktualisieren?</h2>
      <p class="vc-confirm-body">
        {pendingRename.linkCount} Links in {pendingRename.fileCount} Dateien werden aktualisiert. Fortfahren?
      </p>
      <div class="vc-confirm-actions">
        <button class="vc-confirm-btn vc-confirm-btn--cancel" onclick={cancelRenameWithLinks}>Abbrechen</button>
        <button class="vc-confirm-btn vc-confirm-btn--accent" onclick={() => void confirmRenameWithLinks()}>Aktualisieren</button>
      </div>
    </div>
  {/if}

  <!-- Move with wiki-links confirmation (D-11) -->
  {#if pendingMove}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="vc-confirm-overlay"
      onclick={cancelMoveWithLinks}
      role="presentation"
    ></div>
    <div class="vc-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="move-heading">
      <h2 id="move-heading" class="vc-confirm-heading">Links aktualisieren?</h2>
      <p class="vc-confirm-body">
        {pendingMove.linkCount} Links in {pendingMove.fileCount} Dateien werden aktualisiert. Fortfahren?
      </p>
      <div class="vc-confirm-actions">
        <button class="vc-confirm-btn vc-confirm-btn--cancel" onclick={cancelMoveWithLinks}>Abbrechen</button>
        <button class="vc-confirm-btn vc-confirm-btn--accent" onclick={() => void confirmMoveWithLinks()}>Aktualisieren</button>
      </div>
    </div>
  {/if}

  <!-- Children (expanded subtree) -->
  {#if entry.is_dir && expanded && childrenLoaded}
    <ul class="vc-tree-children" role="group">
      {#each children as child (child.path)}
        <TreeNode
          entry={child}
          depth={depth + 1}
          {selectedPath}
          {onSelect}
          {onOpenFile}
          onRefreshParent={refreshChildren}
          {onPathChanged}
          {onExpandToggle}
          initiallyExpanded={(() => {
            const vault = getVaultRoot();
            if (!vault) return false;
            const rel = toRelPath(child.path, vault);
            return child.is_dir && rel !== null && expandedPaths.includes(rel);
          })()}
          {expandedPaths}
          {sortBy}
        />
      {/each}
      {#if children.length === 0}
        <li class="vc-tree-empty" role="none">Empty folder</li>
      {/if}
    </ul>
  {/if}
</li>

<style>
  .vc-tree-node {
    list-style: none;
    position: relative;
  }

  .vc-tree-node:focus {
    outline: none;
  }

  .vc-tree-node:focus-visible > .vc-tree-row {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .vc-tree-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 24px;
    padding-top: 2px;
    padding-bottom: 2px;
    padding-right: 8px;
    cursor: pointer;
    position: relative;
    user-select: none;
  }

  .vc-tree-row:hover {
    background: var(--color-accent-bg);
  }

  .vc-tree-node--active > .vc-tree-row {
    background: var(--color-accent-bg);
    border-left: 2px solid var(--color-accent);
    font-weight: 700;
  }

  .vc-tree-node--drag-source > .vc-tree-row {
    opacity: 0.5;
  }

  .vc-tree-node--drag-target > .vc-tree-row {
    border: 1px dashed var(--color-accent);
    background: var(--color-accent-bg);
  }

  .vc-tree-chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    padding: 0;
    transition: transform 150ms ease;
  }

  .vc-tree-chevron--expanded {
    transform: rotate(90deg);
  }

  .vc-tree-spacer {
    display: inline-block;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .vc-tree-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--color-text-muted);
  }

  .vc-tree-icon--active {
    color: var(--color-accent);
  }

  .vc-tree-name {
    flex: 1;
    font-size: 14px;
    font-weight: 400;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vc-tree-symlink {
    font-style: italic;
    font-size: 12px;
    color: var(--color-text-muted);
    margin-left: 4px;
  }

  .vc-tree-bookmark {
    display: inline-flex;
    align-items: center;
    margin-left: 4px;
    color: var(--color-accent);
    flex-shrink: 0;
  }

  .vc-tree-more {
    display: none;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    padding: 0;
    flex-shrink: 0;
    border-radius: 3px;
  }

  .vc-tree-row:hover .vc-tree-more {
    display: flex;
  }

  .vc-tree-more:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-tree-children {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .vc-tree-empty {
    font-size: 12px;
    color: var(--color-text-muted);
    padding: 4px 8px 4px 32px;
    font-style: italic;
  }

  /* Confirmation dialog */
  .vc-confirm-overlay {
    position: fixed;
    inset: 0;
    z-index: 199;
    background: rgba(0, 0, 0, 0.1);
  }

  .vc-confirm-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 200;
    width: 280px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
    padding: 16px;
  }

  .vc-confirm-heading {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 8px 0;
    color: var(--color-text);
  }

  .vc-confirm-body {
    font-size: 14px;
    color: var(--color-text);
    margin: 0 0 16px 0;
    line-height: 1.5;
  }

  .vc-confirm-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .vc-confirm-btn {
    padding: 6px 14px;
    font-size: 14px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    cursor: pointer;
    background: var(--color-surface);
    color: var(--color-text);
  }

  .vc-confirm-btn:hover {
    background: var(--color-accent-bg);
  }

  .vc-confirm-btn--cancel {
    background: var(--color-surface);
  }

  .vc-confirm-btn--danger {
    background: var(--color-error);
    color: #fff;
    border-color: var(--color-error);
  }

  .vc-confirm-btn--danger:hover {
    opacity: 0.9;
  }

  .vc-confirm-btn--accent {
    min-width: 80px;
    padding: 4px 8px;
    border: 1px solid var(--color-accent);
    color: var(--color-accent);
    background: transparent;
  }

  .vc-confirm-btn--accent:hover {
    background: var(--color-accent-bg);
  }
</style>
