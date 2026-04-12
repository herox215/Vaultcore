<script lang="ts">
  import { vaultStore } from "../../store/vaultStore";
  import { editorStore } from "../../store/editorStore";
  import { toastStore } from "../../store/toastStore";
  import { readFile, writeFile } from "../../ipc/commands";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import FileListRow from "./FileListRow.svelte";
  import CMEditor from "../Editor/CMEditor.svelte";

  function joinVaultPath(vault: string, relative: string): string {
    // Vault path is canonical, file list uses forward slashes.
    // Use platform-agnostic concat: Tauri commands on Windows accept / too.
    return `${vault}/${relative}`;
  }

  async function openFile(relative: string): Promise<void> {
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    const absolute = joinVaultPath(vaultPath, relative);
    try {
      const content = await readFile(absolute);
      editorStore.openFile(absolute, content);
    } catch (err) {
      const ve = isVaultError(err)
        ? err
        : { kind: "Io" as const, message: String(err), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleSave(text: string): Promise<void> {
    const activePath = $editorStore.activePath;
    if (!activePath) return;
    try {
      const hash = await writeFile(activePath, text);
      editorStore.setLastSavedHash(hash);
    } catch (err) {
      const ve = isVaultError(err)
        ? err
        : { kind: "Io" as const, message: String(err), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  // Synchronous wrapper so CMEditor's `onSave` callback returns void.
  function onSaveSync(text: string): void {
    void handleSave(text);
  }
</script>

<main class="vc-vault-view" data-testid="vault-view">
  <header class="vc-vault-header">
    <span class="vc-vault-path" title={$vaultStore.currentPath ?? ""}>
      {$vaultStore.currentPath ?? ""}
    </span>
    <span class="vc-vault-count" data-testid="vault-count">
      {$vaultStore.fileCount} file{$vaultStore.fileCount === 1 ? "" : "s"}
    </span>
  </header>

  <div class="vc-vault-body">
    <aside class="vc-file-list" data-testid="file-list">
      {#each $vaultStore.fileList as path (path)}
        <FileListRow
          {path}
          active={$editorStore.activePath === joinVaultPath($vaultStore.currentPath ?? "", path)}
          onOpen={openFile}
        />
      {/each}
      {#if $vaultStore.fileList.length === 0}
        <p class="vc-empty" data-testid="file-list-empty">No Markdown files in this vault.</p>
      {/if}
    </aside>

    <section class="vc-editor-pane" data-testid="editor-pane">
      {#if $editorStore.activePath}
        {#key $editorStore.activePath}
          <CMEditor content={$editorStore.content} onSave={onSaveSync} />
        {/key}
      {:else}
        <div class="vc-editor-empty">
          <p>No file selected.</p>
          <p class="vc-editor-empty-hint">Click a file in the list to open it.</p>
        </div>
      {/if}
    </section>
  </div>
</main>

<style>
  .vc-vault-view {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--color-bg);
  }
  .vc-vault-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 16px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    font-size: 14px;
    color: var(--color-text);
  }
  .vc-vault-path {
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vc-vault-count {
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .vc-vault-body {
    display: grid;
    grid-template-columns: minmax(200px, 280px) 1fr;
    flex: 1;
    min-height: 0;
  }
  .vc-file-list {
    overflow-y: auto;
    border-right: 1px solid var(--color-border);
    background: var(--color-surface);
  }
  .vc-empty {
    padding: 16px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .vc-editor-pane {
    overflow: hidden;
    background: var(--color-surface);
  }
  .vc-editor-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--color-text-muted);
    font-size: 14px;
  }
  .vc-editor-empty-hint {
    font-size: 12px;
    margin-top: 8px;
  }
</style>
