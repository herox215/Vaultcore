<script lang="ts">
  import type { RecentVault } from "../../types/vault";

  let {
    vault,
    onOpen,
  }: { vault: RecentVault; onOpen: (path: string) => void } = $props();

  // Plan 01-01 stores last_opened as RFC-3339/ISO-8601 ("YYYY-MM-DDTHH:MM:SSZ").
  // Phase 5 swaps this for a relative-time formatter (e.g. "2 days ago").
  // For Phase 1 we render the raw ISO string truncated to the date part.
  function formatTimestamp(iso: string): string {
    const tIdx = iso.indexOf("T");
    return tIdx > 0 ? iso.slice(0, tIdx) : iso;
  }
</script>

<button
  type="button"
  class="vc-recent-row"
  data-testid="recent-row"
  onclick={() => onOpen(vault.path)}
>
  <span class="vc-recent-path" title={vault.path}>{vault.path}</span>
  <span class="vc-recent-ts">{formatTimestamp(vault.last_opened)}</span>
</button>

<style>
  .vc-recent-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    /* #385 — fallback 32 preserves the existing min-height (byte-identical);
       coarse → 44px. */
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
  }
  .vc-recent-row:hover {
    background: var(--color-accent-bg);
    border-left-color: var(--color-accent);
  }
  .vc-recent-row:active {
    filter: brightness(0.95);
  }
  .vc-recent-row:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }
  .vc-recent-path {
    /* Middle-truncate by rendering RTL with ellipsis — preserves the filename
       at the end of the path while hiding the long middle segment. */
    direction: rtl;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vc-recent-ts {
    font-size: 12px;
    color: var(--color-text-muted);
    white-space: nowrap;
  }
</style>
