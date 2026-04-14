<script lang="ts">
  import type { Heading } from "../../lib/headings";

  export let entry: Heading;
  export let active: boolean = false;
  export let onClick: (entry: Heading) => void;
</script>

<button
  class="vc-outline-row"
  class:vc-outline-row--active={active}
  style="padding-left: {8 + (entry.level - 1) * 12}px"
  type="button"
  title={entry.text}
  on:click={() => onClick(entry)}
>
  <span class="vc-outline-level">H{entry.level}</span>
  <span class="vc-outline-text">{entry.text}</span>
</button>

<style>
  .vc-outline-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    text-align: left;
    padding-top: 5px;
    padding-bottom: 5px;
    padding-right: 16px;
    border: none;
    background: transparent;
    cursor: pointer;
    border-bottom: 1px solid var(--color-border);
  }
  .vc-outline-row:hover {
    background: var(--color-accent-bg);
  }
  .vc-outline-row--active {
    background: var(--color-accent-bg);
  }
  .vc-outline-level {
    font-size: 10px;
    font-weight: 600;
    color: var(--color-text-muted);
    flex-shrink: 0;
    width: 16px;
    text-align: center;
  }
  .vc-outline-text {
    font-size: 13px;
    font-weight: 400;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .vc-outline-row--active .vc-outline-text {
    color: var(--color-accent);
    font-weight: 500;
  }
</style>
