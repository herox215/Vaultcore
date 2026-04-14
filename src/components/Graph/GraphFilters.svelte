<script lang="ts">
  import { ChevronDown, ChevronRight, Search } from "lucide-svelte";

  export interface GraphFilterState {
    search: string;
    tags: string[];
    folders: string[];
    showOrphans: boolean;
    showUnresolved: boolean;
    showAttachments: boolean;
  }

  interface Props {
    state: GraphFilterState;
    availableTags: string[];
    availableFolders: string[];
    collapsed: boolean;
    onChange: (next: GraphFilterState) => void;
    onCollapsedChange: (collapsed: boolean) => void;
  }

  let {
    state,
    availableTags,
    availableFolders,
    collapsed,
    onChange,
    onCollapsedChange,
  }: Props = $props();

  function setField<K extends keyof GraphFilterState>(key: K, value: GraphFilterState[K]): void {
    onChange({ ...state, [key]: value });
  }

  function toggleTag(tag: string): void {
    const next = state.tags.includes(tag)
      ? state.tags.filter((t) => t !== tag)
      : [...state.tags, tag];
    setField("tags", next);
  }

  function toggleFolder(folder: string): void {
    const next = state.folders.includes(folder)
      ? state.folders.filter((f) => f !== folder)
      : [...state.folders, folder];
    setField("folders", next);
  }
</script>

<aside class="vc-graph-filters" aria-label="Graph-Filter">
  <button
    type="button"
    class="vc-graph-filters-header"
    aria-expanded={!collapsed}
    onclick={() => onCollapsedChange(!collapsed)}
  >
    {#if collapsed}
      <ChevronRight size={14} />
    {:else}
      <ChevronDown size={14} />
    {/if}
    <span class="vc-graph-filters-title">Filter</span>
  </button>

  {#if !collapsed}
    <div class="vc-graph-filters-body">
      <!-- Text search -->
      <label class="vc-graph-filters-search">
        <Search size={13} />
        <input
          type="text"
          placeholder="Suche nach Titel / Pfad"
          value={state.search}
          oninput={(e) => setField("search", (e.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <!-- Toggles -->
      <div class="vc-graph-filters-group">
        <label class="vc-graph-filters-toggle">
          <input
            type="checkbox"
            checked={state.showOrphans}
            onchange={(e) => setField("showOrphans", (e.currentTarget as HTMLInputElement).checked)}
          />
          <span>Orphans anzeigen</span>
        </label>
        <label class="vc-graph-filters-toggle">
          <input
            type="checkbox"
            checked={state.showUnresolved}
            onchange={(e) => setField("showUnresolved", (e.currentTarget as HTMLInputElement).checked)}
          />
          <span>Unresolved anzeigen</span>
        </label>
        <label class="vc-graph-filters-toggle">
          <input
            type="checkbox"
            checked={state.showAttachments}
            onchange={(e) => setField("showAttachments", (e.currentTarget as HTMLInputElement).checked)}
          />
          <span>Attachments anzeigen</span>
        </label>
      </div>

      <!-- Tag filter -->
      {#if availableTags.length > 0}
        <div class="vc-graph-filters-group">
          <div class="vc-graph-filters-grouplabel">Tags</div>
          <div class="vc-graph-filters-chips">
            {#each availableTags as tag (tag)}
              <button
                type="button"
                class="vc-graph-filters-chip"
                class:vc-graph-filters-chip--active={state.tags.includes(tag)}
                onclick={() => toggleTag(tag)}
              >
                #{tag}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Folder filter -->
      {#if availableFolders.length > 0}
        <div class="vc-graph-filters-group">
          <div class="vc-graph-filters-grouplabel">Ordner</div>
          <div class="vc-graph-filters-chips">
            {#each availableFolders as folder (folder)}
              <button
                type="button"
                class="vc-graph-filters-chip"
                class:vc-graph-filters-chip--active={state.folders.includes(folder)}
                onclick={() => toggleFolder(folder)}
              >
                {folder}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .vc-graph-filters {
    position: absolute;
    top: 12px;
    left: 12px;
    z-index: 5;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
    width: 260px;
    max-height: calc(100% - 24px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .vc-graph-filters-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: transparent;
    cursor: pointer;
    color: var(--color-text);
    width: 100%;
    text-align: left;
  }

  .vc-graph-filters-header:hover {
    color: var(--color-accent);
  }

  .vc-graph-filters-title {
    font-size: 12px;
    font-weight: 600;
  }

  .vc-graph-filters-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
    overflow-y: auto;
  }

  .vc-graph-filters-search {
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 4px 8px;
    background: var(--color-bg);
    color: var(--color-text-muted);
  }

  .vc-graph-filters-search input {
    border: none;
    outline: none;
    background: transparent;
    flex: 1;
    font-size: 12px;
    color: var(--color-text);
  }

  .vc-graph-filters-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .vc-graph-filters-grouplabel {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .vc-graph-filters-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--color-text);
    cursor: pointer;
  }

  .vc-graph-filters-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .vc-graph-filters-chip {
    font-size: 11px;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-text-muted);
    border-radius: 999px;
    padding: 2px 8px;
    cursor: pointer;
  }

  .vc-graph-filters-chip:hover {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }

  .vc-graph-filters-chip--active {
    background: var(--color-accent-bg);
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
</style>
