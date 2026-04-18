<script lang="ts">
  interface Props {
    filename: string;
    relativePath: string;
    matchIndices: number[];
    selected: boolean;
    onclick: () => void;
    onhover: () => void;
    /** Issue #60: matched frontmatter alias (when the row surfaced because of
     *  an `aliases:` hit rather than a filename hit). Rendered as
     *  `alias → filename` in front of the filename. */
    matchedAlias?: string | undefined;
  }

  let { filename, relativePath, matchIndices, selected, onclick, onhover, matchedAlias }: Props = $props();

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

<!-- Keyboard nav (ArrowUp/ArrowDown/Enter) is owned by the parent
     QuickSwitcher's input handler — the row itself only needs to be a
     click target; its tabindex={-1} keeps it out of the Tab sequence while
     allowing programmatic focus if ever needed. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="vc-qs-row"
  class:vc-qs-row--selected={selected}
  onclick={onclick}
  onmouseenter={onhover}
  role="option"
  aria-selected={selected}
  tabindex={-1}
>
  <!-- Filename line with per-char match highlighting -->
  <span class="vc-qs-row-filename">
    {#if matchedAlias}
      <!-- Issue #60: alias hit — render `alias → filename` so users see why
           a note with a non-matching filename surfaced. The alias is shown
           with accent weight because it's the string the query actually hit. -->
      <span class="vc-qs-row-alias">{matchedAlias}</span>
      <span class="vc-qs-row-alias-arrow">&nbsp;&rarr;&nbsp;</span>
    {/if}
    {#each filenameChars as { char, highlighted }, i (i)}
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

  .vc-qs-row-alias {
    font-weight: 700;
    color: var(--color-accent);
  }

  .vc-qs-row-alias-arrow {
    color: var(--color-text-muted);
  }
</style>
