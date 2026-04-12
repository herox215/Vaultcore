<script lang="ts">
  import { ChevronRight, Folder, FolderOpen, FileText, File, MoreHorizontal } from "lucide-svelte";
  import { listDirectory, createFile, createFolder, deleteFile, moveFile } from "../../ipc/commands";
  import { toastStore } from "../../store/toastStore";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import type { DirEntry } from "../../types/tree";
  import InlineRename from "./InlineRename.svelte";

  interface Props {
    entry: DirEntry;
    depth: number;
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onOpenFile: (path: string) => void;
    onRefreshParent: () => void;
    onPathChanged: (oldPath: string, newPath: string) => void;
  }

  let {
    entry,
    depth,
    selectedPath,
    onSelect,
    onOpenFile,
    onRefreshParent,
    onPathChanged,
  }: Props = $props();

  let expanded = $state(false);
  let children = $state<DirEntry[]>([]);
  let childrenLoaded = $state(false);
  let loading = $state(false);

  // Rename/inline edit state
  let renaming = $state(false);
  let isNewEntry = $state(false);

  // Context menu state
  let showContextMenu = $state(false);
  let contextMenuRef: HTMLDivElement | null = null;

  // Delete confirmation state
  let showDeleteConfirm = $state(false);

  // Drag-drop state
  let isDragSource = $state(false);
  let isDragTarget = $state(false);

  // Wiki-link rename confirmation
  let pendingRename = $state<{ newPath: string; linkCount: number } | null>(null);

  const isActive = $derived(selectedPath === entry.path);

  async function loadChildren() {
    if (loading) return;
    loading = true;
    try {
      children = await listDirectory(entry.path);
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
  }

  function handleClick() {
    onSelect(entry.path);
    if (entry.is_dir) {
      void toggleExpand();
    } else if (entry.is_md) {
      onOpenFile(entry.path);
    } else {
      toastStore.push({
        variant: "error",
        message: "Cannot open this file. It contains non-UTF-8 characters.",
      });
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
    showContextMenu = true;
  }

  function closeContextMenu() {
    showContextMenu = false;
  }

  function startRename() {
    closeContextMenu();
    renaming = true;
    isNewEntry = false;
  }

  function handleRenameConfirm(newPath: string, linkCount: number) {
    renaming = false;
    if (linkCount > 0) {
      pendingRename = { newPath, linkCount };
    } else {
      onPathChanged(entry.path, newPath);
      onRefreshParent();
    }
  }

  function handleRenameCancel() {
    renaming = false;
  }

  function confirmRenameWithLinks() {
    if (pendingRename) {
      onPathChanged(entry.path, pendingRename.newPath);
      onRefreshParent();
      pendingRename = null;
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

  async function handleNewFileHere() {
    closeContextMenu();
    try {
      const newPath = await createFile(entry.path, "");
      if (!expanded) {
        expanded = true;
        await loadChildren();
      } else {
        await loadChildren();
      }
      // Find the newly created entry and trigger inline rename
      const newEntry = children.find((c) => c.path === newPath);
      if (newEntry) {
        // Trigger rename on the new entry — handled via child component
        // The child will receive isNewFile=true
      }
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleNewFolderHere() {
    closeContextMenu();
    try {
      await createFolder(entry.path, "");
      if (!expanded) {
        expanded = true;
        await loadChildren();
      } else {
        await loadChildren();
      }
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  // Drag-and-drop (FILE-05 / D-17)
  function handleDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData("text/vaultcore-file", entry.path);
    e.dataTransfer.effectAllowed = "move";
    isDragSource = true;
  }

  function handleDragEnd() {
    isDragSource = false;
  }

  function handleDragOver(e: DragEvent) {
    if (!entry.is_dir) return;
    if (!e.dataTransfer?.types.includes("text/vaultcore-file")) return;
    e.preventDefault();
    isDragTarget = true;
  }

  function handleDragLeave() {
    isDragTarget = false;
  }

  async function handleDrop(e: DragEvent) {
    isDragTarget = false;
    if (!entry.is_dir) return;
    if (!e.dataTransfer?.types.includes("text/vaultcore-file")) return;
    e.preventDefault();
    const sourcePath = e.dataTransfer.getData("text/vaultcore-file");
    if (!sourcePath || sourcePath === entry.path) return;
    try {
      await moveFile(sourcePath, entry.path);
      // Refresh this folder's children
      await loadChildren();
      onRefreshParent();
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
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
    onclick={handleClick}
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
        {isNewEntry}
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
  {#if showContextMenu}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="vc-context-overlay"
      onclick={closeContextMenu}
      role="presentation"
    ></div>
    <div class="vc-context-menu" bind:this={contextMenuRef}>
      <button class="vc-context-item" onclick={startRename}>Rename</button>
      <button class="vc-context-item vc-context-item--danger" onclick={openDeleteConfirm}>Move to Trash</button>
      {#if entry.is_dir}
        <button class="vc-context-item" onclick={handleNewFileHere}>New file here</button>
        <button class="vc-context-item" onclick={handleNewFolderHere}>New folder here</button>
      {/if}
    </div>
  {/if}

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

  <!-- Rename with wiki-links confirmation -->
  {#if pendingRename}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="vc-confirm-overlay"
      onclick={cancelRenameWithLinks}
      role="presentation"
    ></div>
    <div class="vc-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-heading">
      <h2 id="rename-heading" class="vc-confirm-heading">Rename file?</h2>
      <p class="vc-confirm-body">
        {pendingRename.linkCount} wiki-link{pendingRename.linkCount === 1 ? "" : "s"} point to this file.
        Rename anyway? (Links will be updated in a future version.)
      </p>
      <div class="vc-confirm-actions">
        <button class="vc-confirm-btn vc-confirm-btn--cancel" onclick={cancelRenameWithLinks}>Keep Name</button>
        <button class="vc-confirm-btn vc-confirm-btn--primary" onclick={confirmRenameWithLinks}>Rename File</button>
      </div>
    </div>
  {/if}

  <!-- Children (expanded subtree) -->
  {#if entry.is_dir && expanded && childrenLoaded}
    <ul class="vc-tree-children" role="group">
      {#each children as child (child.path)}
        <svelte:self
          entry={child}
          depth={depth + 1}
          {selectedPath}
          {onSelect}
          {onOpenFile}
          onRefreshParent={refreshChildren}
          {onPathChanged}
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

  /* Context menu */
  .vc-context-overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .vc-context-menu {
    position: absolute;
    top: 24px;
    left: 24px;
    z-index: 100;
    min-width: 160px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
    padding: 4px 0;
  }

  .vc-context-item {
    display: block;
    width: 100%;
    padding: 6px 12px;
    font-size: 14px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text);
  }

  .vc-context-item:hover {
    background: var(--color-accent-bg);
  }

  .vc-context-item--danger {
    color: var(--color-error);
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

  .vc-confirm-btn--primary {
    background: var(--color-accent);
    color: #fff;
    border-color: var(--color-accent);
  }

  .vc-confirm-btn--primary:hover {
    opacity: 0.9;
  }
</style>
