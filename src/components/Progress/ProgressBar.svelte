<script lang="ts">
  import { progressStore } from "../../store/progressStore";
  import AsciiProgressBar from "../ascii/AsciiProgressBar.svelte";

  // #357 \u2014 label is a prop so the vault-open flow can render
  // "Scanning and securing vault\u2026" while the indexer walk and the
  // reconciliation sweep run together. Default preserves the prior
  // single-call-site string so other callers do not need to opt in.
  let { label = "Scanning vault\u2026" }: { label?: string } = $props();

  function formatCount(n: number): string {
    return n.toLocaleString("en-US");
  }

  // Middle-truncate for long paths
  function truncatePath(p: string, max = 48): string {
    if (p.length <= max) return p;
    const half = Math.floor((max - 1) / 2);
    return `${p.slice(0, half)}\u2026${p.slice(p.length - half)}`;
  }
</script>

{#if $progressStore.active}
  <div class="vc-progress-overlay" data-testid="progress-overlay">
    <div class="vc-progress-card">
      <p class="vc-progress-label">{label}</p>
      <p class="vc-progress-counter" data-testid="progress-counter">
        {formatCount($progressStore.current)} / {formatCount($progressStore.total)}
      </p>
      <div role="progressbar"
           aria-valuemin="0"
           aria-valuemax={$progressStore.total}
           aria-valuenow={$progressStore.current}>
        <AsciiProgressBar
          value={$progressStore.current}
          max={$progressStore.total}
          testid="progress-fill"
        />
      </div>
      <p class="vc-progress-file" data-testid="progress-file">
        {truncatePath($progressStore.currentFile)}
      </p>
    </div>
  </div>
{/if}

<style>
  .vc-progress-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg);
    z-index: 100;
  }
  .vc-progress-card {
    width: 400px;
    padding: 48px 32px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }
  .vc-progress-label {
    margin: 0 0 8px 0;
    font-size: 14px;
    color: var(--color-text-muted);
  }
  .vc-progress-counter {
    margin: 0 0 16px 0;
    font-size: 12px;
    color: var(--color-text-muted);
    text-align: right;
  }
  .vc-progress-file {
    margin: 8px 0 0 0;
    font-size: 12px;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
