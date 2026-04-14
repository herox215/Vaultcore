<script lang="ts">
  import type { OutgoingLink } from "../../lib/outgoingLinks";
  export let entry: OutgoingLink;
  export let onClick: (entry: OutgoingLink) => void;

  $: resolved = entry.resolvedPath !== null;
  $: displayLabel = entry.aliases[0] ?? entry.target;
  $: secondary = resolved
    ? (entry.aliases[0] !== undefined ? entry.target : (entry.resolvedPath ?? ""))
    : "Nicht verknüpfte Notiz";
</script>

<button
  class="vc-outlink-row"
  class:vc-outlink-row--unresolved={!resolved}
  on:click={() => onClick(entry)}
  type="button"
  title={resolved ? (entry.resolvedPath ?? entry.target) : entry.target}
>
  <div class="vc-outlink-title">{displayLabel}</div>
  {#if secondary.length > 0}
    <div class="vc-outlink-secondary">{secondary}</div>
  {/if}
</button>

<style>
  .vc-outlink-row {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 16px;
    border: none;
    background: transparent;
    cursor: pointer;
    border-bottom: 1px solid var(--color-border);
  }
  .vc-outlink-row:hover {
    background: var(--color-accent-bg);
  }
  .vc-outlink-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vc-outlink-secondary {
    font-size: 12px;
    font-weight: 400;
    color: var(--color-text-muted);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Dim + italicize unresolved targets to differentiate them from resolved ones
     (parity with CM6 cm-wikilink-unresolved styling). */
  .vc-outlink-row--unresolved .vc-outlink-title {
    color: var(--color-text-muted);
    font-style: italic;
    font-weight: 500;
  }
</style>
