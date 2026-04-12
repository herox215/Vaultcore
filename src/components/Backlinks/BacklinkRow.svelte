<script lang="ts">
  import type { BacklinkEntry } from "../../types/links";
  export let entry: BacklinkEntry;
  export let onClick: (path: string) => void;
</script>

<button
  class="vc-backlink-row"
  on:click={() => onClick(entry.sourcePath)}
  type="button"
>
  <div class="vc-backlink-title">{entry.sourceTitle}</div>
  <div class="vc-backlink-context">{entry.context}</div>
</button>

<style>
  .vc-backlink-row {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 16px;
    border: none;
    background: transparent;
    cursor: pointer;
    border-bottom: 1px solid var(--color-border);
  }
  .vc-backlink-row:hover {
    background: var(--color-accent-bg);
  }
  .vc-backlink-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 4px;
  }
  .vc-backlink-context {
    font-size: 14px;
    font-weight: 400;
    color: var(--color-text);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
