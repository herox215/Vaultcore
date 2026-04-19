<script lang="ts">
  import { Sparkles } from "lucide-svelte";
  import type { HybridHit } from "../../types/search";

  interface Props {
    result: HybridHit;
    onclick: () => void;
  }

  let { result, onclick }: Props = $props();

  const filename = $derived(result.path.split("/").pop() ?? result.path);
  // #204 — a hit surfaced only by the semantic leg of hybrid_search gets a
  // subtle badge so users can tell the result came in via embedding
  // similarity rather than keyword match. Hits present in both legs are
  // already explained by the existing snippet highlighting, so no badge.
  const semanticOnly = $derived(
    result.vecRank !== undefined && result.bm25Rank === undefined,
  );
</script>

<div
  class="vc-search-result-row"
  role="option"
  aria-selected="false"
  tabindex="0"
  {onclick}
  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onclick(); } }}
>
  <p class="vc-search-result-filename">
    <span class="vc-search-result-filename-text">{filename}</span>
    {#if semanticOnly}
      <span
        class="vc-search-result-semantic-indicator"
        title="Semantischer Treffer"
        aria-label="Nur semantisch gefunden"
      >
        <Sparkles size={12} strokeWidth={2} />
      </span>
    {/if}
  </p>
  <p class="vc-search-result-snippet vc-search-snippet">{@html result.snippet}</p>
</div>

<style>
  .vc-search-result-row {
    padding: 8px 12px;
    min-height: 48px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
  }

  .vc-search-result-row:hover {
    background: var(--color-accent-bg);
  }

  .vc-search-result-filename {
    font-size: 14px;
    font-weight: 700;
    color: var(--color-text);
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .vc-search-result-filename-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .vc-search-result-semantic-indicator {
    display: inline-flex;
    align-items: center;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .vc-search-result-snippet {
    font-size: 12px;
    color: var(--color-text-muted);
    line-height: 1.5;
    margin: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
</style>
