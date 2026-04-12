<script lang="ts">
  import type { SearchResult } from "../../types/search";

  interface Props {
    result: SearchResult;
    onclick: () => void;
  }

  let { result, onclick }: Props = $props();

  const filename = $derived(result.path.split("/").pop() ?? result.path);
</script>

<div
  class="vc-search-result-row"
  role="option"
  aria-selected="false"
  tabindex="0"
  {onclick}
  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onclick(); } }}
>
  <p class="vc-search-result-filename">{filename}</p>
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
