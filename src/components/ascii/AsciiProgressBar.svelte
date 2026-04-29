<script lang="ts">
  // #358 — Decorative progress bar built from `█`/`░` glyphs. The host
  // span is aria-hidden; the surrounding container in the caller owns
  // role="progressbar" + aria-valuemin/max/now. The filled run pulses
  // via CSS only; the empty run never animates.

  interface Props {
    value: number;
    max: number;
    width?: number;
    /** Optional data-testid forwarded onto the host span so callers can
        migrate existing test selectors without wrapping the component. */
    testid?: string | undefined;
  }

  let { value, max, width = 24, testid = undefined }: Props = $props();

  const ratio = $derived(max > 0 ? Math.min(1, Math.max(0, value / max)) : 0);
  const filled = $derived(Math.round(ratio * width));
  const empty = $derived(width - filled);
  const filledStr = $derived("█".repeat(filled));
  const emptyStr = $derived("░".repeat(empty));
</script>

<span class="vc-ascii-pb" aria-hidden="true" data-testid={testid}><!--
  --><span class="vc-ascii-pb-filled">{filledStr}</span><!--
  --><span class="vc-ascii-pb-empty">{emptyStr}</span><!--
--></span>

<style>
  .vc-ascii-pb {
    font-family: var(--vc-font-mono);
    color: var(--color-text-muted);
    letter-spacing: 0;
    white-space: pre;
  }
  .vc-ascii-pb-filled {
    animation: vc-ascii-pb-pulse 1400ms ease-in-out infinite;
  }
  /* Pulse is opacity-only on the filled run; ░ stays at full muted opacity. */
  @keyframes vc-ascii-pb-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.55; }
  }
  @media (prefers-reduced-motion: reduce) {
    .vc-ascii-pb-filled { animation: none; opacity: 1; }
  }
</style>
