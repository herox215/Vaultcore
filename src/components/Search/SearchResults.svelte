<script lang="ts">
  import type { SearchResult } from "../../types/search";
  import SearchResultRow from "./SearchResultRow.svelte";

  interface Props {
    results: SearchResult[];
    totalFiles: number;
    onResultClick: (result: SearchResult) => void;
  }

  let { results, totalFiles, onResultClick }: Props = $props();
</script>

<div class="vc-search-results-container">
  {#if results.length > 0}
    <!-- Counter header -->
    <p class="vc-search-results-counter">
      {results.length} Treffer in {totalFiles} Dateien
    </p>

    <!-- Scrollable result list -->
    <div class="vc-search-results-list" role="listbox" aria-label="Suchergebnisse">
      {#each results as result (result.path + result.score)}
        <SearchResultRow {result} onclick={() => onResultClick(result)} />
      {/each}

      {#if results.length >= 100}
        <p class="vc-search-results-overflow">
          Zeige 100 von {results.length} Treffern — Suche verfeinern
        </p>
      {/if}
    </div>
  {:else}
    <p class="vc-search-results-empty">Keine Treffer</p>
  {/if}
</div>

<style>
  .vc-search-results-container {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }

  .vc-search-results-counter {
    font-size: 12px;
    color: var(--color-text-muted);
    padding: 8px 12px;
    margin: 0;
    flex-shrink: 0;
    border-bottom: 1px solid var(--color-border);
  }

  .vc-search-results-list {
    overflow-y: auto;
    flex: 1 1 0;
  }

  .vc-search-results-overflow {
    font-size: 12px;
    color: var(--color-text-muted);
    font-style: italic;
    text-align: center;
    padding: 8px 12px;
    margin: 0;
  }

  .vc-search-results-empty {
    font-size: 12px;
    color: var(--color-text-muted);
    text-align: center;
    padding: 16px 12px;
    margin: 0;
  }
</style>
