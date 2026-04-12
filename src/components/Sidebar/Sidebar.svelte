<script lang="ts">
  import { onMount } from "svelte";
  import { FilePlus, FolderPlus } from "lucide-svelte";
  import { listDirectory, createFile, createFolder } from "../../ipc/commands";
  import { vaultStore } from "../../store/vaultStore";
  import { toastStore } from "../../store/toastStore";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import type { DirEntry } from "../../types/tree";
  import TreeNode from "./TreeNode.svelte";

  interface Props {
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onOpenFile: (path: string) => void;
  }

  let { selectedPath, onSelect, onOpenFile }: Props = $props();

  let rootEntries = $state<DirEntry[]>([]);
  let loadError = $state<string | null>(null);
  let loading = $state(false);

  const vaultName = $derived(
    $vaultStore.currentPath
      ? $vaultStore.currentPath.split("/").pop() ?? $vaultStore.currentPath
      : "No vault"
  );

  async function loadRoot() {
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    loading = true;
    loadError = null;
    try {
      rootEntries = await listDirectory(vaultPath);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      loadError = vaultErrorCopy(ve);
      toastStore.push({ variant: "error", message: loadError });
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadRoot();
  });

  async function handleNewFile() {
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

  function handlePathChanged(_oldPath: string, _newPath: string) {
    void loadRoot();
  }
</script>

<aside class="vc-sidebar" data-testid="sidebar">
  <!-- Header strip -->
  <header class="vc-sidebar-header">
    <span class="vc-sidebar-vaultname" title={$vaultStore.currentPath ?? ""}>
      {vaultName}
    </span>
    <div class="vc-sidebar-actions">
      <button
        class="vc-sidebar-action-btn"
        onclick={handleNewFile}
        aria-label="New file"
        title="New file"
      >
        <FilePlus size={16} strokeWidth={1.5} />
      </button>
      <button
        class="vc-sidebar-action-btn"
        onclick={handleNewFolder}
        aria-label="New folder"
        title="New folder"
      >
        <FolderPlus size={16} strokeWidth={1.5} />
      </button>
    </div>
  </header>

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
            {onPathChanged}
          />
        {/each}
      </ul>
    {/if}
  </div>
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
</style>
