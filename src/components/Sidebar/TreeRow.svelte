<script lang="ts">
  // Flat row for the virtualized file tree (#253).
  //
  // Renders a single row from the flattened tree model. Unlike the former
  // recursive <TreeNode>, this component:
  //   - does NOT subscribe to treeRevealStore (Sidebar owns the sole subscription)
  //   - does NOT own an `expanded` or `children` state (Sidebar's tree model does)
  //   - does NOT recurse (the flat renderer places child rows as siblings)
  //
  // Drag-drop, inline rename, context-menu, and delete-confirmation logic were
  // lifted from TreeNode with minimal behavioural changes so the existing WDIO
  // specs (inline-rename, tree-context-menu, drag-drop) still pass.
  import {
    ChevronRight,
    Folder,
    FolderOpen,
    FileText,
    File,
    MoreHorizontal,
    Star,
    Lock,
    LockOpen,
  } from "lucide-svelte";
  import {
    createFile,
    createFolder,
    deleteFile,
    writeFile,
    exportDecryptedFile,
    pickSavePath,
  } from "../../ipc/commands";
  import { isInsideUnlockedEncryptedFolder } from "../Editor/attachmentSource";
  import { serializeCanvas, emptyCanvas } from "../../lib/canvas/parse";
  import { toastStore } from "../../store/toastStore";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import InlineRename from "./InlineRename.svelte";
  import ContextMenu from "../common/ContextMenu.svelte";
  import { vaultStore } from "../../store/vaultStore";
  import { tabStore } from "../../store/tabStore";
  import { resolvedLinksStore } from "../../store/resolvedLinksStore";
  import { bookmarksStore } from "../../store/bookmarksStore";
  import {
    openEncryptModal,
    openUnlockModal,
  } from "../../store/encryptionModalStore";
  import { disarmAutoLock } from "../../store/autoLockStore";
  import { lockFolder } from "../../ipc/commands";
  import type { FlatRow } from "../../lib/flattenTree";
  import type { RenameCascadeRequest, MoveDropRequest } from "../../types/sidebar";

  interface Props {
    row: FlatRow;
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onOpenFile: (path: string) => void;
    onToggleExpand: (row: FlatRow) => void | Promise<void>;
    /**
     * Guaranteed-expand (idempotent). Use when the caller needs the
     * folder open regardless of its current expanded state. A plain
     * `onToggleExpand` reads `treeState.expanded` and flips it, so
     * calling it on an already-expanded folder collapses it — wrong
     * for any flow whose intent is "make sure this folder is open"
     * (unlock success; "New file/folder here" context menu entries
     * that should leave the containing folder expanded).
     */
    onEnsureExpanded: (row: FlatRow) => void | Promise<void>;
    /** Tell the Sidebar the child list for this folder needs re-fetching. */
    onRefreshFolder: (folderPath: string) => void | Promise<void>;
    onPathChanged: (oldPath: string, newPath: string) => void;
    /** Called when the user opens/closes inline rename on this row. */
    onRenameStateChange?: (path: string, renaming: boolean) => void;
    /**
     * Hand a rename-with-backlinks request up to Sidebar (#378). The cascade
     * dialog state lives on Sidebar so it survives the watcher-driven tree
     * re-flatten that destroys this row's component instance the moment the
     * disk rename lands.
     */
    onRequestRenameCascade: (req: RenameCascadeRequest) => void;
    /**
     * Hand a drop event up to Sidebar (#378). TreeRow only detects the drop
     * and validates the drag source/target; Sidebar runs the rest of the
     * pipeline (getBacklinks → cascade-or-direct dispatch → moveFile →
     * updateLinksAfterRename → folder refreshes) on its always-mounted
     * lifetime, symmetric with the rename path.
     */
    onRequestMoveCascade: (req: MoveDropRequest) => void;
  }

  let {
    row,
    selectedPath,
    onSelect,
    onOpenFile,
    onToggleExpand,
    onEnsureExpanded,
    onRefreshFolder,
    onPathChanged,
    onRenameStateChange,
    onRequestRenameCascade,
    onRequestMoveCascade,
  }: Props = $props();

  // Reactive — the Sidebar recomputes row objects on every flatten, so Svelte
  // already rerenders on change. No local mirror required.
  const isActive = $derived(selectedPath === row.path);
  const isBookmarked = $derived(
    !row.isDir && row.relPath !== "" && $bookmarksStore.paths.includes(row.relPath),
  );

  // Rename state — kept local because it's ephemeral per-row UI.
  let renaming = $state(false);
  let isNewFile = $state(false);

  // Context-menu + dialog state.
  let showContextMenu = $state(false);
  let menuPos = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  let showDeleteConfirm = $state(false);

  let isDragSource = $state(false);
  let isDragTarget = $state(false);

  function getVaultRoot(): string | null {
    let v: string | null = null;
    const u = vaultStore.subscribe((s) => {
      v = s.currentPath;
    });
    u();
    return v;
  }

  function toRelPath(absPath: string, vaultRoot: string): string {
    return absPath.startsWith(vaultRoot + "/")
      ? absPath.slice(vaultRoot.length + 1)
      : absPath;
  }

  // #345 — encryption state helpers. `encryption` defaults to
  // `"not-encrypted"` for fixtures written before #345 landed.
  const isLocked = $derived((row.encryption ?? "not-encrypted") === "locked");
  const isUnlocked = $derived((row.encryption ?? "not-encrypted") === "unlocked");
  const isEncryptedRoot = $derived(isLocked || isUnlocked);
  // #360 — only files (not folders, not plain-vault files) inside an
  // unlocked encrypted folder can be exported. The derivation is
  // microtask-cached inside `isInsideUnlockedEncryptedFolder` so the
  // per-row cost stays O(1) amortized across a virtualized render pass.
  const canExportDecrypted = $derived(
    !row.isDir && isInsideUnlockedEncryptedFolder(row.path),
  );

  function handleClick() {
    onSelect(row.path);
    if (row.isDir) {
      // #355: clicking a locked folder opens the password modal
      // instead of toggling expansion. On successful unlock we:
      //   1. Re-fetch the parent listing so the cached DirEntry for
      //      this folder flips from `encryption: "locked"` to
      //      `"unlocked"`. Without this step, flattenTree's
      //      `if (entry.encryption === "locked") continue` would
      //      skip children of an otherwise-expanded folder until
      //      the async `encrypted_folders_changed` pulse lands —
      //      yielding a brief "expanded but empty" flash.
      //   2. Ensure-expand (idempotent). A plain toggle would
      //      *collapse* a folder whose relPath is still in
      //      `treeState.expanded` from before it was locked
      //      (locking does not prune the expanded set), forcing
      //      a second click to re-open it.
      if (isLocked) {
        openUnlockModal(row.path, row.name, async () => {
          const parent = parentOf(row.path) ?? getVaultRoot();
          if (parent) await onRefreshFolder(parent);
          await onEnsureExpanded(row);
        });
        return;
      }
      void onToggleExpand(row);
    } else {
      onOpenFile(row.path);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      handleClick();
    }
  }

  function openContextMenu(e: MouseEvent) {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    menuPos = { x: rect.left, y: rect.bottom };
    showContextMenu = true;
  }

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
    setRenaming(true);
    isNewFile = false;
  }

  function setRenaming(next: boolean) {
    renaming = next;
    onRenameStateChange?.(row.path, next);
  }

  function handleOpenInSplit() {
    closeContextMenu();
    tabStore.openTab(row.path);
    tabStore.moveToPane("right");
  }

  async function toggleBookmark() {
    closeContextMenu();
    const vault = getVaultRoot();
    if (!vault || row.isDir) return;
    const rel = toRelPath(row.path, vault);
    await bookmarksStore.toggle(rel, vault);
  }

  function handleRenameConfirm(newPath: string, linkCount: number) {
    // #378: this function MUST stay synchronous after the IPC await resolves
    // in InlineRename. The watcher fires a synthetic rename event that
    // re-flattens the tree and destroys this TreeRow under the old path.
    // Any `await` between here and the cascade-request callback would cross
    // the unmount and lose the reference. The callback itself is a closure
    // captured at component construction — calling it from a destroyed
    // component is fine because Sidebar (the receiver) is always mounted.
    setRenaming(false);
    const vault = getVaultRoot();
    const oldRelPath = vault ? toRelPath(row.path, vault) : row.path;
    const newRelPath = vault ? toRelPath(newPath, vault) : newPath;
    if (vault) {
      void bookmarksStore.renamePath(oldRelPath, newRelPath, vault);
    }
    if (linkCount > 0) {
      onRequestRenameCascade({
        oldPath: row.path,
        newPath,
        oldRelPath,
        newRelPath,
        linkCount,
      });
    } else {
      onPathChanged(row.path, newPath);
      resolvedLinksStore.requestReload();
    }
  }

  function handleRenameCancel() {
    setRenaming(false);
  }

  function openDeleteConfirm() {
    closeContextMenu();
    showDeleteConfirm = true;
  }

  async function confirmDelete() {
    showDeleteConfirm = false;
    try {
      await deleteFile(row.path);
      // Refresh the containing folder so the flat list updates.
      const vault = getVaultRoot();
      const parentDir = vault && row.path.startsWith(vault + "/")
        ? parentOf(row.path)
        : parentOf(row.path);
      await onRefreshFolder(parentDir ?? vault ?? "");
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  function cancelDelete() {
    showDeleteConfirm = false;
  }

  function parentOf(absPath: string): string | null {
    // Backend paths (`DirEntry.path` via `to_string_lossy` in `tree.rs`)
    // carry native separators — backslashes on Windows, forward slashes
    // elsewhere. Accept both so a top-level folder like `C:\Vault\secret`
    // still resolves to its parent instead of silently returning `null`
    // and skipping the post-unlock parent refresh on Windows.
    const lastSep = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
    if (lastSep <= 0) return null;
    return absPath.slice(0, lastSep);
  }

  async function handleNewFileHere() {
    closeContextMenu();
    try {
      const newPath = await createFile(row.path, "");
      await onRefreshFolder(row.path);
      await onEnsureExpanded(row);
      tabStore.openTab(newPath);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleNewCanvasHere() {
    closeContextMenu();
    try {
      const newPath = await createFile(row.path, "Untitled.canvas");
      await writeFile(newPath, serializeCanvas(emptyCanvas()));
      await onRefreshFolder(row.path);
      await onEnsureExpanded(row);
      tabStore.openFileTab(newPath, "canvas");
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleNewFolderHere() {
    closeContextMenu();
    try {
      await createFolder(row.path, "");
      await onRefreshFolder(row.path);
      await onEnsureExpanded(row);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  // #360 — export a decrypted plaintext copy of this file to a user-
  // chosen destination. Menu entry is only rendered when the row sits
  // inside an UNLOCKED encrypted folder (see `canExportDecrypted`), so
  // the default copy assumes the backend will succeed. A locked → lock
  // race still produces a `PathLocked` error which surfaces via the
  // usual `vaultErrorCopy` path so the user can unlock and retry.
  async function handleExportDecrypted() {
    closeContextMenu();
    const picked = await pickSavePath(row.name);
    if (!picked) return; // user cancelled — silent, matches other save flows
    try {
      await exportDecryptedFile(row.path, picked);
      const filename = picked.split(/[/\\]/).pop() ?? picked;
      // #360 — `warning` variant (not `info`) matches the security
      // consequence: the user just produced a plaintext file readable
      // by any app on their system. The copy spells that out so the
      // audit is end-to-end — variant color + explicit wording.
      toastStore.push({
        variant: "warning",
        message: `Saved unencrypted copy to ${filename}. This file is now readable by other apps.`,
      });
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  // --- Drag-and-drop (keeps HTML5 semantics from TreeNode) -------------------
  function handleDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    const mime = row.isDir ? "text/vaultcore-folder" : "text/vaultcore-file";
    e.dataTransfer.setData(mime, row.path);
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
    if (!row.isDir) return;
    if (!e.dataTransfer || !isSidebarDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    isDragTarget = true;
  }

  function handleDragLeave() {
    isDragTarget = false;
  }

  function handleDrop(e: DragEvent) {
    isDragTarget = false;
    if (!row.isDir) return;
    if (!e.dataTransfer || !isSidebarDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    const sourcePath =
      e.dataTransfer.getData("text/vaultcore-file") ||
      e.dataTransfer.getData("text/vaultcore-folder");
    if (!sourcePath || sourcePath === row.path) return;
    // #378: hand off synchronously — Sidebar owns the rest of the pipeline
    // so an intervening watcher event cannot tear down state mid-flight.
    onRequestMoveCascade({ sourcePath, targetDirPath: row.path });
  }

</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<li
  role="treeitem"
  aria-expanded={row.isDir ? row.expanded : undefined}
  aria-selected={isActive}
  tabindex="0"
  class="vc-tree-node"
  class:vc-tree-node--active={isActive}
  class:vc-tree-node--drag-source={isDragSource}
  class:vc-tree-node--drag-target={isDragTarget}
  draggable={!renaming}
  data-tree-row={row.path}
  data-tree-row-depth={row.depth}
  ondragstart={handleDragStart}
  ondragend={handleDragEnd}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  onkeydown={handleKeydown}
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-tree-row"
    style="padding-left: calc({row.depth} * 16px + 8px)"
    onclick={handleClick}
    oncontextmenu={handleRowContextMenu}
    role="button"
    tabindex="-1"
    title={row.path}
  >
    {#if row.isDir}
      <button
        class="vc-tree-chevron"
        class:vc-tree-chevron--expanded={row.expanded}
        onclick={(e) => { e.stopPropagation(); void onToggleExpand(row); }}
        aria-label={row.expanded ? "Collapse" : "Expand"}
        tabindex="-1"
      >
        <ChevronRight size={16} strokeWidth={1.5} />
      </button>
    {:else}
      <span class="vc-tree-spacer" aria-hidden="true"></span>
    {/if}

    <span
      class="vc-tree-icon"
      class:vc-tree-icon--active={isActive}
      class:vc-tree-icon--locked={isLocked}
      class:vc-tree-icon--unlocked={isUnlocked}
      aria-hidden="true"
    >
      {#if row.isDir}
        {#if isLocked}
          <Lock size={16} strokeWidth={1.5} />
        {:else if isUnlocked}
          <LockOpen size={16} strokeWidth={1.5} />
        {:else if row.expanded}
          <FolderOpen size={16} strokeWidth={1.5} />
        {:else}
          <Folder size={16} strokeWidth={1.5} />
        {/if}
      {:else if row.isMd}
        <FileText size={16} strokeWidth={1.5} />
      {:else}
        <File size={16} strokeWidth={1.5} />
      {/if}
    </span>

    {#if renaming}
      <InlineRename
        currentName={row.name}
        oldPath={row.path}
        {isNewFile}
        onConfirm={handleRenameConfirm}
        onCancel={handleRenameCancel}
      />
    {:else}
      <span
        class="vc-tree-name"
        class:vc-tree-name--locked={isLocked}
      >
        {row.name}
        {#if row.isSymlink}
          <em class="vc-tree-symlink">(link)</em>
        {/if}
      </span>
      {#if isBookmarked}
        <span class="vc-tree-bookmark" aria-label="Bookmarked" title="Bookmark">
          <Star size={12} strokeWidth={1.5} />
        </span>
      {/if}
    {/if}

    {#if !renaming}
      <button
        class="vc-tree-more"
        onclick={openContextMenu}
        aria-label="More options for {row.name}"
        tabindex="-1"
      >
        <MoreHorizontal size={16} strokeWidth={1.5} />
      </button>
    {/if}
  </div>

  <ContextMenu open={showContextMenu} x={menuPos.x} y={menuPos.y} onClose={closeContextMenu}>
    {#if !row.isDir}
      <button class="vc-context-item" onclick={handleOpenInSplit}>Open in split</button>
    {/if}
    <button class="vc-context-item" onclick={startRename}>Rename</button>
    {#if !row.isDir}
      <button class="vc-context-item" onclick={() => void toggleBookmark()}>
        {isBookmarked ? "Remove bookmark" : "Bookmark"}
      </button>
    {/if}
    {#if canExportDecrypted}
      <button
        class="vc-context-item"
        data-testid="context-export-decrypted"
        onclick={() => void handleExportDecrypted()}
      >Export decrypted copy…</button>
    {/if}
    <button class="vc-context-item vc-context-item--danger" onclick={openDeleteConfirm}>Move to Trash</button>
    {#if row.isDir}
      <button class="vc-context-item" onclick={handleNewFileHere}>New file here</button>
      <button class="vc-context-item" onclick={handleNewCanvasHere}>New canvas here</button>
      <button class="vc-context-item" onclick={handleNewFolderHere}>New folder here</button>
      <!-- #345: encryption actions. Three mutually-exclusive states. -->
      {#if !isEncryptedRoot}
        <button
          class="vc-context-item"
          data-testid="context-encrypt-folder"
          onclick={() => { closeContextMenu(); openEncryptModal(row.path, row.name); }}
        >Encrypt folder…</button>
      {:else if isLocked}
        <button
          class="vc-context-item"
          data-testid="context-unlock-folder"
          onclick={() => { closeContextMenu(); openUnlockModal(row.path, row.name); }}
        >Unlock folder…</button>
      {:else}
        <button
          class="vc-context-item"
          data-testid="context-lock-folder"
          onclick={async () => {
            closeContextMenu();
            try {
              await lockFolder(row.path);
              // #345: cancel the pending auto-lock timer for this
              // root — manual lock wins, no need to fire the IPC
              // again when the timer expires.
              disarmAutoLock(row.relPath);
            } catch (e) {
              if (isVaultError(e)) toastStore.error(vaultErrorCopy(e));
              else toastStore.error("Failed to lock folder");
            }
          }}
        >Lock folder</button>
      {/if}
    {/if}
  </ContextMenu>

  {#if showDeleteConfirm}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="vc-confirm-overlay vc-modal-scrim"
      onclick={cancelDelete}
      role="presentation"
    ></div>
    <div class="vc-confirm-dialog vc-modal-surface" role="dialog" aria-modal="true" aria-labelledby="delete-heading-{row.path}">
      <h2 id="delete-heading-{row.path}" class="vc-confirm-heading">Move to Trash?</h2>
      <p class="vc-confirm-body">
        "{row.name}" will be moved to .trash/ and can be recovered from there.
      </p>
      <div class="vc-confirm-actions">
        <button class="vc-confirm-btn vc-confirm-btn--cancel" onclick={cancelDelete}>Keep File</button>
        <button class="vc-confirm-btn vc-confirm-btn--danger" onclick={confirmDelete}>Move to Trash</button>
      </div>
    </div>
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

  /* #345: encryption icon variants. Locked stays muted to signal
     "currently out of reach"; unlocked takes the accent color. */
  .vc-tree-icon--locked {
    color: var(--color-text-muted);
  }
  .vc-tree-icon--unlocked {
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

  /* #345: muted label for locked folder rows so the collapsed,
     unexpandable row doesn't visually compete with plain rows. */
  .vc-tree-name--locked {
    color: var(--color-text-muted);
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

  .vc-confirm-overlay {
    z-index: 199;
  }

  .vc-confirm-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 200;
    width: 280px;
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
</style>
