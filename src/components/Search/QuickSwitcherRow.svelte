<script lang="ts">
  interface Props {
    filename: string;
    relativePath: string;
    matchIndices: number[];
    selected: boolean;
    onclick: () => void;
    onhover: () => void;
  }

  let { filename, relativePath, matchIndices, selected, onclick, onhover }: Props = $props();

  // Build character array for the filename with matched-char highlighting
  // matchIndices are indices into `relativePath` (the full path returned by nucleo),
  // but we highlight based on the filename portion only. Compute the filename-offset.
  const filenameStart = $derived(relativePath.lastIndexOf("/") + 1);

  // Derive per-char highlight info for the filename
  const filenameChars = $derived(
    filename.split("").map((char, i) => ({
      char,
      highlighted: matchIndices.includes(filenameStart + i),
    }))
  );
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="vc-qs-row"
  class:vc-qs-row--selected={selected}
  onclick={onclick}
  onmouseenter={onhover}
  role="option"
  aria-selected={selected}
>
  <!-- Filename line with per-char match highlighting -->
  <span class="vc-qs-row-filename">
    {#each filenameChars as { char, highlighted } (char + Math.random())}
      {#if highlighted}
        <span style="font-weight: 700; color: var(--color-accent)">{char}</span>
      {:else}
        {char}
      {/if}
    {/each}
  </span>

  <!-- Relative path line -->
  <span class="vc-qs-row-path">{relativePath}</span>
</div>

<style>
  .vc-qs-row {
    padding: 8px 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
  }

  .vc-qs-row:hover,
  .vc-qs-row--selected {
    background: var(--color-accent-bg);
  }

  .vc-qs-row-filename {
    font-size: 14px;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .vc-qs-row-path {
    font-size: 12px;
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
