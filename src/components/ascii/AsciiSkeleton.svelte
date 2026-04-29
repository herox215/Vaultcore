<script lang="ts">
  // #358 — Static, deterministic ASCII skeleton. The shape is generated
  // from `seed` via a small LCG so re-renders during loading produce
  // the same pattern (no flicker on every keystroke). No animation by
  // intent — perceived-performance comes from "something is here".

  interface Props {
    lines?: number;
    width?: number;
    seed?: number;
  }

  let { lines = 3, width = 36, seed = 0 }: Props = $props();

  // Deterministic LCG. (s | 0) + 1 (NOT (s | 0) || 1) so seeds 0 and 1
  // do NOT alias to the same starting state — Socrates v1 m3.
  function lcg(s: number): () => number {
    let x = ((s | 0) + 1) | 0;
    return () => {
      x = (x * 1664525 + 1013904223) | 0;
      return ((x >>> 0) % 1000) / 1000;
    };
  }

  const rows = $derived.by(() => {
    const rng = lcg(seed);
    const safeWidth = Math.max(0, width | 0);
    const out: string[] = [];
    for (let i = 0; i < lines; i++) {
      // 1–2 small gaps per line, otherwise solid ░. For widths < ~9
      // the (width - 8) factor goes negative; clamp gapAt to a
      // non-negative cell index AND cap gapLen so the trailing
      // segment can never overshoot the line width. Without these
      // clamps `String.prototype.repeat` throws RangeError on
      // narrow widths.
      const rawGapAt = Math.floor(rng() * (safeWidth - 8)) + 4;
      const gapAt = Math.max(0, Math.min(safeWidth, rawGapAt));
      const rawGapLen = 1 + Math.floor(rng() * 2);
      const gapLen = Math.max(0, Math.min(safeWidth - gapAt, rawGapLen));
      const before = "░".repeat(gapAt);
      const gap = " ".repeat(gapLen);
      const after = "░".repeat(Math.max(0, safeWidth - gapAt - gapLen));
      out.push(before + gap + after);
    }
    return out;
  });
</script>

<pre class="vc-ascii-skel" aria-hidden="true">{rows.join("\n")}</pre>

<style>
  .vc-ascii-skel {
    margin: 0;
    font-family: var(--vc-font-mono);
    color: var(--color-text-muted);
    line-height: 1.3;
    white-space: pre;
  }
</style>
