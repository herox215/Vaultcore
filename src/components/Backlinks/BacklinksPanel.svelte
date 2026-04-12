<script lang="ts">
  import { backlinksStore } from "../../store/backlinksStore";
  import { tabStore } from "../../store/tabStore";
  import BacklinkRow from "./BacklinkRow.svelte";
  import { X } from "lucide-svelte";
  import { vaultStore } from "../../store/vaultStore";

  function handleBacklinkClick(relPath: string): void {
    const vault = $vaultStore.currentPath;
    if (!vault) return;
    const absPath = `${vault}/${relPath}`;
    tabStore.openTab(absPath);
  }
  function handleClose(): void {
    backlinksStore.setOpen(false);
  }
</script>

<div class="vc-backlinks-panel" role="complementary" aria-label="Backlinks">
  <div class="vc-backlinks-header">
    <span class="vc-backlinks-label">Backlinks</span>
    <button
      class="vc-backlinks-close"
      on:click={handleClose}
      aria-label="Backlinks-Panel schließen"
      type="button"
    >
      <X size={16} />
    </button>
  </div>
  <div class="vc-backlinks-body">
    {#if $backlinksStore.loading}
      <div class="vc-backlinks-empty">Lade Backlinks…</div>
    {:else if $backlinksStore.backlinks.length === 0}
      <div class="vc-backlinks-empty">
        <div class="vc-backlinks-empty-heading">Keine Backlinks</div>
        <div class="vc-backlinks-empty-body">Kein anderer Notiz verweist auf diese Datei.</div>
      </div>
    {:else}
      <div role="list">
        {#each $backlinksStore.backlinks as entry (entry.sourcePath + entry.lineNumber)}
          <div role="listitem">
            <BacklinkRow {entry} onClick={handleBacklinkClick} />
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .vc-backlinks-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg);
  }
  .vc-backlinks-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid var(--color-border);
  }
  .vc-backlinks-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: none;
  }
  .vc-backlinks-close {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    border-radius: 4px;
  }
  .vc-backlinks-close:hover { background: var(--color-accent-bg); }
  .vc-backlinks-body {
    flex: 1;
    overflow-y: auto;
  }
  .vc-backlinks-empty {
    padding: 32px 16px;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 14px;
  }
  .vc-backlinks-empty-heading {
    font-weight: 600;
    margin-bottom: 8px;
  }
  .vc-backlinks-empty-body {
    font-size: 14px;
    font-weight: 400;
  }
</style>
