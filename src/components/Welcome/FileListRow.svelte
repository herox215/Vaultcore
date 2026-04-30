<script lang="ts">
  let {
    path,
    active,
    onOpen,
  }: {
    path: string;
    active: boolean;
    onOpen: (p: string) => void;
  } = $props();
</script>

<button
  type="button"
  class="vc-file-row"
  class:active
  data-testid="file-row"
  data-path={path}
  onclick={() => onOpen(path)}
>
  <span class="vc-file-path">{path}</span>
</button>

<style>
  .vc-file-row {
    display: block;
    width: 100%;
    /* #385 — desktop fallback preserves the 32px min-height; coarse → 44px. */
    min-height: var(--vc-hit-target, 32px);
    padding: 8px 16px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: var(--color-text);
    font-size: 14px;
    font-family: var(--vc-font-body);
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vc-file-row:hover {
    background: var(--color-accent-bg);
  }
  .vc-file-row.active {
    background: var(--color-accent-bg);
    border-left-color: var(--color-accent);
  }
  .vc-file-path {
    direction: rtl;
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
