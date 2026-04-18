<script lang="ts">
  import { tick } from "svelte";
  import { RefreshCw, AlertTriangle } from "lucide-svelte";
  import { searchStore } from "../../store/searchStore";
  import { scrollStore } from "../../store/scrollStore";
  import { searchFulltext, rebuildIndex } from "../../ipc/commands";
  import { toastStore } from "../../store/toastStore";
  import type { SearchResult } from "../../types/search";
  import { isVaultError } from "../../types/errors";
  import { listenFileChange } from "../../ipc/events";
  import { extractSnippetMatch } from "../Editor/flashHighlight";
  import SearchInput from "./SearchInput.svelte";
  import SearchResults from "./SearchResults.svelte";

  interface Props {
    onOpenFile: (path: string) => void;
  }

  let { onOpenFile }: Props = $props();

  let inputRef: SearchInput | undefined = $state();

  $effect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listenFileChange(() => {
      if (!cancelled) searchStore.setIndexStale(true);
    }).then((fn) => {
      if (cancelled) { fn(); return; }
      unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
  });

  // Auto-focus input when panel mounts (Suche tab just became active)
  $effect(() => {
    if ($searchStore.activeTab === "search") {
      void tick().then(() => inputRef?.focus());
    }
  });

  async function handleSearch(query: string) {
    searchStore.setQuery(query);
    if (!query.trim()) {
      searchStore.clearResults();
      return;
    }
    searchStore.setSearching(true);
    try {
      const results = await searchFulltext(query, 100);
      const uniqueFileCount = new Set(results.map((r: SearchResult) => r.path)).size;
      searchStore.setResults(results, uniqueFileCount);
    } catch (e) {
      searchStore.setSearching(false);
      if (isVaultError(e) && e.kind === "IndexCorrupt") {
        searchStore.setIndexStale(true);
      }
      toastStore.push({ variant: "error", message: "Suche fehlgeschlagen — bitte erneut versuchen" });
    }
  }

  async function handleRebuild() {
    if ($searchStore.isRebuilding) return;
    searchStore.setRebuilding(true);
    toastStore.push({ variant: "clean-merge", message: "Index wird neu aufgebaut..." });
    try {
      await rebuildIndex();
      searchStore.setIndexStale(false);
      toastStore.push({ variant: "clean-merge", message: "Index aktualisiert" });
      await searchStore.refetchIfQueryNonEmpty();
    } catch (e) {
      toastStore.push({ variant: "error", message: "Index-Neuaufbau fehlgeschlagen" });
    } finally {
      searchStore.setRebuilding(false);
    }
  }

  function handleResultClick(result: SearchResult) {
    // Open the file tab first
    onOpenFile(result.path);
    // Then request scroll-to-match: extract first highlighted term from snippet
    const searchText = extractSnippetMatch(result.snippet) ?? $searchStore.query.split(" ")[0] ?? "";
    if (searchText.trim()) {
      scrollStore.requestScrollToMatch(result.path, searchText);
    }
  }
</script>

<div class="vc-search-panel">
  <!-- Header row with title and rebuild button -->
  <header class="vc-search-panel-header">
    <span class="vc-search-panel-title">Suche</span>
    <button
      class="vc-search-rebuild-btn"
      class:index-stale={$searchStore.indexStale}
      onclick={handleRebuild}
      aria-label="Index neu aufbauen"
      aria-disabled={$searchStore.isRebuilding}
      title={ $searchStore.indexStale ? "Index ist veraltet — neu aufbauen" : "Index neu aufbauen" }
      disabled={$searchStore.isRebuilding}
    >
      {#if $searchStore.indexStale}
        <AlertTriangle size={16} strokeWidth={1.5} />
      {:else}
        <RefreshCw
          size={16}
          strokeWidth={1.5}
          class={$searchStore.isRebuilding ? "vc-spin" : ""}
        />
      {/if}
      <span class="vc-search-rebuild-label">Index neu aufbauen</span>
    </button>
  </header>

  <!-- Search input — externalValue syncs programmatic query changes
       (e.g. TagsPanel tag-click → searchStore.runSearch). -->
  <SearchInput
    bind:this={inputRef}
    onSearch={handleSearch}
    disabled={$searchStore.isRebuilding}
    externalValue={$searchStore.query}
  />

  <!-- Rebuild overlay or results -->
  {#if $searchStore.isRebuilding}
    <div class="vc-search-rebuilding">
      <p>Indexierung läuft...</p>
    </div>
  {:else if $searchStore.query.trim()}
    <SearchResults
      results={$searchStore.results}
      totalFiles={$searchStore.totalFiles}
      onResultClick={handleResultClick}
    />
  {/if}
</div>

<style>
  .vc-search-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .vc-search-panel-header {
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

  .vc-search-panel-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--color-text);
  }

  .vc-search-rebuild-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 12px;
    padding: 4px 6px;
    border-radius: 4px;
  }

  .vc-search-rebuild-btn:hover:not(:disabled) {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-search-rebuild-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .vc-search-rebuild-btn.index-stale {
    color: var(--color-error, #e53e3e);
  }

  .vc-search-rebuild-label {
    white-space: nowrap;
  }

  .vc-search-rebuilding {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1 1 0;
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .vc-search-rebuilding p {
    margin: 0;
  }
</style>
